"""Every route the dashboard answers, one row each, with the handler beside it.

Four reads and three writes (ADR 0014). The reads hand back files that exist whether or not
the dashboard is running (ADR 0008). One write flips a checkbox and one rewrites a todo's
text, date or directive, both on a line the client already read and addressed by content id.
The third adds a todo to a department note named by its department. No path crosses the wire.

The five voice rows are a different kind of thing: three proxy the local voice process and
two carry one spoken turn. Their handlers live in `voice.py` and the turn store is
`turns.py`. The turns they write are under `runner/`, which is where everything that changes
because something ran already lives.
"""
from __future__ import annotations

import json
import os
import re
import sys
import traceback
from datetime import datetime, timezone
from email.utils import formatdate
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE.parents[1] / "runner"
sys.path[:0] = [str(HERE), str(RUNNER), str(RUNNER / "producers")]

import common  # noqa: E402
import launchd  # noqa: E402
import todo_edit  # noqa: E402
import auth  # noqa: E402
import turns  # noqa: E402
import voice  # noqa: E402
from app import ApiError, Request, Response, Route, json_response, text_response  # noqa: E402

DIST = common.ENGINE / "dashboard" / "dist"

# The allowlist as well as the lookup. A suffix with no row here is not served, so the
# build stamp, a source map and anything else that lands in dist/ without being asked for
# by the page are all 404. A new kind of asset adds its row and nothing else.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
}

NO_BUILD = ("the dashboard build is missing.\n"
            "run: python3 dashboard/serve.py\n")

SERVICE_LABEL = launchd.PREFIX + "dashboard"


def service_installed() -> bool:
    """Whether the launchd agent is loaded, so the interface can tell a dashboard someone
    started by hand from one the service is keeping up. Replaced in the tests, which must
    not ask the machine they happen to run on."""
    return launchd.is_loaded(SERVICE_LABEL)


def refresh_todos() -> str | None:
    """Rerun the todos source and re-merge both status files, so `agenda.json` agrees with the
    note within a second of the toggle. Returns the merged file's `produced`, which is the
    todos source's own stamp. Replaced in most tests, which have no vault to capture."""
    import capture

    return capture.refresh("todos")


def matches_etag(header: str | None, etag: str) -> bool:
    """`If-None-Match`, with the weak marker stripped and `*` honoured, per RFC 9110."""
    tags = [t.strip() for t in (header or "").split(",") if t.strip()]
    return any(t == "*" or t.removeprefix("W/") == etag for t in tags)


def status_file(request: Request, m: "re.Match[str]") -> Response:
    """The bytes of `~/.helm/status/<name>.json` verbatim. The dashboard never reformats a file
    it does not own, and the ETag is the file's identity rather than a hash of its contents.

    Capture replaces these files atomically while this runs, so the stat comes off the open
    handle: a stat and a read of the path can straddle the swap and pin one file's tag to
    another file's bytes."""
    name = m.group("name")
    path = common.STATUS / f"{name}.json"
    try:
        with path.open("rb") as fh:
            stat = os.fstat(fh.fileno())
            body = fh.read()
    except OSError as e:
        raise ApiError(503, "unavailable", f"{name}.json is not readable ({type(e).__name__}); "
                                           "run python3 runner/producers/capture.py")
    etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
    headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "ETag": etag,
        "Date": formatdate(usegmt=True),
    }
    if matches_etag(request.header("If-None-Match"), etag):
        return Response(304, b"", headers)
    return Response(200, body, headers)


def set_todo_done(request: Request, m: "re.Match[str]") -> Response:
    """A PUT of desired state, never a toggle, so a retry, a double click and a lost response all
    converge on the same answer with `changed: false`."""
    row_id = m.group("id")
    try:
        payload = json.loads(request.body or b"")
    except ValueError as e:
        raise ApiError(400, "bad_request", f"the body is not JSON: {e}")
    if not isinstance(payload, dict) or not isinstance(payload.get("done"), bool):
        raise ApiError(400, "bad_request", 'the body must be {"done": true} or {"done": false}')
    done = payload["done"]

    with todo_edit.vault_write_lock():
        try:
            path, line, changed = todo_edit.set_done(row_id, done)
        except todo_edit.TodoEditError as e:
            raise ApiError(404, "not_found", str(e))
        sha = None
        if changed:
            try:
                sha = todo_edit.commit(path, todo_edit.message_for(path, line, done))
            except todo_edit.TodoEditError as e:
                raise ApiError(409, "conflict", f"the box is already flipped in {path.name} and the next "
                                                f"commit in the vault will carry it, but this commit failed: {e}")

    return json_response({"id": row_id, "done": done, "changed": changed,
                          "commit": sha, "line": line, "agenda_produced": remerge(changed)})


