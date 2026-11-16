"""The desk's two reads, `/api/machine/usage` and `/api/t3/threads`, through `dispatch`.

T3 is a stub: `t3.issue_session` and `t3.post` are replaced the way `machine.usage` is in
test_tabs.py, so nothing here asks the T3 or the Mac the suite runs on. Every title is
fictional, from the demo vault's cast.

    python3 -m unittest dashboard/server/test_desk.py
"""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app  # noqa: E402
import machine  # noqa: E402
import pulse  # noqa: E402
import routes  # noqa: E402
import t3  # noqa: E402

# The real one, kept before any test replaces it.
ISSUE_SESSION = t3.issue_session
LISBON = "Book the Lisbon flights for Jordan and Priya"


def get(path: str, query: str = "") -> tuple[int, dict]:
    request = app.Request(method="GET", path=path, headers={"host": "127.0.0.1:8642"}, body=b"",
                          peer="127.0.0.1", port=8642, query=query)
    out = app.dispatch(request, routes.ROUTES)
    return out.status, json.loads(out.body)


def thread(tid: str, status: str, title: str, project: str = "p-keel", updated: str = "2026-11-16T10:00:00.000Z",
           run: str | None = None) -> dict:
    return {"threadId": tid, "projectId": project, "title": title, "status": status,
            "latestRunId": run, "createdAt": "2026-11-16T09:00:00.000Z", "updatedAt": updated,
            "settled": False, "snoozed": False}


class FakeT3:
    """T3's `/mcp`, as far as the desk talks to it: initialize, three tools, and a refusal
    for anything else, which is what a read-only session gets for a write."""

    def __init__(self) -> None:
        self.active: list[dict] = []
        self.finished: list[dict] = []
        self.runs: dict[str, dict] = {}
        self.calls: list[tuple[str, dict]] = []
        self.issued = 0
        self.refuse_next = False

    def issue(self) -> t3.Session:
        self.issued += 1
        return t3.Session(f"session-{self.issued}", f"token-{self.issued}", time.monotonic())

    def post(self, url: str, token: str, body: dict, session_id: str | None) -> tuple[dict, str | None]:
        if self.refuse_next:
            self.refuse_next = False
            raise t3.Unauthorized()
        if body["method"] == "initialize":
            return {"jsonrpc": "2.0", "id": body["id"], "result": {"protocolVersion": t3.PROTOCOL}}, "mcp-1"
        name, args = body["params"]["name"], body["params"]["arguments"]
        self.calls.append((name, args))
        if name == "t3_project_list":
            content = {"projects": [{"id": "p-keel", "title": "Keel", "workspaceRoot": "/x"},
                                    {"id": "p-compiler", "title": "Compiler", "workspaceRoot": "/y"}],
                       "nextCursor": None}
        elif name == "t3_thread_list":
            pool = self.finished if "completed" in args["statuses"] else self.active
            content = {"threads": pool[: args["limit"]], "nextCursor": None, "total": len(pool)}
        elif name == "t3_thread_read":
            content = {"thread": {}, "recentRuns": [self.runs[args["threadId"]]]}
        else:
            return {"jsonrpc": "2.0", "id": body["id"], "result": {"isError": True, "content": [
                {"type": "text", "text": '{"code":"capability_denied"}'}]}}, session_id
        return {"jsonrpc": "2.0", "id": body["id"], "result": {"structuredContent": content}}, session_id


