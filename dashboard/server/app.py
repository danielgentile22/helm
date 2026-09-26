"""The dashboard's HTTP layer: request and response types, the route table's shape, and dispatch.

Python standard library only, in process with the producers (ADR 0021), so the one write
reaches `todo_edit.set_done` as a function call with a typed error rather than a subprocess
with an argv boundary around a client supplied id.

Every route is a row in a table with a typed reach, and `authorize` is the first statement of
`dispatch`. The handlers and the table itself live in `routes.py`.
"""
from __future__ import annotations

import json
import re
import sys
import traceback
from dataclasses import dataclass, field, replace
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterator, Literal, Mapping
from urllib.parse import unquote, urlsplit

MAX_BODY = 64 * 1024

# open: anything that reaches the socket by one of this server's own names, no session needed.
# Static assets and the passkey ceremony itself, since a phone with no session yet still has
# to load the page and sign in. tailnet: the same, and over the tailnet a session cookie as
# well. loopback: only a peer on this machine that dialled a loopback name, ever.
Reach = Literal["open", "tailnet", "loopback"]
Via = Literal["loopback", "tailnet"]

STRICTNESS: dict[Reach, int] = {"open": 0, "tailnet": 1, "loopback": 2}


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    headers: Mapping[str, str]
    body: bytes
    peer: str
    port: int
    # Raw, not decoded: `parse_qs` does the decoding, and decoding twice turns an encoded
    # `&` inside a value into a second parameter.
    query: str = ""
    # The listener the request arrived on. A fact of the socket, stamped by the handler
    # before any header is read, so no client can choose its own door.
    door: "Via" = "loopback"
    # Which door `authorize` admitted the request through. Equal to `door` once admitted.
    via: "Via" = "loopback"

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    headers: dict[str, str] = field(default_factory=dict)
    # A body handed over in pieces instead of all at once, for a response whose point is that
    # the client can start on the first piece. `body` stays empty when this is set.
    stream: Iterator[bytes] | None = None


