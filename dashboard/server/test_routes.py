"""Route tests. They call `dispatch` directly, so no socket is opened and no port is claimed.

Everything the routes touch is redirected at a temp directory for the whole module, not one
class: a fake `dist/` and the service probe. WireTest serves over a real socket, so a
fixture that ended with RouteTest would have it answering from the real build.

    python3 -m unittest dashboard/server/test_routes.py
"""
from __future__ import annotations

import json
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app  # noqa: E402
import auth  # noqa: E402
import machine  # noqa: E402
import routes  # noqa: E402
import common  # noqa: E402  after routes, which puts the producers on the path
import test_passkey  # noqa: E402

PORT = 8642


def request(method: str, path: str, body: bytes = b"", peer: str = "127.0.0.1",
            headers: dict[str, str] | None = None, port: int = PORT, query: str = "",
            door: app.Via = "loopback") -> app.Request:
    sent = {"host": f"127.0.0.1:{port}"}
    sent.update(headers or {})
    return app.Request(method=method, path=path, headers=sent, body=body, peer=peer, port=port,
                       query=query, door=door)


def call(method: str, path: str, **kw) -> app.Response:
    return app.dispatch(request(method, path, **kw), routes.ROUTES)


# The fixture is the whole module's, not one class's: WireTest serves over a real socket
# and would otherwise answer from the real build.
TMP: tempfile.TemporaryDirectory
ROOT: Path
DIST: Path
SAVED: dict[tuple[object, str], object] = {}

