"""The write routes of ADR 0038, through `dispatch`, against a git copy of the demo vault, a
temp state folder and a fake launchd. Nothing here touches the real vault, launchd or
~/Library.

    python3 -m unittest dashboard/server/test_writes.py
"""
from __future__ import annotations

import http.client
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app  # noqa: E402
import machine  # noqa: E402
import routes  # noqa: E402
import common  # noqa: E402  after routes, which puts the producers on the path
import control  # noqa: E402

DEMO = common.ENGINE / "demo-vault"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
IDEA = "2026-09-26-order-the-desk-lamp"
TAILNET_HOST = "helm.example.ts.net:8643"


def post(path: str, body: object = None, raw: bytes | None = None) -> tuple[int, dict]:
    sent = {"host": "127.0.0.1:8642", "origin": "http://127.0.0.1:8642", "sec-fetch-site": "same-origin"}
    data = raw if raw is not None else json.dumps(body if body is not None else {}).encode()
    request = app.Request(method="POST", path=path, headers=sent, body=data, peer="127.0.0.1", port=8642)
    out = app.dispatch(request, routes.ROUTES)
    return out.status, json.loads(out.body)


class WriteTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.vault = root / "vault"
        shutil.copytree(DEMO, self.vault)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "start")
        self.state = root / "state"
        self.refreshes = 0

        def refreshed() -> None:
            self.refreshes += 1

        for module, name, value in ((common, "VAULT", self.vault), (common, "STATE", self.state),
                                    (common, "STATUS", self.state / "status"),
                                    (routes, "refresh_capture", refreshed)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)

    def git(self, *argv: str) -> str:
        return subprocess.run(["git", "-C", str(self.vault), *argv], check=True,
                              capture_output=True, text=True).stdout

    def subjects(self) -> list[str]:
        return self.git("log", "--format=%s").splitlines()

    def notes(self) -> set[str]:
        return {p.name for p in (self.vault / "Atlas" / "Ideas").glob("*.md")}


class AddIdeaTest(WriteTest):
    def test_an_idea_is_written_committed_and_answered_201(self) -> None:
        status, body = post("/api/ideas", {"title": "  Draft the Keel   onboarding email ", "project": "Keel",
                                           "due": "2026-11-20"})
        self.assertEqual(status, 201, body)
        idea = body["idea"]
        self.assertEqual(idea["title"], "Draft the Keel onboarding email")
        self.assertEqual((idea["project"], idea["department"], idea["due"], idea["status"]),
                         ("Keel", "Projects", "2026-11-20", "open"))
        note = self.vault / idea["path"]
        self.assertTrue(note.is_file())
        self.assertIn("Draft the Keel onboarding email", note.read_text())
        self.assertEqual(self.subjects()[0], "Add an idea")
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.refreshes, 1)

    def test_no_commit_subject_carries_the_title(self) -> None:
        title = "Ring Alex Reed about the Lisbon deposit"
        _, body = post("/api/ideas", {"title": title})
        post(f"/api/ideas/{body['idea']['id']}/status", {"status": "done"})
        post(f"/api/ideas/{body['idea']['id']}/due", {"due": "2026-12-01"})
        post(f"/api/ideas/{body['idea']['id']}/status", {"status": "dropped"})
        subjects = self.subjects()
        self.assertEqual(subjects[:4], ["Drop an idea", "Change an idea's due date", "Mark an idea done", "Add an idea"])
        for subject in subjects:
            self.assertNotIn("Lisbon", subject)
            self.assertNotIn("Alex", subject)

    def test_a_bad_idea_is_400_and_writes_nothing(self) -> None:
        before = (self.notes(), self.subjects())
        for body in ({}, {"title": ""}, {"title": "   "}, {"title": "x" * 201}, {"title": "two\nlines"},
                     {"title": "tab\there"}, {"title": 7}, {"title": "ok", "project": "Nope"},
                     {"title": "ok", "due": "next week"}, {"title": "ok", "due": "2026-13-01"},
                     {"title": "ok", "due": "2026-W46-1"}, {"title": "ok", "due": "20261115"},
                     {"title": "ok", "department": "Garden"}, {"title": "ok", "project": "Keel", "department": "Life"},
                     {"title": "ok", "body": "more text"}, {"title": "ok", "due": 20261101}, ["a list"]):
            with self.subTest(body=body):
                status, answer = post("/api/ideas", body)
                self.assertEqual(status, 400, answer)
                self.assertEqual(answer["error"]["code"], "bad_request")
        self.assertEqual(post("/api/ideas", raw=b"not json")[0], 400)
        self.assertEqual((self.notes(), self.subjects()), before)
        self.assertEqual(self.refreshes, 0)

    def test_two_hundred_characters_is_the_most_a_title_takes(self) -> None:
        self.assertEqual(post("/api/ideas", {"title": "x" * 200})[0], 201)

    def test_a_failed_commit_takes_the_note_back_out(self) -> None:
        before = self.notes()
        hook = self.vault / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        status, body = post("/api/ideas", {"title": "Book the Lisbon dinner"})
        self.assertEqual(status, 500)
        self.assertNotIn("Lisbon", json.dumps(body))
        self.assertEqual(self.notes(), before)
        self.assertEqual(self.git("status", "--porcelain"), "")


