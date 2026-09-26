"""The passkey door for the tailnet (ADR 0009): one registered passkey or more, a session
cookie minted by a WebAuthn assertion, and the enrollment token that lets the first passkey
in. The ceremonies themselves are verified in `passkey.py`; this file is the state around
them and the routes that drive it.

Sessions and credentials are two JSON files under `~/.helm/dashboard-auth/`, gitignored, which is where
everything that changes because something ran already lives. A challenge lives only in this
process for five minutes, so a restart between the options call and the verify call is a
retry, never a hole.

Enrollment never happens from the page on its own. `python3 dashboard/serve.py --enroll`
writes a one shot token to `~/.helm/dashboard-auth/enroll` and prints the link that carries it; the
register routes read that file, and a successful registration deletes it. Someone on the
tailnet with no token cannot add a passkey, and the file cannot be minted from the network.
"""
from __future__ import annotations

import json
import re
import secrets
import sys
import threading
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "runner" / "producers")]

import common  # noqa: E402
import passkey  # noqa: E402
from app import ApiError, Request, Response, Route, Tailnet, json_response  # noqa: E402

AUTH_DIR = common.STATE / "dashboard-auth"
CREDENTIALS = AUTH_DIR / "credentials.json"
SESSIONS = AUTH_DIR / "sessions.json"
ENROLL = AUTH_DIR / "enroll"

COOKIE = "otto_session"
RP_NAME = "helm"
USER_ID = b"daniel"
USER_NAME = "daniel"
CHALLENGE_TTL = timedelta(minutes=5)
ENROLL_TTL = timedelta(minutes=10)
SESSION_TTL = timedelta(days=30)

LOCK = threading.Lock()


@dataclass(frozen=True)
class Origin:
    """The tailnet name the page is served under. The relying party id is the bare host, so
    a passkey survives the port changing; the origin the browser signs over carries it.
    `local_port` is the loopback port the tailnet listener binds, the one `tailscale serve`
    is pointed at and nothing else dials."""
    host: str
    port: int
    local_port: int = 8644

    @property
    def rp_id(self) -> str:
        return self.host

    @property
    def url(self) -> str:
        return f"https://{self.host}:{self.port}" if self.port != 443 else f"https://{self.host}"

    @property
    def host_header(self) -> str:
        return f"{self.host}:{self.port}" if self.port != 443 else self.host


def now() -> datetime:
    return datetime.now(timezone.utc)


def stamp(at: datetime) -> str:
    return at.isoformat(timespec="seconds").replace("+00:00", "Z")


def read(path: Path) -> dict:
    try:
        loaded = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def write(path: Path, payload: dict) -> None:
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    common.write_json(path, payload)
    path.chmod(0o600)


def credential_to_json(cred: passkey.Credential) -> dict:
    return {
        "id": passkey.b64url_encode(cred.id),
        "public_key": passkey.b64url_encode(cred.public_key),
        "sign_count": cred.sign_count,
        "transports": list(cred.transports),
        "label": cred.label,
        "created_at": cred.created_at,
    }


def credential_from_json(row: dict) -> passkey.Credential:
    return passkey.Credential(
        id=passkey.b64url_decode(row["id"]),
        public_key=passkey.b64url_decode(row["public_key"]),
        sign_count=int(row["sign_count"]),
        transports=tuple(row.get("transports") or ()),
        label=str(row.get("label") or ""),
        created_at=str(row.get("created_at") or ""),
    )


def credentials() -> list[passkey.Credential]:
    return [credential_from_json(row) for row in read(CREDENTIALS).get("credentials", [])]


def save_credentials(creds: list[passkey.Credential]) -> None:
    write(CREDENTIALS, {"credentials": [credential_to_json(c) for c in creds]})


# Challenge id to (challenge bytes, expiry). Bounded by the TTL: every call sweeps the dead
# ones, so a stranger on the tailnet asking for options in a loop holds five minutes' worth.
CHALLENGES: dict[str, tuple[bytes, datetime]] = {}


def new_challenge() -> tuple[str, bytes]:
    at = now()
    with LOCK:
        for key in [k for k, (_, until) in CHALLENGES.items() if until < at]:
            del CHALLENGES[key]
        cid = secrets.token_urlsafe(16)
        challenge = secrets.token_bytes(32)
        CHALLENGES[cid] = (challenge, at + CHALLENGE_TTL)
    return cid, challenge