class T3Test(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.runtime = Path(tmp.name) / "server-runtime.json"
        self.runtime.write_text(json.dumps({"origin": "http://127.0.0.1:3773", "port": 3773, "pid": None}))
        self.fake = FakeT3()
        for name, value in (("issue_session", self.fake.issue), ("post", self.fake.post), ("RUNTIME", self.runtime)):
            self.addCleanup(setattr, t3, name, getattr(t3, name))
            setattr(t3, name, value)
        self.addCleanup(setattr, t3, "READER", t3.READER)
        t3.READER = t3.Reader()

    def test_threads_are_split_into_running_waiting_and_finished_with_project_names(self) -> None:
        self.fake.active = [thread("t1", "running", "Tune the Keel parser", run="r1"),
                            thread("t2", "waiting", LISBON, project="p-compiler", run="r2"),
                            thread("t3", "queued", "Sam's grammar idea", run="r3")]
        self.fake.runs = {"t1": {"runId": "r1", "startedAt": "2026-11-16T09:30:00.000Z"},
                          "t2": {"runId": "r2", "startedAt": "2026-11-16T09:50:00.000Z"},
                          "t3": {"runId": "r3", "startedAt": None, "requestedAt": "2026-11-16T09:10:00.000Z"}}
        self.fake.finished = [thread("t4", "completed", "Alex Reed's review", updated="2026-11-16T08:00:00.000Z"),
                              thread("t5", "failed", "Compiler build", updated="2026-11-16T09:00:00.000Z"),
                              thread("t6", "interrupted", "Keel docs", updated="2026-11-16T07:00:00.000Z")]
        status, body = get("/api/t3/threads")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "ok")
        self.assertEqual([t["id"] for t in body["running"]], ["t3", "t1"])
        self.assertEqual(body["running"][1]["started"], "2026-11-16T09:30:00.000Z")
        self.assertEqual(body["running"][0]["started"], "2026-11-16T09:10:00.000Z")
        self.assertEqual([(t["id"], t["project"], t["title"]) for t in body["waiting"]], [("t2", "Compiler", LISBON)])
        self.assertEqual([(t["id"], t["outcome"]) for t in body["finished"]],
                         [("t5", "failed"), ("t4", "done"), ("t6", "stopped")])
        self.assertIn("checked", body)

    def test_only_the_three_read_tools_are_called_and_each_run_is_read_once(self) -> None:
        self.fake.active = [thread("t1", "running", "Tune the Keel parser", run="r1")]
        self.fake.runs = {"t1": {"runId": "r1", "startedAt": "2026-11-16T09:30:00.000Z"}}
        get("/api/t3/threads")
        t3.READER.cached = None
        get("/api/t3/threads")
        names = [n for n, _ in self.fake.calls]
        self.assertTrue(set(names) <= {"t3_thread_list", "t3_project_list", "t3_thread_read"})
        self.assertEqual(names.count("t3_thread_read"), 1)
        self.assertEqual(names.count("t3_project_list"), 1)
        read = dict(self.fake.calls)["t3_thread_read"]
        self.assertEqual((read["limit"], read["runLimit"], read["maxCharsPerItem"]), (1, 1, 1))
        listed = [a for n, a in self.fake.calls if n == "t3_thread_list"]
        self.assertTrue(all(a["allProjects"] and not a["includeSubagents"] for a in listed))

    def test_a_finished_thread_is_never_read(self) -> None:
        self.fake.finished = [thread("t4", "completed", "Alex Reed's review", run="r4")]
        get("/api/t3/threads")
        self.assertNotIn("t3_thread_read", [n for n, _ in self.fake.calls])

    def test_answers_are_cached_for_a_few_seconds(self) -> None:
        get("/api/t3/threads")
        before = len(self.fake.calls)
        get("/api/t3/threads")
        self.assertEqual(len(self.fake.calls), before)

    def test_a_refused_session_is_reissued_once(self) -> None:
        self.fake.refuse_next = True
        status, body = get("/api/t3/threads")
        self.assertEqual(body["state"], "ok")
        self.assertEqual(self.fake.issued, 2)

    def test_no_runtime_file_is_not_running_and_never_issues_a_session(self) -> None:
        self.runtime.unlink()
        status, body = get("/api/t3/threads")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "not_running")
        self.assertEqual((body["running"], body["waiting"], body["finished"]), ([], [], []))
        self.assertEqual(self.fake.issued, 0)

    def test_a_dead_pid_is_not_running(self) -> None:
        self.runtime.write_text(json.dumps({"origin": "http://127.0.0.1:3773", "pid": 2 ** 22 + 12345}))
        self.assertEqual(get("/api/t3/threads")[1]["state"], "not_running")

    def test_an_unreachable_server_says_so(self) -> None:
        def refused(*args: object) -> tuple[dict, str | None]:
            raise t3.T3Error("unreachable", "T3 Code is not answering (ConnectionRefusedError)")
        t3.post = refused
        self.assertEqual(get("/api/t3/threads")[1]["state"], "unreachable")

    def test_a_failure_never_puts_a_title_in_the_log(self) -> None:
        self.fake.active = [thread("t1", "running", LISBON, run="r1")]
        self.fake.runs = {}  # the read raises KeyError inside the fake
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            status, body = get("/api/t3/threads")
        self.assertNotIn("Lisbon", err.getvalue())
        self.assertNotIn("Lisbon", json.dumps({k: v for k, v in body.items() if k != "running"}))

    def test_the_session_comes_from_the_cli_with_only_the_read_scope(self) -> None:
        seen: list[list[str]] = []

        class Done:
            returncode = 0
            stdout = json.dumps({"sessionId": "s", "token": "tok", "scopes": ["orchestration:read"]})

        def run(argv: list[str], **kw: object) -> Done:
            seen.append(argv)
            return Done()

        for name, value in (("run", run),):
            self.addCleanup(setattr, subprocess, name, getattr(subprocess, name))
            setattr(subprocess, name, value)
        self.addCleanup(setattr, t3, "CLI", t3.CLI)
        t3.CLI = self.runtime  # any file that exists
        session = ISSUE_SESSION()
        self.assertEqual(session.token, "tok")
        argv = seen[0]
        self.assertEqual(argv[1:4], ["auth", "session", "issue"])
        self.assertEqual(argv[argv.index("--subject") + 1], "mcp-client")
        self.assertEqual([argv[i + 1] for i, a in enumerate(argv) if a == "--scope"], ["orchestration:read"])