class EditIdeaTest(WriteTest):
    def test_a_failed_commit_puts_the_note_back(self) -> None:
        note = self.vault / "Atlas" / "Ideas" / f"{IDEA}.md"
        before = note.read_text()
        hook = self.vault / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        for path, body in ((f"/api/ideas/{IDEA}/status", {"status": "done"}),
                           (f"/api/ideas/{IDEA}/due", {"due": "2026-12-24"})):
            with self.subTest(path=path):
                self.assertEqual(post(path, body)[0], 500)
                self.assertEqual(note.read_text(), before)
                self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.refreshes, 0)

    def test_status_changes_commit_and_repeat_as_no_change(self) -> None:
        for status, subject in (("done", "Mark an idea done"), ("dropped", "Drop an idea"), ("open", "Reopen an idea")):
            with self.subTest(status=status):
                code, body = post(f"/api/ideas/{IDEA}/status", {"status": status})
                self.assertEqual((code, body["changed"], body["idea"]["status"]), (200, True, status))
                self.assertEqual(self.subjects()[0], subject)
                count = len(self.subjects())
                code, body = post(f"/api/ideas/{IDEA}/status", {"status": status})
                self.assertEqual((code, body["changed"]), (200, False))
                self.assertEqual(len(self.subjects()), count)
        self.assertEqual(self.refreshes, 3)

    def test_due_sets_clears_and_repeats_as_no_change(self) -> None:
        code, body = post(f"/api/ideas/{IDEA}/due", {"due": "2026-11-30"})
        self.assertEqual((code, body["changed"], body["idea"]["due"]), (200, True, "2026-11-30"))
        self.assertEqual(post(f"/api/ideas/{IDEA}/due", {"due": "2026-11-30"})[1]["changed"], False)
        code, body = post(f"/api/ideas/{IDEA}/due", {"due": None})
        self.assertEqual((code, body["changed"], body["idea"]["due"]), (200, True, None))
        self.assertNotIn("due:", (self.vault / body["idea"]["path"]).read_text())
        self.assertEqual(post(f"/api/ideas/{IDEA}/due", {"due": None})[1]["changed"], False)
        self.assertEqual(self.subjects()[:2], ["Change an idea's due date"] * 2)

    def test_an_unknown_id_is_404_and_a_bad_value_is_400(self) -> None:
        for path, body in (("/api/ideas/2026-01-01-no-such-idea/status", {"status": "done"}),
                           ("/api/ideas/2026-01-01-no-such-idea/due", {"due": None})):
            with self.subTest(path=path):
                self.assertEqual(post(path, body)[0], 404)
        for path, body in ((f"/api/ideas/{IDEA}/status", {"status": "promoted"}),
                           (f"/api/ideas/{IDEA}/status", {"status": "finished"}),
                           (f"/api/ideas/{IDEA}/status", {}),
                           (f"/api/ideas/{IDEA}/due", {"due": "soon"}),
                           (f"/api/ideas/{IDEA}/due", {})):
            with self.subTest(path=path, body=body):
                self.assertEqual(post(path, body)[0], 400)
        self.assertEqual(self.subjects(), ["start"])

    def test_an_id_that_is_not_an_idea_stem_has_no_route(self) -> None:
        for path in ("/api/ideas/..%2F..%2Fsecret/status", "/api/ideas/order-the-desk-lamp/status",
                     "/api/ideas/2026-09-26-Order/status"):
            with self.subTest(path=path):
                self.assertEqual(post(path, {"status": "done"})[0], 404)

    def test_a_promoted_idea_is_not_changed_here(self) -> None:
        note = self.vault / "Atlas" / "Ideas" / f"{IDEA}.md"
        note.write_text(note.read_text().replace("status: open", "status: promoted"))
        code, body = post(f"/api/ideas/{IDEA}/status", {"status": "done"})
        self.assertEqual(code, 409, body)
        self.assertIn("status: promoted", note.read_text())