def remerge(changed: bool) -> str | None:
    """Called outside the lock. The lock covers the note write and the commit, and nothing
    else; the re-collect spawns a `git log -S` per line and runs the done-when predicates,
    which reach the network. The CLI in todo_edit.py refreshes outside the lock for the same
    reason."""
    if not changed:
        return None
    try:
        return refresh_todos()
    except Exception:  # noqa: BLE001  the commit is the truth, the merged file catches up
        # A failed re-merge must not read as a failed write: the client would undo a change
        # the vault has already committed. The answer is 200 with no stamp, and the next
        # capture puts agenda.json back in line within the half hour.
        traceback.print_exc(file=sys.stderr)
        return None


def schedule_of(when: object) -> todo_edit.Schedule:
    """`{"kind": "todo", "due": "YYYY-MM-DD" | null}`, `{"kind": "daily"}` or
    `{"kind": "event", "at": "YYYY-MM-DD HH:MM"}`. The stamps themselves are checked by
    todo_edit, which is where the note's own format lives."""
    if not isinstance(when, dict):
        raise ApiError(400, "bad_request", '"when" must be an object with a "kind"')
    kind = when.get("kind")
    if kind == "todo" and (when.get("due") is None or isinstance(when.get("due"), str)):
        return todo_edit.Schedule("todo", when.get("due") or None)
    if kind == "daily":
        return todo_edit.Schedule("daily")
    if kind == "event" and isinstance(when.get("at"), str):
        return todo_edit.Schedule("event", when["at"])
    raise ApiError(400, "bad_request", '"when" must be {"kind": "todo", "due": ...}, {"kind": "daily"} '
                                       'or {"kind": "event", "at": "YYYY-MM-DD HH:MM"}')


def edit_todo(request: Request, m: "re.Match[str]") -> Response:
    """A PATCH naming only the fields to rewrite. An absent key is left alone, and a
    `"project": null` files the todo under no directive. Sending what is already there changes
    nothing. The text is the content id, so a new text hands back a new `id` for the client
    to follow."""
    row_id = m.group("id")
    try:
        payload = json.loads(request.body or b"")
    except ValueError as e:
        raise ApiError(400, "bad_request", f"the body is not JSON: {e}")
    if not isinstance(payload, dict) or not payload.keys() <= {"text", "when", "project"}:
        raise ApiError(400, "bad_request", 'the body is an object of "text", "when" and "project"')
    text = payload.get("text")
    if text is not None and (not isinstance(text, str) or not text.strip()):
        raise ApiError(400, "bad_request", '"text" must be words')
    schedule = schedule_of(payload["when"]) if "when" in payload else None
    project = payload.get("project", todo_edit.KEEP)
    if project is not todo_edit.KEEP and project is not None and (not isinstance(project, str) or not project.strip()):
        raise ApiError(400, "bad_request", '"project" must be a directive name or null')

    with todo_edit.vault_write_lock():
        try:
            note, line, changed, new_text = todo_edit.edit(
                row_id, text, schedule, project.strip() if isinstance(project, str) else project)
        except todo_edit.UnknownTodo as e:
            raise ApiError(404, "not_found", str(e))
        except todo_edit.TodoEditError as e:
            raise ApiError(422, "refused", str(e))
        sha = None
        if changed:
            try:
                sha = todo_edit.commit(note, todo_edit.edit_message(note, new_text))
            except todo_edit.TodoEditError as e:
                raise ApiError(409, "conflict", f"the edit is written to {note.name} and the next "
                                                f"commit in the vault will carry it, but this commit failed: {e}")

    return json_response({"id": common.content_id(todo_edit.rel_for(note), new_text), "changed": changed,
                          "commit": sha, "line": line, "agenda_produced": remerge(changed)})


def add_todo(request: Request, m: "re.Match[str]") -> Response:
    """A POST of a new todo, placed by `todo_edit.add` the way the CLI places one. An absent
    `when` is an undated todo and an absent `project` files it under no directive. Not
    idempotent on purpose: the same text twice is the note's duplicate refusal, a 422 whose
    detail says which line already holds it."""
    try:
        payload = json.loads(request.body or b"")
    except ValueError as e:
        raise ApiError(400, "bad_request", f"the body is not JSON: {e}")
    if not isinstance(payload, dict) or not payload.keys() <= {"text", "dept", "project", "when"}:
        raise ApiError(400, "bad_request", 'the body is an object of "text", "dept", "project" and "when"')
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ApiError(400, "bad_request", '"text" must be words')
    dept = payload.get("dept")
    if dept not in common.DEPARTMENTS:
        raise ApiError(400, "bad_request", f'"dept" must be one of {", ".join(common.DEPARTMENTS)}')
    project = payload.get("project")
    if project is not None and (not isinstance(project, str) or not project.strip()):
        raise ApiError(400, "bad_request", '"project" must be a directive name or null')
    # A null `when` is read as an absent one, so a client that always sends the key can still
    # add an undated todo.
    schedule = schedule_of(payload["when"]) if payload.get("when") is not None else todo_edit.Schedule()

    with todo_edit.vault_write_lock():
        try:
            note, line = todo_edit.add(
                dept, text, schedule.value if schedule.kind == "todo" else None, None,
                project.strip() if project else None, schedule.kind == "daily",
                schedule.value if schedule.kind == "event" else None)
        except todo_edit.TodoEditError as e:
            raise ApiError(422, "refused", str(e))
        new_text = todo_edit.box_text(line)
        try:
            sha = todo_edit.commit(note, f"Add a {dept} todo: {new_text}")
        except todo_edit.TodoEditError as e:
            raise ApiError(409, "conflict", f"the todo is written to {note.name} and the next "
                                            f"commit in the vault will carry it, but this commit failed: {e}")

    return json_response({"id": common.content_id(todo_edit.rel_for(note), new_text), "changed": True,
                          "commit": sha, "line": line, "agenda_produced": remerge(True)})


