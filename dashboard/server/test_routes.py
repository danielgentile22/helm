"""Route tests. They call `dispatch` directly, so no socket is opened and no port is claimed.

Everything the routes touch is redirected at a temp directory for the whole module, not one
class: the two status files, a fake vault that is its own git repo, and a fake `dist/`.
WireTest serves over a real socket, so a fixture that ended with RouteTest would have it
answering from the real vault. The capture refresh is replaced in all but one test, since
rerunning the todos source reads the vault and shells out to git for every line; that one test lets it run against the temp copy, so the re-merge path is covered.

    python3 -m unittest dashboard/server/test_routes.py
"""
from __future__ import annotations

import contextlib
import io
import json
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "runner" / "producers")]

import app  # noqa: E402
import auth  # noqa: E402
import common  # noqa: E402
import routes  # noqa: E402
import todo_edit  # noqa: E402
import test_passkey  # noqa: E402

# Captured before the fixture replaces it, for the one test that lets the real merge run.
REAL_REFRESH_TODOS = routes.refresh_todos

TODO_TEXT = "tick this from the dashboard"
WOBBLY_TEXT = "tick this while the re-merge is broken"
REFRESH_TEXT = "tick this and watch agenda.json catch up"
EDIT_TEXT = "reword this from the drawer"
NOTE_BODY = f"""# Chess

## Todos

- [ ] {TODO_TEXT}
- [ ] and leave this one alone
- [ ] {WOBBLY_TEXT}
- [ ] {REFRESH_TEXT}
- [ ] {EDIT_TEXT}
  a note that travels with it
"""


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True)


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
# and would otherwise answer from the real vault and the real status directory.
TMP: tempfile.TemporaryDirectory
ROOT: Path
VAULT: Path
STATUS: Path
DIST: Path
NOTE: Path
REL_NOTE: str
TODO_ID: str
SAVED: dict[tuple[object, str], object] = {}

def setUpModule() -> None:
    global TMP, ROOT, VAULT, STATUS, DIST, NOTE, REL_NOTE, TODO_ID
    TMP = tempfile.TemporaryDirectory()
    ROOT = Path(TMP.name).resolve()
    VAULT = ROOT / "Vault"
    STATUS = ROOT / "runner" / "status"
    DIST = ROOT / "dashboard" / "dist"
    NOTE = VAULT / "Atlas" / "Chess" / "Chess.md"

    NOTE.parent.mkdir(parents=True)
    NOTE.write_text(NOTE_BODY)
    for dept in ("Work", "Projects", "Life"):
        (VAULT / "Atlas" / dept).mkdir(parents=True)
        (VAULT / "Atlas" / dept / f"{dept}.md").write_text(f"# {dept}\n")
    git(VAULT, "init", "-q", "-b", "main")
    git(VAULT, "config", "user.email", "test@example.invalid")
    git(VAULT, "config", "user.name", "test")
    git(VAULT, "add", "-A")
    git(VAULT, "commit", "-q", "-m", "the fake vault")

    STATUS.mkdir(parents=True)
    (STATUS / "agenda.json").write_bytes(
        json.dumps({"produced": "2026-09-17T09:00:00-04:00", "items": []}).encode())
    (STATUS / "projects.json").write_bytes(b'{"in_flight": []}\n')

    DIST.mkdir(parents=True)
    (DIST / "index.html").write_text("<!doctype html><title>helm</title>\n")
    (DIST / "sw.js").write_text("self.addEventListener('fetch', () => {});\n")
    (DIST / "manifest.webmanifest").write_text('{"name": "helm", "id": "/"}\n')
    (ROOT / "secret.txt").write_text("not served\n")

    patched = {
        (common, "ENGINE"): ROOT,
        (common, "VAULT"): VAULT,
        (common, "STATUS"): STATUS,
        (routes, "DIST"): DIST,
        (routes, "refresh_todos"): lambda: "2026-09-17T09:00:01-04:00",
        # Otherwise every health request shells out to launchctl and the answer depends on
        # whether the machine running the tests happens to have the agent installed.
        (routes, "service_installed"): lambda: False,
    }
    SAVED.update({key: getattr(*key) for key in patched})
    for (module, name), value in patched.items():
        setattr(module, name, value)

    REL_NOTE = str(NOTE.relative_to(ROOT))
    TODO_ID = common.content_id(REL_NOTE, TODO_TEXT)