class FakeLaunchd:
    """launchd as far as `control.py` can see it: which labels are loaded and with what pid."""

    def __init__(self) -> None:
        self.loaded: dict[str, int | None] = {}
        self.calls: list[tuple[str, ...]] = []
        self.refuse_bootstraps = 0
        self.broken = False

    def list(self) -> dict[str, machine.LaunchdJob]:
        return {label: machine.LaunchdJob(label, pid, 0) for label, pid in self.loaded.items()}

    def launchctl(self, *args: str) -> tuple[int, str]:
        verb = args[0]
        if verb == "print":
            if self.broken:
                return 1, "TimeoutExpired"
            label = args[1].rsplit("/", 1)[1]
            if label not in self.loaded:
                return control.NO_SUCH_JOB, "Could not find service"
            pid = self.loaded[label]
            return 0, f"{label} = {{\n\tstate = {'running' if pid else 'not running'}\n"\
                      + (f"\tpid = {pid}\n" if pid else "") + "}\n"
        self.calls.append(args)
        if verb == "kickstart":
            self.loaded[args[1].rsplit("/", 1)[1]] = 4242
            return 0, ""
        if verb == "bootout":
            return (0, "") if self.loaded.pop(args[1].rsplit("/", 1)[1], "absent") != "absent" else (3, "No such process")
        if verb == "bootstrap":
            if self.refuse_bootstraps:
                self.refuse_bootstraps -= 1
                return 5, "Bootstrap failed: 5: Input/output error"
            self.loaded[Path(args[2]).stem] = None
            return 0, ""
        raise AssertionError(f"unexpected launchctl {args}")


LABEL = "com.helm.capture"