def setUpModule() -> None:
    global TMP, ROOT, DIST
    TMP = tempfile.TemporaryDirectory()
    ROOT = Path(TMP.name).resolve()
    DIST = ROOT / "dashboard" / "dist"

    DIST.mkdir(parents=True)
    (DIST / "index.html").write_text("<!doctype html><title>helm</title>\n")
    (DIST / "icon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>\n')
    (DIST / "manifest.webmanifest").write_text('{"name": "helm", "id": "/"}\n')
    (ROOT / "secret.txt").write_text("not served\n")

    patched = {
        (routes, "DIST"): DIST,
        # Otherwise every health request shells out to launchctl and the answer depends on
        # whether the machine running the tests happens to have the agent installed.
        (routes, "service_installed"): lambda: False,
        # The tabs ask launchd and the tailnet. Neither question reaches this machine here;
        # the tab tests below hand in the answers they want.
        (machine, "launchctl_list"): lambda: {},
        (machine, "tailscale_status"): lambda: machine.Tailnet(None, "no tailnet in the tests"),
        (machine, "usage"): lambda: {"memory": None, "disk": None, "load": None, "booted": None},
        (common, "STATE"): ROOT / "state",
        (common, "STATUS"): ROOT / "state" / "status",
        (common, "VAULT"): ROOT / "vault",
    }
    SAVED.update({key: getattr(*key) for key in patched})
    for (module, name), value in patched.items():
        setattr(module, name, value)


def tearDownModule() -> None:
    for (module, name), value in SAVED.items():
        setattr(module, name, value)
    TMP.cleanup()


class RouteTest(unittest.TestCase):
    def test_health_reports_loopback_and_whether_the_service_is_installed(self) -> None:
        """The service field is how the interface tells a dashboard someone started by hand
        from one launchd is keeping up."""
        payload = json.loads(call("GET", "/api/health").body)
        self.assertEqual(payload["ok"], True)
        self.assertEqual(payload["reach"], "loopback")
        self.assertIsNone(payload["dist_built"])
        self.assertEqual(payload["service"], {"label": "com.helm.dashboard", "installed": False})

        self.addCleanup(setattr, routes, "service_installed", routes.service_installed)
        routes.service_installed = lambda: True
        installed = json.loads(call("GET", "/api/health").body)
        self.assertEqual(installed["service"], {"label": "com.helm.dashboard", "installed": True})

    def test_static_serves_index_for_a_client_route(self) -> None:
        page = call("GET", "/projects/helm")
        self.assertEqual(page.status, 200)
        self.assertEqual(page.headers["Content-Type"], "text/html; charset=utf-8")
        self.assertIn(b"<title>helm</title>", page.body)

    def test_static_serves_only_the_suffixes_it_knows(self) -> None:
        """dist/ holds more than the page asks for. The build stamp is the case that exists
        today; a source map is the one a future build would add."""
        (DIST / ".built").write_text("")
        (DIST / "assets").mkdir(exist_ok=True)
        (DIST / "assets" / "index-aaaa.js").write_text("export default 1\n")
        (DIST / "assets" / "index-aaaa.js.map").write_text('{"version":3}\n')

        self.assertEqual(call("GET", "/assets/index-aaaa.js").status, 200)
        for path in ("/.built", "/assets/index-aaaa.js.map"):
            with self.subTest(path=path):
                out = call("GET", path)
                self.assertEqual(out.status, 404)
                self.assertEqual(json.loads(out.body)["error"]["code"], "not_found")
                self.assertNotIn(b'"version"', out.body)

    def test_the_installed_app_s_own_files_are_served_with_their_content_types(self) -> None:
        """What Chrome installs sits at the root, beside the page."""
        for path, content_type in (("/icon.svg", "image/svg+xml"),
                                   ("/manifest.webmanifest", "application/manifest+json")):
            with self.subTest(path=path):
                out = call("GET", path)
                self.assertEqual(out.status, 200)
                self.assertEqual(out.headers["Content-Type"], content_type)
                self.assertEqual(out.headers["Cache-Control"], "no-cache")
                self.assertEqual(out.body, (DIST / path.lstrip("/")).read_bytes())

    def test_reach_is_the_strictest_row_and_an_unrouted_path_is_loopback(self) -> None:
        """The page and its assets are open so a phone can sign in; the health read is
        tailnet; and a path no row claims gets the strictest reach of all, so a stray file can
        never be reached from the tailnet by accident."""
        for path, reach in (("/icon.svg", "open"), ("/manifest.webmanifest", "open"), ("/", "open"),
                            ("/api/health", "tailnet"), ("/api/projects", "tailnet"),
                            ("/api/projects/keel", "tailnet"), ("/api/ideas", "tailnet"),
                            ("/api/background", "tailnet"), ("/api/devices", "tailnet"),
                            ("/api/nothing", "loopback")):
            with self.subTest(path=path):
                self.assertEqual(app.reach_of(request("GET", path), routes.ROUTES), reach)

    def test_a_client_route_is_still_the_shell_now_that_more_root_files_exist(self) -> None:
        for path in ("/", "/projects/helm", "/chess"):
            with self.subTest(path=path):
                page = call("GET", path)
                self.assertEqual(page.status, 200)
                self.assertEqual(page.headers["Content-Type"], "text/html; charset=utf-8")
                self.assertIn(b"<title>helm</title>", page.body)

    def test_static_refuses_path_traversal(self) -> None:
        for path in ("/../secret.txt", "/assets/../../secret.txt"):
            with self.subTest(path=path):
                out = call("GET", path)
                self.assertEqual(out.status, 403)
                self.assertNotIn(b"not served", out.body)

    def test_an_unknown_method_on_a_known_path_is_405(self) -> None:
        for method in ("POST", "HEAD", "OPTIONS", "DELETE"):
            with self.subTest(method=method):
                out = call(method, "/api/health")
                self.assertEqual(out.status, 405)
                self.assertEqual(json.loads(out.body)["error"]["code"], "method_not_allowed")

    def test_an_unknown_method_on_an_unknown_path_is_404(self) -> None:
        out = call("DELETE", "/api/nope")
        self.assertEqual(out.status, 404)
        self.assertEqual(json.loads(out.body)["error"]["code"], "not_found")

    def samples(self) -> list[tuple[str, str]]:
        """One request per row of the table, so a gate test covers the whole table."""
        rows = [
            ("GET", "/api/health"),
            ("GET", "/api/projects"),
            ("GET", "/api/projects/keel"),
            ("GET", "/api/ideas"),
            ("GET", "/api/background"),
            ("GET", "/api/devices"),
            ("GET", "/index.html"),
            ("GET", "/icon.svg"),
            ("GET", "/manifest.webmanifest"),
            ("POST", "/api/ideas"),
            ("POST", "/api/ideas/2026-09-26-order-the-desk-lamp/status"),
            ("POST", "/api/ideas/2026-09-26-order-the-desk-lamp/due"),
            ("POST", "/api/ideas/2026-09-26-order-the-desk-lamp/promote"),
            ("POST", "/api/ideas/2026-09-26-order-the-desk-lamp/edit"),
            ("POST", "/api/projects/refresh"),
            ("POST", "/api/routines/capture/run"),
            ("GET", "/api/alerts"),
            ("POST", "/api/alerts/routine:backup/dismiss"),
            ("GET", "/api/push/key"),
            ("POST", "/api/push/subscribe"),
            ("POST", "/api/push/unsubscribe"),
            ("POST", "/api/push/test"),
        ]
        for route in routes.ROUTES:
            hit = [p for method, p in rows if method == route.method and route.pattern.match(p)]
            self.assertTrue(hit, f"no sample exercises {route.pattern.pattern}")
        return rows

    def test_every_route_refuses_a_host_that_is_not_this_server(self) -> None:
        """A page whose hostname rebinds to 127.0.0.1 is a loopback peer and a same origin
        one, so the Host header is the only thing left that says who the client dialled."""
        for method, path in self.samples():
            with self.subTest(path=path):
                with self.assertRaises(app.ApiError) as caught:
                    call(method, path, headers={"host": "evil.example"})
                refused = caught.exception.response()
                self.assertEqual(refused.status, 403)
                detail = json.loads(refused.body)["error"]
                self.assertEqual(detail["code"], "forbidden")
                self.assertIn("evil.example", detail["detail"])

    def test_the_loopback_names_pass_and_a_stranger_or_a_wrong_port_does_not(self) -> None:
        for host in (f"localhost:{PORT}", f"127.0.0.1:{PORT}", f"[::1]:{PORT}", "localhost", "[::1]"):
            with self.subTest(host=host):
                self.assertEqual(call("GET", "/api/health", headers={"host": host}).status, 200)
        for host in ("evil.example", f"evil.example:{PORT}", "localhost:9999", "", f"localhost:{PORT}:x"):
            with self.subTest(host=host):
                with self.assertRaises(app.ApiError) as caught:
                    call("GET", "/api/health", headers={"host": host})
                self.assertEqual(caught.exception.status, 403)

    def test_every_route_refuses_a_peer_that_is_not_loopback(self) -> None:
        for method, path in self.samples():
            with self.subTest(path=path):
                with self.assertRaises(app.ApiError) as caught:
                    call(method, path, peer="100.64.1.9")
                refused = caught.exception.response()
                self.assertEqual(refused.status, 403)
                self.assertEqual(json.loads(refused.body)["error"]["code"], "forbidden")

    def test_every_write_refuses_a_foreign_origin_and_a_cross_site_fetch(self) -> None:
        """A page on another site open in the desktop browser reaches the loopback door with
        no session asked, and its POST carries its own Origin. Refused in the gate, so every
        write in the passkey ceremony is covered without knowing it."""
        table = routes.table(DOOR)
        writes = [(r.method, r.pattern.pattern.strip("^$")) for r in auth.routes(DOOR) if r.method not in ("GET", "HEAD")]
        writes += [(method, path) for method, path in self.samples() if method == "POST"]
        for method, path in writes:
            self.assertTrue(any(r.method == method and r.pattern.match(path) for r in table), path)
        for method, path in writes:
            for headers in ({"origin": "https://evil.example"},
                            {"origin": "null"},
                            {"sec-fetch-site": "cross-site"}):
                with self.subTest(path=path, headers=headers):
                    with self.assertRaises(app.ApiError) as caught:
                        app.dispatch(request(method, path, headers=headers), table)
                    self.assertEqual(caught.exception.status, 403)
                    self.assertIn("page", caught.exception.detail)

    def test_the_page_s_own_origin_passes_and_a_read_ignores_origin(self) -> None:
        table = routes.table(DOOR)
        for origin in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            with self.subTest(origin=origin):
                out = app.dispatch(request("POST", "/auth/logout",
                                           headers={"origin": origin, "sec-fetch-site": "same-origin"}), table)
                self.assertEqual(out.status, 200)
        self.assertEqual(call("GET", "/api/health", headers={"origin": "https://evil.example",
                                                             "sec-fetch-site": "cross-site"}).status, 200)


TAILNET_HOST = "helm.example.ts.net:8643"
DOOR = auth.Origin(host="helm.example.ts.net", port=8643)


class DoorTest(unittest.TestCase):
    """The tailnet door in `app.authorize`: a loopback peer whose Host is the tailnet name.
    The gate is stubbed here; the ceremony that mints a real session is AuthTest's."""

    def setUp(self) -> None:
        self.ok = False
        self.tailnet = app.Tailnet(host=TAILNET_HOST, session_ok=lambda r: self.ok)
        self.table = routes.table(DOOR)

    def knock(self, method: str, path: str, **kw) -> app.Response:
        """A request on the tailnet listener, with the Host `tailscale serve` forwards."""
        headers = {"host": TAILNET_HOST}
        headers.update(kw.pop("headers", {}))
        kw.setdefault("door", "tailnet")
        return app.dispatch(request(method, path, headers=headers, **kw), self.table, self.tailnet)

    def test_without_a_door_the_tailnet_name_is_a_stranger(self) -> None:
        with self.assertRaises(app.ApiError) as caught:
            app.dispatch(request("GET", "/api/health", headers={"host": TAILNET_HOST}), routes.ROUTES, None)
        self.assertEqual(caught.exception.status, 403)

    def test_the_door_is_the_listener_and_not_the_host_header(self) -> None:
        """The critical finding: a tailnet node sending `Host: localhost` used to be sorted
        into the loopback door and read with no session. The listener decides,
        and on the tailnet listener a loopback Host is not a name that door answers to."""
        for host in ("localhost", f"127.0.0.1:{PORT}", "[::1]", "evil.example"):
            for session in (False, True):
                self.ok = session
                with self.subTest(host=host, session=session):
                    with self.assertRaises(app.ApiError) as caught:
                        self.knock("GET", "/api/health", headers={"host": host})
                    self.assertEqual(caught.exception.status, 403)
                    self.assertNotEqual(caught.exception.detail, "sign in with your passkey first")
        self.ok = True
        self.assertEqual(json.loads(self.knock("GET", "/api/health").body)["reach"], "tailnet")

    def test_the_loopback_listener_refuses_the_tailnet_name(self) -> None:
        """Rebinding still fails on the loopback door: the tailnet name only means something
        on the tailnet listener."""
        self.ok = True
        with self.assertRaises(app.ApiError) as caught:
            self.knock("GET", "/api/health", door="loopback")
        self.assertEqual(caught.exception.status, 403)

    def test_a_write_over_the_tailnet_takes_the_page_s_origin_and_no_other(self) -> None:
        self.ok = True
        out = self.knock("POST", "/auth/logout", headers={"origin": "https://" + TAILNET_HOST})
        self.assertEqual(out.status, 200)
        with self.assertRaises(app.ApiError) as caught:
            self.knock("POST", "/auth/logout", headers={"origin": f"http://localhost:{PORT}"})
        self.assertEqual(caught.exception.status, 403)

    def test_the_page_is_open_and_a_read_needs_a_session(self) -> None:
        self.assertEqual(self.knock("GET", "/").status, 200)
        self.assertEqual(self.knock("GET", "/manifest.webmanifest").status, 200)
        with self.assertRaises(app.ApiError) as caught:
            self.knock("GET", "/api/health")
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(caught.exception.code, "unauthorized")

    def test_with_a_session_every_tailnet_row_answers_and_says_which_door(self) -> None:
        self.ok = True
        health = self.knock("GET", "/api/health")
        self.assertEqual(health.status, 200)
        self.assertEqual(json.loads(health.body)["reach"], "tailnet")
        self.assertEqual(json.loads(call("GET", "/api/health").body)["reach"], "loopback")

    def test_a_tailnet_peer_that_is_not_loopback_is_refused_even_with_the_right_host(self) -> None:
        """`tailscale serve` proxies from 127.0.0.1; a packet straight from a tailnet address
        did not come through it and never reaches the gate."""
        self.ok = True
        with self.assertRaises(app.ApiError) as caught:
            self.knock("GET", "/api/health", peer="100.64.1.9")
        self.assertEqual(caught.exception.status, 403)

    def test_an_unrouted_path_is_loopback_only_whatever_the_session_says(self) -> None:
        self.ok = True
        with self.assertRaises(app.ApiError) as caught:
            self.knock("GET", "/api/nothing")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(call("GET", "/api/nothing").status, 404)

    def test_the_loopback_door_never_asks_for_a_session(self) -> None:
        self.assertEqual(app.dispatch(request("GET", "/api/health"), routes.ROUTES, self.tailnet).status, 200)


class AuthTest(unittest.TestCase):
    """The whole door, end to end through `dispatch`: enroll a passkey with the one shot
    token, sign in with an assertion signed by the test signer in test_passkey, read a
    tailnet row with the cookie, sign out. The origin is the one test_passkey signs over."""

    def setUp(self) -> None:
        home = Path(tempfile.mkdtemp(dir=ROOT))
        for name, value in (("AUTH_DIR", home), ("CREDENTIALS", home / "credentials.json"),
                            ("SESSIONS", home / "sessions.json"), ("ENROLL", home / "enroll")):
            self.addCleanup(setattr, auth, name, getattr(auth, name))
            setattr(auth, name, value)
        auth.CHALLENGES.clear()
        self.origin = auth.Origin(host=test_passkey.RP_ID, port=443)
        self.table = routes.table(self.origin)
        self.tailnet = auth.tailnet_for(self.origin)

    def knock(self, method: str, path: str, body: object = None, cookie: str | None = None) -> app.Response:
        headers = {"host": self.origin.host_header}
        if cookie is not None:
            headers["cookie"] = f"{auth.COOKIE}={cookie}"
        raw = b"" if body is None else json.dumps(body).encode()
        try:
            return app.dispatch(request(method, path, body=raw, headers=headers, door="tailnet"),
                                self.table, self.tailnet)
        except app.ApiError as e:
            return e.response()

    @staticmethod
    def cookie_of(response: app.Response) -> str:
        header = response.headers["Set-Cookie"]
        assert header.startswith(f"{auth.COOKIE}="), header
        for flag in ("HttpOnly", "Secure", "SameSite=Strict"):
            assert flag in header, header
        return header.split(";")[0].split("=", 1)[1]

    def enroll(self) -> str:
        token = auth.write_enroll_token()
        started = self.knock("POST", "/auth/register/options", {"token": token})
        self.assertEqual(started.status, 200, started.body)
        opened = json.loads(started.body)
        challenge = passkey_challenge(opened["options"]["challenge"])
        finished = self.knock("POST", "/auth/register/verify", {
            "token": token, "challengeId": opened["challengeId"], "label": "iphone",
            "credential": test_passkey.registration(challenge)})
        self.assertEqual(finished.status, 200, finished.body)
        return self.cookie_of(finished)

    def test_no_token_means_no_enrollment(self) -> None:
        for body in ({}, {"token": "guess"}):
            with self.subTest(body=body):
                refused = self.knock("POST", "/auth/register/options", body)
                self.assertEqual(refused.status, 403)
        auth.write_enroll_token()
        self.assertEqual(self.knock("POST", "/auth/register/options", {"token": "guess"}).status, 403)

    def test_enrolling_registers_the_passkey_burns_the_token_and_signs_in(self) -> None:
        self.assertEqual(json.loads(self.knock("GET", "/auth/me").body),
                         {"via": "tailnet", "authenticated": False, "enrolled": False})
        cookie = self.enroll()
        self.assertFalse(auth.ENROLL.exists())
        self.assertEqual(len(auth.credentials()), 1)
        self.assertEqual(auth.credentials()[0].label, "iphone")
        self.assertEqual(json.loads(self.knock("GET", "/auth/me", cookie=cookie).body),
                         {"via": "tailnet", "authenticated": True, "enrolled": True})
        self.assertEqual(self.knock("GET", "/api/health", cookie=cookie).status, 200)
        self.assertEqual(self.knock("GET", "/api/health", cookie="forged").status, 401)

    def test_signing_in_is_an_assertion_the_registered_key_signed(self) -> None:
        self.enroll()
        started = json.loads(self.knock("POST", "/auth/login/options").body)
        self.assertEqual(started["options"]["userVerification"], "required")
        challenge = passkey_challenge(started["options"]["challenge"])
        finished = self.knock("POST", "/auth/login/verify", {
            "challengeId": started["challengeId"], "credential": test_passkey.assertion(challenge, sign_count=3)})
        self.assertEqual(finished.status, 200, finished.body)
        cookie = self.cookie_of(finished)
        self.assertEqual(auth.credentials()[0].sign_count, 3)
        self.assertEqual(self.knock("GET", "/api/health", cookie=cookie).status, 200)

        signed_out = self.knock("POST", "/auth/logout", cookie=cookie)
        self.assertIn("Max-Age=0", signed_out.headers["Set-Cookie"])
        self.assertEqual(self.knock("GET", "/api/health", cookie=cookie).status, 401)

    def test_a_bad_assertion_a_reused_challenge_and_a_stranger_s_key_are_refused(self) -> None:
        enrolled = self.enroll()
        started = json.loads(self.knock("POST", "/auth/login/options").body)
        challenge = passkey_challenge(started["options"]["challenge"])
        cid = started["challengeId"]
        tampered = self.knock("POST", "/auth/login/verify",
                              {"challengeId": cid, "credential": test_passkey.assertion(challenge, tamper=True)})
        self.assertEqual(tampered.status, 401)
        replayed = self.knock("POST", "/auth/login/verify",
                              {"challengeId": cid, "credential": test_passkey.assertion(challenge)})
        self.assertEqual(replayed.status, 400)
        self.assertEqual(list(auth.sessions()), [enrolled])

        again = json.loads(self.knock("POST", "/auth/login/options").body)
        stranger = test_passkey.assertion(passkey_challenge(again["options"]["challenge"]))
        stranger["rawId"] = stranger["id"] = "AAAA"
        self.assertEqual(self.knock("POST", "/auth/login/verify",
                                    {"challengeId": again["challengeId"], "credential": stranger}).status, 401)

    def test_with_no_tailnet_name_the_page_is_still_told_it_is_in(self) -> None:
        """No door means no passkey rows, but the page asks /auth/me before drawing the board.
        A 404 there left a loopback-only install stuck on the sign-in gate."""
        table = routes.table(None)
        self.assertEqual(json.loads(app.dispatch(request("GET", "/auth/me"), table, None).body),
                         {"via": "loopback", "authenticated": True, "enrolled": False})
        self.assertEqual(app.dispatch(request("GET", "/auth/login/options"), table, None).status, 404)

    def test_the_auth_rows_are_open_but_a_loopback_visitor_is_simply_in(self) -> None:
        for path in ("/auth/login/options", "/auth/me"):
            self.assertEqual(app.reach_of(request("GET", path), self.table), "open")
        self.assertEqual(json.loads(app.dispatch(request("GET", "/auth/me"), self.table, self.tailnet).body),
                         {"via": "loopback", "authenticated": True, "enrolled": False})


def passkey_challenge(encoded: str) -> bytes:
    return test_passkey.passkey.b64url_decode(encoded)


class WireTest(unittest.TestCase):
    """The handler, over a real socket. `dispatch` never sees framing, and framing is where a
    refused body desynchronises a keep-alive connection."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = app.make_server("127.0.0.1", 0, routes.ROUTES)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def connect(self) -> socket.socket:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(sock.close)
        return sock

    def test_each_listener_stamps_its_own_door(self) -> None:
        """Two sockets in one process. The one `tailscale serve` targets stamps every request
        tailnet whatever Host it carries, and the dashboard port stays the loopback door."""
        tailnet = app.Tailnet(host=TAILNET_HOST, session_ok=lambda r: True)
        second = app.make_server("127.0.0.1", 0, routes.ROUTES, tailnet, door="tailnet")
        thread = threading.Thread(target=second.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(second.server_close)
        self.addCleanup(second.shutdown)

        def health(port: int, host: str) -> tuple[int, dict]:
            sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            self.addCleanup(sock.close)
            sock.sendall(f"GET /api/health HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
            raw = b""
            while chunk := sock.recv(65536):
                raw += chunk
            head, _, body = raw.partition(b"\r\n\r\n")
            return int(head.split()[1]), json.loads(body)

        tailnet_port = second.server_address[1]
        status, payload = health(tailnet_port, TAILNET_HOST)
        self.assertEqual((status, payload["reach"]), (200, "tailnet"))
        status, payload = health(tailnet_port, "localhost")
        self.assertEqual((status, payload["error"]["code"]), (403, "forbidden"))
        status, payload = health(self.port, "localhost")
        self.assertEqual((status, payload["reach"]), (200, "loopback"))

    def test_the_socket_answers_from_the_fixture_and_not_the_real_build(self) -> None:
        sock = self.connect()
        sock.sendall(b"GET /index.html HTTP/1.1\r\nHost: localhost\r\n\r\n")
        expected = (DIST / "index.html").read_bytes()
        received = b""
        while expected not in received:
            chunk = sock.recv(65536)
            self.assertTrue(chunk, "the server closed before answering")
            received += chunk
        self.assertIn(b"HTTP/1.1 200 OK", received)

    def test_two_requests_share_one_connection(self) -> None:
        sock = self.connect()
        for _ in range(2):
            sock.sendall(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        received = b""
        while received.count(b"HTTP/1.1 200 OK") < 2:
            chunk = sock.recv(65536)
            self.assertTrue(chunk, "the server closed the connection before the second response")
            received += chunk
        self.assertNotIn(b"400", received)

    def test_an_oversize_body_is_refused_and_the_connection_closes(self) -> None:
        sock = self.connect()
        sock.sendall(b"POST /auth/logout HTTP/1.1\r\nHost: localhost\r\n"
                     b"Content-Length: 70000\r\n\r\n" + b"x" * 1000)
        received = b""
        while b"too_large" not in received:
            chunk = sock.recv(65536)
            self.assertTrue(chunk, "the server closed before answering")
            received += chunk
        self.assertIn(b"HTTP/1.1 413", received)
        self.assertEqual(sock.recv(65536), b"", "the unread body would be parsed as the next request")

    def test_head_gets_the_json_405_with_no_body_and_the_connection_survives(self) -> None:
        sock = self.connect()
        sock.sendall(b"HEAD /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        sock.sendall(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        received = b""
        while b'"ok": true' not in received:
            chunk = sock.recv(65536)
            self.assertTrue(chunk, "the server closed before the GET was answered")
            received += chunk
        head, _, rest = received.partition(b"\r\n\r\n")
        self.assertIn(b"HTTP/1.1 405", head)
        self.assertNotIn(b"method_not_allowed", received)
        self.assertTrue(rest.startswith(b"HTTP/1.1 200 OK"),
                        "a body on the HEAD response would be read as the next reply")

    def test_chunked_is_refused_rather_than_read_as_empty(self) -> None:
        sock = self.connect()
        sock.sendall(b"POST /auth/logout HTTP/1.1\r\nHost: localhost\r\n"
                     b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
        self.assertIn(b"HTTP/1.1 411", sock.recv(65536))


if __name__ == "__main__":
    unittest.main()