def take_challenge(cid: object) -> bytes:
    """One use. A challenge that has been answered, well or badly, is gone."""
    with LOCK:
        found = CHALLENGES.pop(cid, None) if isinstance(cid, str) else None
    if found is None or found[1] < now():
        raise ApiError(400, "bad_request", "that challenge is unknown or expired; ask for options again")
    return found[0]


def sessions() -> dict[str, str]:
    """Token to expiry, live ones only."""
    at = stamp(now())
    return {token: until for token, until in read(SESSIONS).items() if isinstance(until, str) and until > at}


def mint_session() -> str:
    token = secrets.token_hex(32)
    with LOCK:
        live = sessions()
        live[token] = stamp(now() + SESSION_TTL)
        write(SESSIONS, live)
    return token


def forget_session(token: str | None) -> None:
    with LOCK:
        live = sessions()
        if token in live:
            del live[token]
            write(SESSIONS, live)


def cookie_token(request: Request) -> str | None:
    for part in (request.header("cookie") or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE and value:
            return value
    return None


def session_ok(request: Request) -> bool:
    """The gate `app.authorize` asks on every tailnet request to a tailnet row."""
    token = cookie_token(request)
    return token is not None and token in sessions()


def set_cookie(token: str) -> dict[str, str]:
    return {"Set-Cookie": f"{COOKIE}={token}; Path=/; HttpOnly; Secure; SameSite=Strict; "
                          f"Max-Age={int(SESSION_TTL.total_seconds())}"}


def clear_cookie() -> dict[str, str]:
    return {"Set-Cookie": f"{COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"}


def write_enroll_token() -> str:
    """Called by `serve.py --enroll`, in another process from the server. The file is the
    handoff, and its mtime plus the TTL is its expiry."""
    token = secrets.token_urlsafe(24)
    AUTH_DIR.mkdir(parents=True, exist_ok=True)
    ENROLL.write_text(token + "\n")
    ENROLL.chmod(0o600)
    return token


def check_enroll_token(given: object) -> None:
    try:
        wanted = ENROLL.read_text().strip()
        age = now() - datetime.fromtimestamp(ENROLL.stat().st_mtime, timezone.utc)
    except OSError:
        raise ApiError(403, "forbidden", "no enrollment is open; run python3 dashboard/serve.py --enroll")
    if age > ENROLL_TTL:
        raise ApiError(403, "forbidden", "that enrollment link has expired; run python3 dashboard/serve.py --enroll again")
    if not isinstance(given, str) or not secrets.compare_digest(given, wanted):
        raise ApiError(403, "forbidden", "that enrollment token is not the one on file")


def body_of(request: Request) -> dict:
    try:
        payload = json.loads(request.body or b"")
    except ValueError as e:
        raise ApiError(400, "bad_request", f"the body is not JSON: {e}")
    if not isinstance(payload, dict):
        raise ApiError(400, "bad_request", "the body must be a JSON object")
    return payload


def credential_of(payload: dict) -> dict:
    cred = payload.get("credential")
    if not isinstance(cred, dict):
        raise ApiError(400, "bad_request", 'the body must carry a "credential" object from the browser')
    return cred


LABEL = re.compile(r"^[\w .-]{1,40}$")


def label_of(payload: dict) -> str:
    label = payload.get("label", "passkey")
    if not isinstance(label, str) or not LABEL.match(label):
        raise ApiError(400, "bad_request", "the label is up to 40 letters, digits, spaces, dots or dashes")
    return label


def routes(origin: Origin) -> tuple[Route, ...]:
    """The six auth rows, closed over the origin they verify against. All `open`: a phone with
    no session yet has to reach them, and the register pair carries its own gate, the token."""

    def register_options(request: Request, m: "re.Match[str]") -> Response:
        payload = body_of(request)
        check_enroll_token(payload.get("token"))
        cid, challenge = new_challenge()
        options = passkey.registration_options(rp_id=origin.rp_id, rp_name=RP_NAME, user_id=USER_ID,
                                               user_name=USER_NAME, challenge=challenge)
        options["excludeCredentials"] = [{"type": "public-key", "id": passkey.b64url_encode(c.id)}
                                        for c in credentials()]
        return json_response({"challengeId": cid, "options": options})

    def register_verify(request: Request, m: "re.Match[str]") -> Response:
        payload = body_of(request)
        check_enroll_token(payload.get("token"))
        challenge = take_challenge(payload.get("challengeId"))
        try:
            cred = passkey.finish_registration(credential_of(payload), expected_challenge=challenge,
                                               rp_id=origin.rp_id, origin=origin.url,
                                               label=label_of(payload), now=stamp(now()))
        except passkey.PasskeyError as e:
            raise ApiError(400, "bad_request", str(e))
        with LOCK:
            creds = [c for c in credentials() if c.id != cred.id]
            save_credentials([*creds, cred])
            ENROLL.unlink(missing_ok=True)
        return json_response({"label": cred.label, "credentials": len(creds) + 1}, headers=set_cookie(mint_session()))

    def login_options(request: Request, m: "re.Match[str]") -> Response:
        cid, challenge = new_challenge()
        options = passkey.authentication_options(rp_id=origin.rp_id, challenge=challenge,
                                                 allow=[c.id for c in credentials()])
        return json_response({"challengeId": cid, "options": options})

    def login_verify(request: Request, m: "re.Match[str]") -> Response:
        payload = body_of(request)
        challenge = take_challenge(payload.get("challengeId"))
        response = credential_of(payload)
        try:
            raw_id = passkey.b64url_decode(response.get("rawId") or response.get("id") or "")
        except (ValueError, TypeError):
            raise ApiError(400, "bad_request", "the credential id is not base64url")
        with LOCK:
            creds = credentials()
            match = next((c for c in creds if c.id == raw_id), None)
            if match is None:
                raise ApiError(401, "unauthorized", "that passkey is not registered here")
            try:
                count = passkey.finish_authentication(response, match, expected_challenge=challenge,
                                                      rp_id=origin.rp_id, origin=origin.url)
            except passkey.PasskeyError as e:
                raise ApiError(401, "unauthorized", str(e))
            save_credentials([replace(c, sign_count=count) if c.id == raw_id else c for c in creds])
        return json_response({"label": match.label}, headers=set_cookie(mint_session()))

    def logout(request: Request, m: "re.Match[str]") -> Response:
        forget_session(cookie_token(request))
        return json_response({"ok": True}, headers=clear_cookie())

    def me(request: Request, m: "re.Match[str]") -> Response:
        """Whether this request would pass a tailnet row. Loopback always does. The page asks
        this once at load and shows the sign in screen on a no, instead of learning it from
        the first 401 on a read it then has to redo."""
        ok = request.via == "loopback" or session_ok(request)
        return json_response({"via": request.via, "authenticated": ok, "enrolled": bool(credentials())})

    return (
        Route("POST", re.compile(r"^/auth/register/options$"), "open", register_options),
        Route("POST", re.compile(r"^/auth/register/verify$"), "open", register_verify),
        Route("POST", re.compile(r"^/auth/login/options$"), "open", login_options),
        Route("POST", re.compile(r"^/auth/login/verify$"), "open", login_verify),
        Route("POST", re.compile(r"^/auth/logout$"), "open", logout),
        Route("GET", re.compile(r"^/auth/me$"), "open", me),
    )


def tailnet_for(origin: Origin) -> Tailnet:
    return Tailnet(host=origin.host_header.lower(), session_ok=session_ok)


def origin_from_env(env: dict[str, str]) -> Origin | None:
    """`HELM_HOSTNAME` names the tailnet door; with it unset the dashboard is loopback only,
    exactly as before, and none of this file is reached. `HELM_TAILNET_PORT` is the HTTPS
    port on the tailnet; `HELM_TAILNET_LOCAL_PORT` is the loopback port behind it."""
    host = env.get("HELM_HOSTNAME", "").strip().lower()
    if not host:
        return None
    return Origin(host=host, port=int(env.get("HELM_TAILNET_PORT") or 8643),
                  local_port=int(env.get("HELM_TAILNET_LOCAL_PORT") or 8644))