class RoutineTest(WriteTest):
    def setUp(self) -> None:
        super().setUp()
        self.launchd = FakeLaunchd()
        self.agents = self.state.parent / "LaunchAgents"
        self.agents.mkdir()
        for module, name, value in ((machine, "launchctl_list", self.launchd.list),
                                    (machine, "launchctl", self.launchd.launchctl),
                                    (machine, "gui_domain", lambda: "gui/501"),
                                    (machine, "LAUNCH_AGENTS", self.agents),
                                    (control, "RETRY_DELAY_S", 0)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)

    @property
    def active(self) -> Path:
        return self.agents / f"{LABEL}.plist"

    @property
    def parked(self) -> Path:
        return self.state / "disabled" / f"{LABEL}.plist"

    def installed(self) -> None:
        self.active.write_text("<plist/>")
        self.launchd.loaded[LABEL] = None

    def act(self, action: str, name: str = "capture") -> tuple[int, dict]:
        return post(f"/api/routines/{name}/{action}")

    def assert_paused(self) -> None:
        self.assertEqual((self.parked.is_file(), self.active.exists(), LABEL in self.launchd.loaded),
                         (True, False, False))

    def assert_resumed(self) -> None:
        self.assertEqual((self.parked.exists(), self.active.is_file(), LABEL in self.launchd.loaded),
                         (False, True, True))

    def test_run_kickstarts_the_named_job_and_refuses_while_running_or_paused(self) -> None:
        self.installed()
        code, body = self.act("run")
        self.assertEqual(code, 200, body)
        self.assertEqual(self.launchd.calls, [("kickstart", f"gui/501/{LABEL}")])
        self.assertTrue(body["routine"]["running"])
        code, body = self.act("run")
        self.assertEqual(code, 409)
        self.assertIn("already running", body["error"]["detail"])
        self.launchd.loaded[LABEL] = None
        self.act("pause")
        code, body = self.act("run")
        self.assertEqual(code, 409)
        self.assertIn("paused", body["error"]["detail"])

    def test_run_refuses_a_routine_launchd_does_not_hold(self) -> None:
        self.assertEqual(self.act("run")[0], 409)
        self.assertEqual(self.launchd.calls, [])

    def test_pause_then_resume_converge_when_repeated(self) -> None:
        self.installed()
        code, body = self.act("pause")
        self.assertEqual((code, body["changed"], body["routine"]["paused"], body["routine"]["result"]),
                         (200, True, True, "paused"))
        self.assert_paused()
        self.assertEqual(self.act("pause")[1]["changed"], False)
        self.assert_paused()
        code, body = self.act("resume")
        self.assertEqual((code, body["changed"], body["routine"]["paused"]), (200, True, False))
        self.assert_resumed()
        self.assertEqual(self.act("resume")[1]["changed"], False)
        self.assert_resumed()
        self.assertEqual([c[0] for c in self.launchd.calls], ["bootout", "bootstrap"])
        self.assertEqual(self.launchd.calls[1], ("bootstrap", "gui/501", str(self.active)))

    def test_pause_finishes_whatever_an_interrupted_pause_left(self) -> None:
        """Booted out but not yet parked; parked by a copy that never unlinked; parked by hand
        while still loaded. Each ends paused."""
        for case in ("unloaded, not parked", "copied, not unlinked", "parked, still loaded"):
            with self.subTest(case=case):
                self.parked.parent.mkdir(parents=True, exist_ok=True)
                if case == "unloaded, not parked":
                    self.active.write_text("<plist/>")
                    self.launchd.loaded.pop(LABEL, None)
                elif case == "copied, not unlinked":
                    self.active.write_text("<plist/>")
                    self.parked.write_text("<plist/>")
                    self.launchd.loaded[LABEL] = None
                else:
                    self.active.unlink(missing_ok=True)
                    self.parked.write_text("<plist/>")
                    self.launchd.loaded[LABEL] = None
                code, body = self.act("pause")
                self.assertEqual((code, body["changed"]), (200, True), body)
                self.assert_paused()

    def test_resume_finishes_whatever_an_interrupted_resume_left(self) -> None:
        for case in ("moved back, not loaded", "in both places"):
            with self.subTest(case=case):
                self.launchd.loaded.pop(LABEL, None)
                self.active.write_text("<plist/>")
                if case == "in both places":
                    self.parked.parent.mkdir(parents=True, exist_ok=True)
                    self.parked.write_text("<plist/>")
                code, body = self.act("resume")
                self.assertEqual((code, body["changed"]), (200, True), body)
                self.assert_resumed()

    def test_resume_retries_while_launchd_is_still_tearing_down(self) -> None:
        self.installed()
        self.act("pause")
        self.launchd.refuse_bootstraps = 2
        self.assertEqual(self.act("resume")[0], 200)
        self.assert_resumed()
        self.launchd.refuse_bootstraps = control.BOOTSTRAP_TRIES
        self.act("pause")
        code, body = self.act("resume")
        self.assertEqual(code, 502)
        self.assertTrue(self.active.is_file())
        self.assertEqual(self.act("resume")[0], 200)

    def test_a_launchctl_that_fails_to_answer_changes_nothing(self) -> None:
        """`launchctl list` answers empty when it fails, which would read as unloaded and
        park a plist launchd still fires. Each job is asked with `print` instead."""
        self.installed()
        self.launchd.broken = True
        for action in ("run", "pause", "resume"):
            with self.subTest(action=action):
                self.assertEqual(self.act(action)[0], 502)
        self.assertTrue(self.active.is_file())
        self.assertFalse(self.parked.exists())
        self.assertEqual(self.launchd.calls, [])

    def test_pause_refuses_a_running_routine_and_one_with_no_plist(self) -> None:
        self.assertEqual(self.act("pause")[0], 409)
        self.installed()
        self.launchd.loaded[LABEL] = 4242
        code, body = self.act("pause")
        self.assertEqual(code, 409)
        self.assertTrue(self.active.is_file())
        self.assertEqual(self.launchd.calls, [])

    def test_only_a_routine_in_models_json_is_driven(self) -> None:
        for name in ("dashboard", "caffeinate", "nope", "capture-x"):
            for action in ("run", "pause", "resume"):
                with self.subTest(name=name, action=action):
                    self.assertEqual(self.act(action, name)[0], 404)
        for path in ("/api/routines/capture/stop", "/api/routines/Capture/run", "/api/routines/capture;id/run"):
            with self.subTest(path=path):
                self.assertEqual(post(path)[0], 404)
        self.assertEqual(self.launchd.calls, [])