class UsageTest(unittest.TestCase):
    def setUp(self) -> None:
        ticks = iter([(100, 50, 850, 0), (160, 70, 870, 0)])
        for module, name, value in ((machine, "cpu_ticks", lambda: next(ticks, (160, 70, 870, 0))),
                                    (machine, "gpu_now", lambda: 0.62),
                                    (machine, "memory_now", lambda: 48),
                                    (pulse, "_total", 64)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)
        self.addCleanup(pulse._points.clear)
        pulse._points.clear()

    def test_a_sample_is_three_shares(self) -> None:
        point, after = pulse.sample(machine.cpu_ticks(), 1_763_300_000.25)
        self.assertEqual(point, {"at": "2025-11-16T13:33:20.250Z", "cpu": 0.8, "gpu": 0.62, "memory": 0.75})
        self.assertEqual(after, (160, 70, 870, 0))

    def test_since_returns_only_newer_points(self) -> None:
        for at in ("2026-11-16T10:00:00.000Z", "2026-11-16T10:00:02.000Z", "2026-11-16T10:00:04.000Z"):
            pulse._points.append({"at": at, "cpu": 0.1, "gpu": 0.2, "memory": 0.3})
        pulse._running = True  # no sampler thread in the tests
        self.addCleanup(setattr, pulse, "_running", False)
        status, body = get("/api/machine/usage", "since=2026-11-16T10:00:02.000Z")
        self.assertEqual(status, 200)
        self.assertEqual([p["at"] for p in body["points"]], ["2026-11-16T10:00:04.000Z"])
        self.assertEqual((body["interval_s"], body["window_s"], body["memory_total"]), (2.0, 300.0, 64))
        self.assertEqual(len(get("/api/machine/usage")[1]["points"]), 3)

    def test_a_malformed_since_is_400(self) -> None:
        pulse._running = True
        self.addCleanup(setattr, pulse, "_running", False)
        status, body = get("/api/machine/usage", "since=yesterday")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")


class ReachTest(unittest.TestCase):
    def test_both_desk_reads_are_tailnet_rows(self) -> None:
        for path in ("/api/machine/usage", "/api/t3/threads"):
            request = app.Request(method="GET", path=path, headers={}, body=b"", peer="127.0.0.1", port=8642)
            self.assertEqual(app.reach_of(request, routes.ROUTES), "tailnet")


if __name__ == "__main__":
    unittest.main()