def tearDownModule() -> None:
    for (module, name), value in SAVED.items():
        setattr(module, name, value)
    TMP.cleanup()


class RouteTest(unittest.TestCase):
    def test_agenda_is_the_file_verbatim_and_revalidates(self) -> None:
        first = call("GET", "/api/agenda")
        self.assertEqual(first.status, 200)
        self.assertEqual(first.body, (STATUS / "agenda.json").read_bytes())
        self.assertEqual(first.headers["Content-Type"], "application/json")
        self.assertEqual(first.headers["Cache-Control"], "no-cache")
        self.assertIn("Date", first.headers)
        etag = first.headers["ETag"]

        again = call("GET", "/api/agenda", headers={"if-none-match": etag})
        self.assertEqual(again.status, 304)
        self.assertEqual(again.body, b"")
        self.assertEqual(again.headers["ETag"], etag)

    def test_agenda_is_unavailable_when_the_file_is_gone(self) -> None:
        moved = STATUS / "projects.json"
        moved.rename(moved.with_suffix(".away"))
        try:
            gone = call("GET", "/api/projects")
        finally:
            moved.with_suffix(".away").rename(moved)
        self.assertEqual(gone.status, 503)
        self.assertEqual(json.loads(gone.body)["error"]["code"], "unavailable")

    def test_put_done_is_desired_state_so_a_repeat_changes_nothing(self) -> None:
        path = f"/api/todos/{TODO_ID}/done"
        first = json.loads(call("PUT", path, body=b'{"done": true}').body)
        self.assertEqual(first["done"], True)
        self.assertEqual(first["changed"], True)
        self.assertRegex(first["commit"], r"^[0-9a-f]{7,}$")
        self.assertIn("- [x]", first["line"])
        self.assertEqual(first["agenda_produced"], "2026-09-17T09:00:01-04:00")
        self.assertIn(f"- [x] {TODO_TEXT}", NOTE.read_text())

        again = json.loads(call("PUT", path, body=b'{"done": true}').body)
        self.assertEqual(again["changed"], False)
        self.assertIsNone(again["commit"])
        self.assertIsNone(again["agenda_produced"])

        subject = subprocess.run(["git", "-C", str(VAULT), "log", "-1", "--format=%s"],
                                 capture_output=True, text=True).stdout.strip()
        self.assertEqual(subject, f"Tick a Chess todo: {TODO_TEXT}")

    def test_a_failed_re_merge_still_answers_200_because_the_commit_stands(self) -> None:
        """Answering with an error here would make the client untick a box the vault has
        already committed. The stamp is null instead, and the next capture catches up."""
        def boom() -> str:
            raise OSError("the status directory is gone")

        self.addCleanup(setattr, routes, "refresh_todos", routes.refresh_todos)
        routes.refresh_todos = boom
        with contextlib.redirect_stderr(io.StringIO()) as logged:
            out = call("PUT", f"/api/todos/{common.content_id(REL_NOTE, WOBBLY_TEXT)}/done",
                       body=b'{"done": true}')
        self.assertEqual(out.status, 200)
        payload = json.loads(out.body)
        self.assertEqual(payload["changed"], True)
        self.assertIsNone(payload["agenda_produced"])
        self.assertRegex(payload["commit"], r"^[0-9a-f]{7,}$")
        self.assertIn(f"- [x] {WOBBLY_TEXT}", NOTE.read_text())
        self.assertIn("the status directory is gone", logged.getvalue())

    def test_the_real_re_merge_takes_the_ticked_row_out_of_agenda(self) -> None:
        """The one test that lets `capture.refresh` run for real, against the temp vault. The
        repo scan would walk the real ~/Projects, so the table is the todos source and three
        stubs."""
        import capture
        from sources import todos

        self.addCleanup(setattr, common, "SOURCES_DIR", common.SOURCES_DIR)
        common.SOURCES_DIR = STATUS / "sources"
        self.addCleanup(setattr, capture, "SOURCES", capture.SOURCES)
        capture.SOURCES = dict.fromkeys(capture.SOURCES, lambda env, now: [])
        capture.SOURCES["todos"] = todos.collect
        self.addCleanup(setattr, capture, "cadence", capture.cadence)
        capture.cadence = lambda: 1800  # models.json is not in the temp root
        self.addCleanup(setattr, routes, "refresh_todos", routes.refresh_todos)
        routes.refresh_todos = REAL_REFRESH_TODOS

        out = json.loads(call("PUT", f"/api/todos/{common.content_id(REL_NOTE, REFRESH_TEXT)}/done",
                              body=b'{"done": true}').body)
        self.assertEqual(out["changed"], True)
        agenda = json.loads((STATUS / "agenda.json").read_text())
        self.assertEqual(agenda["produced"], out["agenda_produced"])
        texts = [item["text"] for item in agenda["items"]]
        self.assertNotIn(REFRESH_TEXT, texts)
        self.assertIn("and leave this one alone", texts)

    def test_put_done_on_an_unknown_id_is_404(self) -> None:
        missing = call("PUT", "/api/todos/abc123abc123/done", body=b'{"done": true}')
        self.assertEqual(missing.status, 404)
        self.assertEqual(json.loads(missing.body)["error"]["code"], "not_found")

    def test_put_done_with_a_bad_body_is_400(self) -> None:
        for body in (b"", b"{}", b'{"done": "yes"}'):
            with self.subTest(body=body):
                bad = call("PUT", f"/api/todos/{TODO_ID}/done", body=body)
                self.assertEqual(bad.status, 400)
                self.assertEqual(json.loads(bad.body)["error"]["code"], "bad_request")

    def test_patch_rewrites_the_named_fields_and_follows_the_new_id(self) -> None:
        path = f"/api/todos/{common.content_id(REL_NOTE, EDIT_TEXT)}"
        body = json.dumps({"text": "reworded in the drawer", "when": {"kind": "todo", "due": "2026-10-02"},
                           "project": "Camps"}).encode()
        out = call("PATCH", path, body=body)
        self.assertEqual(out.status, 200)
        first = json.loads(out.body)
        self.assertEqual(first["changed"], True)
        self.assertEqual(first["id"], common.content_id(REL_NOTE, "reworded in the drawer"))
        self.assertEqual(first["line"], "- [ ] reworded in the drawer (due: 2026-10-02)")
        self.assertRegex(first["commit"], r"^[0-9a-f]{7,}$")
        note = NOTE.read_text()
        self.assertNotIn(EDIT_TEXT, note)
        self.assertIn("### Camps\n\n- [ ] reworded in the drawer (due: 2026-10-02)\n  a note that travels with it", note)
        subject = subprocess.run(["git", "-C", str(VAULT), "log", "-1", "--format=%s"],
                                 capture_output=True, text=True).stdout.strip()
        self.assertEqual(subject, "Edit a Chess todo: reworded in the drawer")

        again = json.loads(call("PATCH", f"/api/todos/{first['id']}", body=body).body)
        self.assertEqual(again["changed"], False)
        self.assertIsNone(again["commit"])
        self.assertIsNone(again["agenda_produced"])

        daily = json.loads(call("PATCH", f"/api/todos/{first['id']}",
                                body=b'{"when": {"kind": "daily"}, "project": null}').body)
        self.assertEqual(daily["id"], first["id"])
        self.assertEqual(daily["line"], "- [ ] reworded in the drawer (daily)")

    def test_patch_on_an_unknown_id_is_404(self) -> None:
        missing = call("PATCH", "/api/todos/abc123abc123", body=b'{"text": "anything"}')
        self.assertEqual(missing.status, 404)
        self.assertEqual(json.loads(missing.body)["error"]["code"], "not_found")

    def test_patch_with_a_bad_body_is_400(self) -> None:
        for body in (b"", b"[]", b'{"done": true}', b'{"text": "  "}', b'{"when": {"kind": "soon"}}',
                     b'{"when": {"kind": "event"}}', b'{"project": 3}'):
            with self.subTest(body=body):
                bad = call("PATCH", f"/api/todos/{TODO_ID}", body=body)
                self.assertEqual(bad.status, 400)
                self.assertEqual(json.loads(bad.body)["error"]["code"], "bad_request")

    def test_patch_the_note_refuses_is_422_and_writes_nothing(self) -> None:
        before = NOTE.read_text()
        target = f"/api/todos/{common.content_id(REL_NOTE, 'and leave this one alone')}"
        for body in (json.dumps({"text": TODO_TEXT}).encode(),
                     b'{"when": {"kind": "todo", "due": "2026-13-40"}}',
                     b'{"when": {"kind": "event", "at": "tomorrow"}}'):
            with self.subTest(body=body):
                refused = call("PATCH", target, body=body)
                self.assertEqual(refused.status, 422)
                self.assertEqual(json.loads(refused.body)["error"]["code"], "refused")
        self.assertEqual(NOTE.read_text(), before)

    def add(self, **body: object) -> app.Response:
        return call("POST", "/api/todos", body=json.dumps(body).encode())

    def test_post_adds_a_todo_for_each_kind_of_when_and_commits_it(self) -> None:
        note = VAULT / "Atlas" / "Work" / "Work.md"
        rel = str(note.relative_to(ROOT))
        cases = (
            ("send the offer letter back", None, "- [ ] send the offer letter back"),
            ("book the onsite", {"kind": "todo", "due": None}, "- [ ] book the onsite"),
            ("prep the system design round", {"kind": "todo", "due": "2026-10-02"},
             "- [ ] prep the system design round (due: 2026-10-02)"),
            ("do one leetcode problem", {"kind": "daily"}, "- [ ] do one leetcode problem (daily)"),
            ("phone screen with Acme", {"kind": "event", "at": "2026-10-03 14:30"},
             "- [ ] phone screen with Acme (at: 2026-10-03 14:30)"),
        )
        for text, when, line in cases:
            with self.subTest(when=when):
                body = {"text": f"  {text} ", "dept": "Work", "project": None}
                if when is not None:
                    body["when"] = when
                out = self.add(**body)
                self.assertEqual(out.status, 200)
                payload = json.loads(out.body)
                self.assertEqual(payload["id"], common.content_id(rel, text))
                self.assertEqual(payload["changed"], True)
                self.assertEqual(payload["line"], line)
                self.assertRegex(payload["commit"], r"^[0-9a-f]{7,}$")
                self.assertEqual(payload["agenda_produced"], "2026-09-17T09:00:01-04:00")
                self.assertIn(line + "\n", note.read_text())
                subject = subprocess.run(["git", "-C", str(VAULT), "log", "-1", "--format=%s"],
                                         capture_output=True, text=True).stdout.strip()
                self.assertEqual(subject, f"Add a Work todo: {text}")
        self.assertIn("## Todos\n\n" + "".join(line + "\n" for _, _, line in cases), note.read_text())

    def test_post_with_a_null_when_is_an_undated_todo(self) -> None:
        out = json.loads(self.add(text="renew the passport", dept="Life", when=None).body)
        self.assertEqual(out["line"], "- [ ] renew the passport")

    def test_post_files_the_todo_under_its_directive_creating_the_heading(self) -> None:
        note = VAULT / "Atlas" / "Projects" / "Projects.md"
        first = json.loads(self.add(text="unfiled thing", dept="Projects").body)
        self.assertEqual(first["line"], "- [ ] unfiled thing")
        for text in ("ship the add route", "wire the quick add form"):
            out = self.add(text=text, dept="Projects", project=" helm dashboard ",
                           when={"kind": "todo", "due": None})
            self.assertEqual(out.status, 200)
        self.assertIn("## Todos\n\n- [ ] unfiled thing\n\n### helm dashboard\n\n"
                      "- [ ] ship the add route\n- [ ] wire the quick add form\n", note.read_text())

    def test_post_the_note_refuses_is_422_and_writes_nothing(self) -> None:
        before = NOTE.read_text()
        head = subprocess.run(["git", "-C", str(VAULT), "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout
        for body in ({"text": "and leave this one alone", "dept": "Chess"},
                     {"text": "a fresh one", "dept": "Chess", "when": {"kind": "todo", "due": "2026-13-40"}},
                     {"text": "a fresh one", "dept": "Chess", "when": {"kind": "event", "at": "tomorrow"}}):
            with self.subTest(body=body):
                refused = self.add(**body)
                self.assertEqual(refused.status, 422)
                self.assertEqual(json.loads(refused.body)["error"]["code"], "refused")
        duplicate = json.loads(self.add(text="and leave this one alone", dept="Chess").body)
        self.assertIn("already has this todo", duplicate["error"]["detail"])
        self.assertEqual(NOTE.read_text(), before)
        self.assertEqual(subprocess.run(["git", "-C", str(VAULT), "rev-parse", "HEAD"],
                                        capture_output=True, text=True).stdout, head)

    def test_post_with_a_bad_body_is_400(self) -> None:
        before = NOTE.read_text()
        for body in (b"", b"[]", b"not json", b'{"dept": "Chess"}', b'{"text": "  ", "dept": "Chess"}',
                     b'{"text": 3, "dept": "Chess"}', b'{"text": "words"}', b'{"text": "words", "dept": "chess"}',
                     b'{"text": "words", "dept": "Garden"}', b'{"text": "words", "dept": "Chess", "project": 3}',
                     b'{"text": "words", "dept": "Chess", "project": "  "}',
                     b'{"text": "words", "dept": "Chess", "when": "tomorrow"}',
                     b'{"text": "words", "dept": "Chess", "when": {"kind": "soon"}}',
                     b'{"text": "words", "dept": "Chess", "when": {"kind": "event"}}',
                     b'{"text": "words", "dept": "Chess", "done": true}'):
            with self.subTest(body=body):
                bad = call("POST", "/api/todos", body=body)
                self.assertEqual(bad.status, 400)
                self.assertEqual(json.loads(bad.body)["error"]["code"], "bad_request")
        self.assertEqual(NOTE.read_text(), before)

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
        """The worker has to land at the root under a stable name, because its scope is the
        directory it is served from."""
        for path, content_type in (("/sw.js", "text/javascript; charset=utf-8"),
                                   ("/manifest.webmanifest", "application/manifest+json")):
            with self.subTest(path=path):
                out = call("GET", path)
                self.assertEqual(out.status, 200)
                self.assertEqual(out.headers["Content-Type"], content_type)
                self.assertEqual(out.headers["Cache-Control"], "no-cache")
                self.assertEqual(out.body, (DIST / path.lstrip("/")).read_bytes())

    def test_reach_is_the_strictest_row_and_an_unrouted_path_is_loopback(self) -> None:
        """The page and its assets are open so a phone can sign in; every read and write is
        tailnet; and a path no row claims gets the strictest
        reach of all, so a stray file can never be reached from the tailnet by accident."""
        for path, reach in (("/sw.js", "open"), ("/manifest.webmanifest", "open"), ("/", "open"),
                            ("/api/agenda", "tailnet"), ("/api/nothing", "loopback")):
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
                out = call(method, "/api/agenda")
                self.assertEqual(out.status, 405)
                self.assertEqual(json.loads(out.body)["error"]["code"], "method_not_allowed")

    def test_an_unknown_method_on_an_unknown_path_is_404(self) -> None:
        out = call("DELETE", "/api/nope")
        self.assertEqual(out.status, 404)
        self.assertEqual(json.loads(out.body)["error"]["code"], "not_found")

    def samples(self) -> list[tuple[str, str]]:
        """One request per row of the table, so a gate test covers the whole table."""
        rows = [
            ("GET", "/api/agenda"),
            ("GET", "/api/projects"),
            ("PUT", f"/api/todos/{TODO_ID}/done"),
            ("PATCH", f"/api/todos/{TODO_ID}"),
            ("POST", "/api/todos"),
            ("GET", "/api/health"),
            ("GET", "/index.html"),
            ("GET", "/sw.js"),
            ("GET", "/manifest.webmanifest"),
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
                    call(method, path, headers={"host": "evil.example"}, body=b'{"done": true}')
                refused = caught.exception.response()
                self.assertEqual(refused.status, 403)
                detail = json.loads(refused.body)["error"]
                self.assertEqual(detail["code"], "forbidden")
                self.assertIn("evil.example", detail["detail"])
        self.assertNotIn("- [x] and leave this one alone", NOTE.read_text())

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
                    call(method, path, peer="100.64.1.9", body=b'{"done": true}')
                refused = caught.exception.response()
                self.assertEqual(refused.status, 403)
                self.assertEqual(json.loads(refused.body)["error"]["code"], "forbidden")
        self.assertNotIn("- [x] and leave this one alone", NOTE.read_text())

    def test_every_write_refuses_a_foreign_origin_and_a_cross_site_fetch(self) -> None:
        """A page on another site open in the desktop browser reaches the loopback door with
        no session asked, and its POST carries its own Origin. Refused in the gate, so every
        write and the auth ceremony are covered without knowing it."""
        writes = [(m, p) for m, p in self.samples() if m not in ("GET", "HEAD")]
        self.assertTrue(writes)
        for method, path in writes:
            for headers in ({"origin": "https://evil.example"},
                            {"origin": "null"},
                            {"sec-fetch-site": "cross-site"}):
                with self.subTest(path=path, headers=headers):
                    with self.assertRaises(app.ApiError) as caught:
                        call(method, path, headers=headers, body=b'{"done": true}')
                    self.assertEqual(caught.exception.status, 403)
                    self.assertIn("page", caught.exception.detail)
        self.assertNotIn("- [x] and leave this one alone", NOTE.read_text())

    def test_the_page_s_own_origin_passes_and_a_read_ignores_origin(self) -> None:
        for origin in (f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"):
            with self.subTest(origin=origin):
                out = call("PUT", f"/api/todos/{TODO_ID}/done", body=b'{"done": false}',
                           headers={"origin": origin, "sec-fetch-site": "same-origin"})
                self.assertEqual(out.status, 200)
        self.assertEqual(call("GET", "/api/health", headers={"origin": "https://evil.example",
                                                             "sec-fetch-site": "cross-site"}).status, 200)


TAILNET_HOST = "helm.example.ts.net:8643"


class DoorTest(unittest.TestCase):
    """The tailnet door in `app.authorize`: a loopback peer whose Host is the tailnet name.
    The gate is stubbed here; the ceremony that mints a real session is AuthTest's."""

    def setUp(self) -> None:
        self.ok = False
        self.tailnet = app.Tailnet(host=TAILNET_HOST, session_ok=lambda r: self.ok)

    def knock(self, method: str, path: str, **kw) -> app.Response:
        """A request on the tailnet listener, with the Host `tailscale serve` forwards."""
        headers = {"host": TAILNET_HOST}
        headers.update(kw.pop("headers", {}))
        kw.setdefault("door", "tailnet")
        return app.dispatch(request(method, path, headers=headers, **kw), routes.ROUTES, self.tailnet)

    def test_without_a_door_the_tailnet_name_is_a_stranger(self) -> None:
        with self.assertRaises(app.ApiError) as caught:
            app.dispatch(request("GET", "/api/health", headers={"host": TAILNET_HOST}), routes.ROUTES, None)
        self.assertEqual(caught.exception.status, 403)

    def test_the_door_is_the_listener_and_not_the_host_header(self) -> None:
        """The critical finding: a tailnet node sending `Host: localhost` used to be sorted
        into the loopback door and read the agenda with no session. The listener decides,
        and on the tailnet listener a loopback Host is not a name that door answers to."""
        for host in ("localhost", f"127.0.0.1:{PORT}", "[::1]", "evil.example"):
            for session in (False, True):
                self.ok = session
                with self.subTest(host=host, session=session):
                    with self.assertRaises(app.ApiError) as caught:
                        self.knock("GET", "/api/agenda", headers={"host": host})
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
        out = self.knock("PUT", f"/api/todos/{TODO_ID}/done", body=b'{"done": false}',
                         headers={"origin": "https://" + TAILNET_HOST})
        self.assertEqual(out.status, 200)
        with self.assertRaises(app.ApiError) as caught:
            self.knock("PUT", f"/api/todos/{TODO_ID}/done", body=b'{"done": false}',
                       headers={"origin": f"http://localhost:{PORT}"})
        self.assertEqual(caught.exception.status, 403)

    def test_the_page_is_open_and_a_read_needs_a_session(self) -> None:
        self.assertEqual(self.knock("GET", "/").status, 200)
        self.assertEqual(self.knock("GET", "/manifest.webmanifest").status, 200)
        with self.assertRaises(app.ApiError) as caught:
            self.knock("GET", "/api/agenda")
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
        self.assertEqual(self.knock("GET", "/api/agenda", cookie=cookie).status, 200)
        self.assertEqual(self.knock("GET", "/api/agenda", cookie="forged").status, 401)

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

    def test_the_socket_answers_from_the_fixture_and_not_the_real_status_directory(self) -> None:
        sock = self.connect()
        sock.sendall(b"GET /api/agenda HTTP/1.1\r\nHost: localhost\r\n\r\n")
        expected = (STATUS / "agenda.json").read_bytes()
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
        sock.sendall(b"PUT /api/todos/000000000000/done HTTP/1.1\r\nHost: localhost\r\n"
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
        sock.sendall(b"PUT /api/todos/000000000000/done HTTP/1.1\r\nHost: localhost\r\n"
                     b"Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
        self.assertIn(b"HTTP/1.1 411", sock.recv(65536))


if __name__ == "__main__":
    unittest.main()