class ApiError(Exception):
    """One error shape on the wire: `{"error": {"code", "detail"}}` (ADR 0021)."""

    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(f"{status} {code}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail

    def response(self) -> Response:
        return json_response({"error": {"code": self.code, "detail": self.detail}}, self.status)


Handler = Callable[[Request, "re.Match[str]"], Response]


@dataclass(frozen=True)
class Route:
    method: str
    pattern: "re.Pattern[str]"
    reach: Reach
    handler: Handler
    max_body: int = MAX_BODY


def json_response(payload: object, status: int = 200, headers: dict[str, str] | None = None) -> Response:
    body = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    out = {"Content-Type": "application/json", "Cache-Control": "no-store"}
    out.update(headers or {})
    return Response(status, body, out)


def text_response(text: str, status: int = 200) -> Response:
    return Response(status, text.encode("utf-8"),
                    {"Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store"})


def is_loopback(peer: str) -> bool:
    return peer.startswith("127.") or peer in ("::1", "::ffff:127.0.0.1")


LOOPBACK_NAMES = frozenset({"127.0.0.1", "localhost", "[::1]"})
HOST_HEADER = re.compile(r"^(?P<name>\[[0-9a-fA-F:]+\]|[^:]+)(?::(?P<port>\d+))?$")


def host_is_ours(host: str | None, port: int) -> bool:
    """One of this server's own loopback names, bare or with the port it is bound to.

    The peer address alone does not say who the client thinks it is talking to. A page on
    any site can point a hostname it controls at 127.0.0.1, and the browser then treats the
    dashboard as that site's own origin: loopback peer, same origin, and `/api/agenda` is
    readable. The Host header is the one part of the request that carries the name the page
    used, so the names are an allowlist and anything else is refused.
    """
    m = HOST_HEADER.match(host or "")
    if m is None or m.group("name").lower() not in LOOPBACK_NAMES:
        return False
    given = m.group("port")
    return given is None or int(given) == port


@dataclass(frozen=True)
class Tailnet:
    """The one other name this server answers to. `tailscale serve` terminates TLS on the
    tailnet and proxies here from 127.0.0.1 to a second loopback listener of its own, so a
    tailnet request is known by the socket it arrived on and its Host must be this name and
    port. `session_ok` is the passkey gate, asked once per tailnet request on a tailnet row;
    the ceremony that mints a session lives in `auth.py`."""
    host: str
    session_ok: Callable[[Request], bool]


def via(request: Request, tailnet: Tailnet | None) -> Via:
    """The door the request came through, or a refusal.

    The door is the listener, never a header: the tailnet listener stamps every request
    tailnet before a byte of it is read, so a tailnet node that sends `Host: localhost` is
    still a tailnet request. The peer must be loopback either way, since both sockets bind
    there and `tailscale serve` proxies from there. The Host header is then an allowlist on
    each door: a page on any site can point a hostname it controls at 127.0.0.1, and the
    browser then treats the dashboard as that site's own origin, so anything but this
    server's own names for that door is refused."""
    if not is_loopback(request.peer):
        raise ApiError(403, "forbidden", f"{request.peer} is not loopback, and this socket is only reached from here")
    host = request.header("host")
    if request.door == "tailnet":
        if tailnet is not None and (host or "").lower() == tailnet.host:
            return "tailnet"
        raise ApiError(403, "forbidden", f"Host {host!r} is not the tailnet name this door answers to"
                                         + (f"; want {tailnet.host}" if tailnet is not None else ""))
    if host_is_ours(host, request.port):
        return "loopback"
    raise ApiError(403, "forbidden", f"Host {host!r} is not a name this door answers to; "
                                     f"want 127.0.0.1, localhost or [::1], bare or on port {request.port}")


def origin_is_ours(origin: str, request: Request, tailnet: Tailnet | None) -> bool:
    """Whether an Origin header names this server on the door the request came through."""
    parts = urlsplit(origin)
    if request.door == "tailnet":
        return tailnet is not None and parts.netloc.lower() == tailnet.host
    return host_is_ours(parts.netloc, request.port)


def refuse_cross_site(request: Request, tailnet: Tailnet | None) -> None:
    """A write from a page on another site is refused, whatever cookie it carries.

    Browsers attach Origin to every cross-site POST, and `Sec-Fetch-Site: cross-site` beside
    it, so a page open in the desktop browser cannot post a clip to the talk route or cancel
    a turn on the loopback door, where no session is asked. The dashboard's own page sends
    its own origin, which is one of this server's names, and passes. GET and HEAD are left
    alone: reads are already same-origin by the browser's own rules."""
    if request.method in ("GET", "HEAD"):
        return
    origin = request.header("origin")
    if origin is not None and not origin_is_ours(origin, request, tailnet):
        reason = f"from origin {origin!r}"
    elif (request.header("sec-fetch-site") or "").lower() == "cross-site":
        reason = "marked cross-site by the browser"
    else:
        return
    raise ApiError(403, "forbidden", f"a {request.method} {reason} is refused; "
                                     "writes are only taken from this dashboard's own page")


def authorize(request: Request, reach: Reach, tailnet: Tailnet | None) -> Via:
    """The one gate, first statement of `dispatch`, so a route written today is already
    behind it (ADR 0016). A `loopback` row never graduates, whatever is turned on around it:
    this function keeps refusing the tailnet door for those rows. A `tailnet` row over the
    tailnet needs a session the passkey ceremony minted; over loopback it needs nothing, the
    desktop is the machine the files are on. A write from another site is refused on either
    door before any of that."""
    came = via(request, tailnet)
    refuse_cross_site(request, tailnet)
    if came == "loopback":
        return came
    if reach == "loopback":
        raise ApiError(403, "forbidden", f"{request.path} is only served on this machine, never over the tailnet")
    if reach == "tailnet" and tailnet is not None and not tailnet.session_ok(request):
        raise ApiError(401, "unauthorized", "sign in with your passkey first")
    return came


def reach_of(request: Request, table: tuple[Route, ...]) -> Reach:
    """The strictest reach among every row whose path matches, method aside. Strictest rather
    than first, so adding a loopback row on a path that already carries a tailnet row cannot
    hand the loopback row the weaker check, and an unrouted path gets the strictest of all."""
    matches = [route.reach for route in table if route.pattern.match(request.path)]
    if not matches:
        return "loopback"
    return max(matches, key=STRICTNESS.__getitem__)


def body_limit(method: str, path: str, table: tuple[Route, ...]) -> int:
    """How large a body this request is allowed to carry, off the matched row's own column.

    A toggle is a few bytes of JSON and an audio clip is megabytes, so the limit is a
    property of the route rather than a size that has to suit both. The limit is asked for
    before the body is read, so an unrouted request gets the default and is refused on its
    path afterwards."""
    for route in table:
        if route.method == method and route.pattern.match(path):
            return route.max_body
    return MAX_BODY


def dispatch(request: Request, table: tuple[Route, ...], tailnet: Tailnet | None = None) -> Response:
    request = replace(request, via=authorize(request, reach_of(request, table), tailnet))
    matched_path = False
    for route in table:
        m = route.pattern.match(request.path)
        if not m:
            continue
        matched_path = True
        if route.method != request.method:
            continue
        try:
            return route.handler(request, m)
        except ApiError as e:
            return e.response()
        except Exception as e:  # noqa: BLE001  the name goes out, the traceback stays here
            traceback.print_exc(file=sys.stderr)
            return ApiError(500, "internal", type(e).__name__).response()
    if matched_path:
        return ApiError(405, "method_not_allowed", f"{request.method} is not allowed on {request.path}").response()
    return ApiError(404, "not_found", f"no route for {request.path}").response()


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "helm-dashboard"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    table: tuple[Route, ...] = ()
    tailnet: Tailnet | None = None
    port: int = 0
    door: Via = "loopback"

    def log_message(self, fmt: str, *args: object) -> None:
        """One line per API request. Static files are the page loading itself and say nothing.

        `path` is missing when the base class rejects the request line before parsing it, and
        this override runs inside that rejection."""
        if getattr(self, "path", "").startswith("/api/"):
            sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    def handle_one(self) -> None:
        # The path is parsed first because the size a body may be is the matched row's, and
        # the refusal has to happen before the bytes are read.
        split = urlsplit(self.path)
        path = unquote(split.path)
        body = self.read_body(body_limit(self.command, path, self.table))
        if body is None:
            return
        request = Request(
            method=self.command,
            path=path,
            headers={k.lower(): v for k, v in self.headers.items()},
            body=body,
            peer=self.client_address[0],
            port=self.port,
            query=split.query,
            door=self.door,
        )
        try:
            response = dispatch(request, self.table, self.tailnet)
        except ApiError as e:
            response = e.response()
        self.write(response)

    def __getattr__(self, name: str) -> object:
        """Any method the base class has no `do_` for, routed to dispatch. Without this the
        stdlib answers HEAD, OPTIONS and DELETE with an HTML 501, which is the one response
        on this server outside the single error shape."""
        if name.startswith("do_"):
            return self.handle_one
        raise AttributeError(name)

    def read_body(self, limit: int) -> bytes | None:
        """The body, or None when the request was already refused. Every refusal here closes the
        connection: the bytes were never read, so keep-alive would parse them as the next
        request line."""
        raw = self.headers.get("Content-Length") or "0"
        if self.headers.get("Transfer-Encoding"):
            return self.refuse(ApiError(411, "length_required", "send a Content-Length, chunked is not read here"))
        if not raw.isdigit():
            return self.refuse(ApiError(400, "bad_request", f"Content-Length {raw!r} is not a count of bytes"))
        length = int(raw)
        if length > limit:
            return self.refuse(ApiError(413, "too_large", f"a body over {limit} bytes is refused here"))
        return self.rfile.read(length) if length else b""

    def refuse(self, error: ApiError) -> None:
        self.close_connection = True
        self.write(error.response())
        return None

    def write(self, response: Response) -> None:
        # The client takes its clock skew from Date, so every response carries one (ADR 0021).
        response.headers.setdefault("Date", formatdate(usegmt=True))
        if response.stream is not None:
            response.headers["Transfer-Encoding"] = "chunked"
        elif response.status not in (204, 304):
            response.headers["Content-Length"] = str(len(response.body))
        self.send_response_only(response.status)
        self.log_request(response.status, len(response.body))
        for name, value in response.headers.items():
            self.send_header(name, value)
        self.end_headers()
        if response.stream is None:
            # A HEAD response carries the headers of the GET and none of its body, so the bytes
            # are counted in Content-Length and never written.
            if self.command != "HEAD":
                self.wfile.write(response.body)
            return
        try:
            if self.command != "HEAD":
                for chunk in response.stream:
                    if chunk:
                        self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.write(b"0\r\n\r\n")
        finally:
            # A client that hangs up mid playback leaves this loop through a broken pipe, and
            # the upstream connection the generator holds is only released by closing it.
            closer = getattr(response.stream, "close", None)
            if closer is not None:
                closer()

    do_GET = handle_one
    do_PUT = handle_one
    do_POST = handle_one


class DashboardServer(ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        """A client that hangs up mid response is normal, and refusing an oversize body without
        reading it makes it routine: the unread bytes come back as a reset. Anything else keeps
        its traceback."""
        kind = sys.exc_info()[0]
        if kind is not None and issubclass(kind, (BrokenPipeError, ConnectionResetError)):
            return
        traceback.print_exc(file=sys.stderr)


def make_server(host: str, port: int, table: tuple[Route, ...], tailnet: Tailnet | None = None,
                door: Via = "loopback") -> DashboardServer:
    """One listener. The handler carries the route table, the tailnet gate if there is one,
    the door this listener is, and the port it is actually bound to, so `authorize` can check
    the Host header without reaching for a module global. Port 0 means the kernel picks,
    which is why the number comes off the socket rather than the argument.

    With a tailnet name configured the process runs two of these: the loopback door on the
    dashboard port, and the tailnet door on the port `tailscale serve` is pointed at."""
    class BoundHandler(DashboardHandler):
        pass

    BoundHandler.table = table
    BoundHandler.tailnet = tailnet
    BoundHandler.door = door
    server = DashboardServer((host, port), BoundHandler)
    BoundHandler.port = server.server_address[1]
    return server
