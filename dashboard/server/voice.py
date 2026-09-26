"""The routes that put the local voice process behind the dashboard's own origin, and the
two that carry one spoken sentence through to the todo helm wrote.

The voice process holds the warm speech models and answers on its own port. The browser
cannot reach it: it is a different origin with no CORS headers, and the microphone needs a
secure context, which the dashboard's own origin already is. So the dashboard proxies it.

`/api/talk` answers the moment the transcript exists, with an id and the ack to speak, and
the run goes on behind it (`turns.py`). A spoken sentence takes half a minute to land in the
vault and nobody is going to hold the browser open on a request for that long, so the client
polls `GET /api/turns/<id>` and Escape reaches `POST /api/turns/<id>/cancel`. One turn at a
time: the busy refusal happens before the clip is forwarded, so a second sentence does not
even cost a transcription.

`/api/speak` is handed on chunk by chunk rather than collected first. The voice process
generates a sentence at a time on purpose, so buffering here would throw away the only
thing that makes a spoken reply feel immediate.
"""
from __future__ import annotations

import http.client
import json
import os
import re
from typing import Iterator
from urllib.parse import parse_qs, quote, urlsplit

import turns
from app import ApiError, Request, Response, json_response

# The one place the voice process's address is written. Everything else asks this name at
# call time, which is also how the tests point the routes at a fake.
VOICE_URL = os.environ.get("HELM_VOICE_URL", "http://127.0.0.1:3108")

# The same cap the voice process puts on a clip. Refusing at this end means an oversize
# clip is never read off the socket, let alone forwarded.
MAX_STT_BYTES = 8 * 1024 * 1024

# Long enough for a cold model to answer, short enough that a wedged process does not hold
# a dashboard thread forever.
TIMEOUT = 120

START_IT = "start it with: voice/.venv/bin/python voice/server.py"

CHUNK = 64 * 1024


def upstream(method: str, path: str, body: bytes | None = None,
             headers: dict[str, str] | None = None
             ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    """A request to the voice process, translated once into this server's one error shape.

    Two failures, and they mean different things to Daniel. Nothing listening on the port is
    a process he has not started, so it is 503 and the command to start it. An answer that is
    not 200 is a process that is running and unhappy, so it is 502 and the status it gave.
    Past this function a handler holds a 200 and has nothing left to check.

    The caller closes the connection. The status and the headers are read here, so a route
    that goes on to stream has already decided its own status before a byte goes out.
    """
    parts = urlsplit(VOICE_URL)
    conn = http.client.HTTPConnection(parts.hostname or "", parts.port or 80, timeout=TIMEOUT)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
    except (OSError, http.client.HTTPException) as e:
        # A refused connection and a timeout are both OSError, and a half dead process that
        # answers something unparsable is HTTPException. None of them is an answer.
        conn.close()
        raise ApiError(503, "voice_offline",
                       f"the voice process did not answer ({type(e).__name__}); {START_IT}")
    if response.status != 200:
        detail = response.read(200).decode("utf-8", "replace").strip()
        conn.close()
        raise ApiError(502, "voice_failed",
                       f"the voice process answered {response.status} on {path.split('?')[0]}"
                       + (f": {detail}" if detail else ""))
    return conn, response


def read_json(conn: http.client.HTTPConnection, response: http.client.HTTPResponse) -> dict:
    try:
        payload = json.loads(response.read())
    except ValueError as e:
        raise ApiError(502, "voice_failed", f"the voice process answered something that is not JSON: {e}")
    finally:
        conn.close()
    if not isinstance(payload, dict):
        raise ApiError(502, "voice_failed", f"the voice process answered a {type(payload).__name__}, not an object")
    return payload


def body_of(conn: http.client.HTTPConnection, response: http.client.HTTPResponse) -> Iterator[bytes]:
    """The upstream body in whatever pieces it arrives in. `read1` rather than `read`, because
    `read` waits for its full count and that wait is exactly the delay this route exists to
    avoid."""
    try:
        while True:
            chunk = response.read1(CHUNK)
            if not chunk:
                return
            yield chunk
    finally:
        conn.close()


def talk(request: Request, m: "re.Match[str]") -> Response:
    """The clip in, the turn id out. The run starts here and the client follows it by id.

    Only audio is taken. A cross-site form post can carry text, and the recorder on the page
    always names its codec, so anything else is refused before the busy check and before
    the clip goes anywhere. The busy check is next, so a sentence spoken over a working
    turn costs nothing and the voice process never hears it."""
    content_type = request.header("content-type") or ""
    if not content_type.lower().startswith("audio/"):
        raise ApiError(415, "unsupported_media_type",
                       f"POST /api/talk takes an audio/* clip, not {content_type or 'no content type'!r}")
    if turns.busy():
        raise ApiError(409, "busy", "helm is still working on the last thing you said; "
                                    "press Escape to stop it")
    conn, response = upstream("POST", "/stt", body=request.body, headers={
        "Content-Type": content_type,
        "Content-Length": str(len(request.body)),
    })
    payload = read_json(conn, response)
    text = (payload.get("text") or "").strip()
    stt_ms = payload.get("ms")
    if not text:
        turn = turns.new_turn(text, stt_ms, phase="done")
        turn.confirmation = turns.NOT_HEARD
        turns.save(turn)
    else:
        turn = turns.new_turn(text, stt_ms)
        try:
            turns.start(turn)
        except turns.Busy as e:
            raise ApiError(409, "busy", str(e))
    return json_response({"turn": turn.id, "transcript": text, "ack": turn.ack,
                          "ms": {"stt": stt_ms}})


def turn_record(request: Request, m: "re.Match[str]") -> Response:
    """One turn as it stands. The client polls this every two seconds while a run is working,
    and a reload mid run picks the turn back up from it."""
    turn = turns.load(m.group("id"))
    if turn is None:
        raise ApiError(404, "not_found", f"no turn {m.group('id')}")
    return json_response(turn.record())


def cancel_turn(request: Request, m: "re.Match[str]") -> Response:
    """Escape while helm is working. A turn that already landed is answered as it is, so a
    second press and a lost response both converge on the same record."""
    turn = turns.cancel(m.group("id"))
    if turn is None:
        raise ApiError(404, "not_found", f"no turn {m.group('id')}")
    return json_response(turn.record())


def speak(request: Request, m: "re.Match[str]") -> Response:
    """The wav for one line of text, passed through as it is generated."""
    text = (parse_qs(request.query).get("text") or [""])[0].strip()
    if not text:
        raise ApiError(400, "bad_request", "GET /api/speak wants ?text=<the line to say>")
    conn, response = upstream("GET", "/speak?text=" + quote(text))
    return Response(200, b"", {"Content-Type": "audio/wav", "Cache-Control": "no-store"},
                    stream=body_of(conn, response))


def voice_health(request: Request, m: "re.Match[str]") -> Response:
    """Whether the voice process is up, which is the client's whole basis for showing the
    offline state. Polled every 30 seconds while the page is open, so it stays cheap."""
    conn, response = upstream("GET", "/health")
    return json_response(read_json(conn, response))