class GateTest(WriteTest):
    """Every write row sits behind the same gate as the passkey rows."""

    WRITES = ("/api/ideas", f"/api/ideas/{IDEA}/status", f"/api/ideas/{IDEA}/due",
              "/api/routines/capture/run", "/api/routines/capture/pause", "/api/routines/capture/resume")

    def test_every_write_row_has_a_sample_here(self) -> None:
        rows = [r for r in routes.ROUTES if r.method == "POST"]
        for row in rows:
            self.assertTrue([p for p in self.WRITES if row.pattern.match(p)], row.pattern.pattern)
        for path in self.WRITES:
            self.assertEqual(app.reach_of(app.Request("POST", path, {}, b"", "127.0.0.1", 8642), routes.ROUTES),
                             "tailnet")

    def test_a_foreign_origin_or_a_cross_site_fetch_writes_nothing(self) -> None:
        before = (self.notes(), self.subjects())
        for path in self.WRITES:
            for headers in ({"origin": "https://evil.example"}, {"origin": "null"},
                            {"origin": None, "sec-fetch-site": "cross-site"}):
                with self.subTest(path=path, headers=headers):
                    sent = {k: v for k, v in headers.items() if v is not None}
                    request = app.Request("POST", path, {"host": "127.0.0.1:8642", **sent},
                                          b'{"title": "x", "status": "done", "due": null}', "127.0.0.1", 8642)
                    with self.assertRaises(app.ApiError) as caught:
                        app.dispatch(request, routes.ROUTES)
                    self.assertEqual(caught.exception.status, 403)
        self.assertEqual((self.notes(), self.subjects()), before)

    def test_over_the_tailnet_a_write_needs_a_session(self) -> None:
        signed_in = False
        gate = app.Tailnet(host=TAILNET_HOST, session_ok=lambda r: signed_in)

        def knock() -> app.Response:
            request = app.Request("POST", "/api/ideas", {"host": TAILNET_HOST, "origin": "https://" + TAILNET_HOST},
                                  b'{"title": "From the phone"}', "127.0.0.1", 8642, door="tailnet")
            return app.dispatch(request, routes.ROUTES, gate)

        with self.assertRaises(app.ApiError) as caught:
            knock()
        self.assertEqual(caught.exception.status, 401)
        signed_in = True
        self.assertEqual(knock().status, 201)

    def test_a_log_line_names_the_route_and_not_the_idea(self) -> None:
        """Over a real socket, so the line checked is the one the handler writes."""
        server = app.make_server("127.0.0.1", 0, routes.ROUTES)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        logged = io.StringIO()
        with mock.patch("sys.stderr", logged):
            for path, body in (("/api/ideas", {"title": "Ring Alex Reed about the Lisbon deposit"}),
                               (f"/api/ideas/{IDEA}/status", {"status": "done"})):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                conn.request("POST", path, json.dumps(body),
                             {"Origin": f"http://127.0.0.1:{port}", "Content-Type": "application/json"})
                self.assertIn(conn.getresponse().status, (200, 201))
                conn.close()
        text = logged.getvalue()
        self.assertIn("/api/ideas/-/status", text)
        self.assertIn('"POST /api/ideas HTTP/1.1" 201', text)
        for leak in ("desk-lamp", "Lisbon", "Alex"):
            self.assertNotIn(leak, text)


if __name__ == "__main__":
    unittest.main()
