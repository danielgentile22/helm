"""Every route the dashboard answers, one row each, with the handler beside it.

What is left is the health read, the page itself, and the passkey rows from `auth.py`. The
interface that read the agenda and wrote todos is gone; its routes are in git history.
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE.parents[1] / "runner"
sys.path[:0] = [str(HERE), str(RUNNER), str(RUNNER / "producers")]

import common  # noqa: E402
import launchd  # noqa: E402
import auth  # noqa: E402
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
    Route("GET", re.compile(r"^/api/health$"), "tailnet", health),
    # The page and its assets are open: a phone with no session yet has to load the shell to
    # sign in. Everything the page then reads sits behind the gate.
    Route("GET", re.compile(r"^/(?!api/|auth/).*$"), "open", static),
)


def table(origin: "auth.Origin | None") -> tuple[Route, ...]:
    """The full table: the rows above plus the passkey rows when a tailnet name is configured.
    With no name there is no door, so the ceremony has no reason to exist and no origin to
    verify against. The page still asks `/auth/me` before it draws anything, so that one
    row stays and says what is true without a door: every visitor is on loopback, and in."""
    if origin is None:
        return ROUTES + (Route("GET", re.compile(r"^/auth/me$"), "open", loopback_me),)
    return ROUTES + auth.routes(origin)


def loopback_me(request: Request, m: "re.Match[str]") -> Response:
    return json_response({"via": "loopback", "authenticated": True, "enrolled": False})