def health(request: Request, m: "re.Match[str]") -> Response:
    built = DIST / ".built"
    return json_response({
        "ok": True,
        "now": common.iso(common.utc_now()),
        "reach": request.via,
        "dist_built": common.iso(datetime.fromtimestamp(built.stat().st_mtime, timezone.utc))
        if built.exists() else None,
        "service": {"label": SERVICE_LABEL, "installed": service_installed()},
    })


def static(request: Request, m: "re.Match[str]") -> Response:
    """`dist/`, with `index.html` for any path without a dot so a reload on a client route works.

    Only the suffixes in `CONTENT_TYPES` are served. `dist/` also holds the `.built` stamp,
    and a future build may drop a source map in there, neither of which the page asks for."""
    if not DIST.is_dir():
        return text_response(NO_BUILD, 503)
    rel = request.path.lstrip("/")
    if any(ch < " " or ch == "\x7f" for ch in rel):
        raise ApiError(400, "bad_request", "that path carries a control character")
    if not rel or "." not in rel.rsplit("/", 1)[-1]:
        rel = "index.html"
    root = DIST.resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        raise ApiError(403, "forbidden", "that path leaves the build directory")
    content_type = CONTENT_TYPES.get(target.suffix)
    if content_type is None:
        raise ApiError(404, "not_found", f"{rel} is not a kind of file this server hands out; "
                                         "add its suffix to CONTENT_TYPES if the page needs it")
    if not target.is_file():
        if rel == "index.html":
            return text_response(NO_BUILD, 503)
        raise ApiError(404, "not_found", f"no file at {rel}")
    return Response(200, target.read_bytes(), {"Content-Type": content_type, "Cache-Control": "no-cache"})


ROUTES: tuple[Route, ...] = (
    Route("GET", re.compile(r"^/api/(?P<name>agenda|projects)$"), "tailnet", status_file),
    Route("PUT", re.compile(r"^/api/todos/(?P<id>[0-9a-f]{12})/done$"), "tailnet", set_todo_done),
    Route("PATCH", re.compile(r"^/api/todos/(?P<id>[0-9a-f]{12})$"), "tailnet", edit_todo),
    Route("POST", re.compile(r"^/api/todos$"), "tailnet", add_todo),
    Route("GET", re.compile(r"^/api/health$"), "tailnet", health),
    # The page and its assets are open: a phone with no session yet has to load the shell to
    # sign in. Everything the page then reads sits behind the gate.
    Route("GET", re.compile(r"^/(?!api/|auth/).*$"), "open", static),
    # Push to talk. The clip is recorded by the browser and the reply is played by it, so
    # neither is one machine's hardware; the phone holding the microphone is the point.
    # The run behind a turn is one fixed skill on a transcript, not a shell (ADR 0018).
    Route("POST", re.compile(r"^/api/talk$"), "tailnet", voice.talk, voice.MAX_STT_BYTES),
    Route("GET", re.compile(r"^/api/speak$"), "tailnet", voice.speak),
    Route("GET", re.compile(r"^/api/voice/health$"), "tailnet", voice.voice_health),
    Route("GET", re.compile(rf"^/api/turns/(?P<id>{turns.ID_PATTERN})$"), "tailnet", voice.turn_record),
    Route("POST", re.compile(rf"^/api/turns/(?P<id>{turns.ID_PATTERN})/cancel$"), "tailnet", voice.cancel_turn),
)


def table(origin: "auth.Origin | None") -> tuple[Route, ...]:
    """The full table: the rows above plus the passkey rows when a tailnet name is configured.
    With no name there is no door, so the ceremony has no reason to exist and no origin to
    verify against."""
    if origin is None:
        return ROUTES
    return ROUTES + auth.routes(origin)
