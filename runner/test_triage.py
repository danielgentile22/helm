"""Fix sessions against a temp state folder, a copy of the demo vault and a recording starter.
The real starter runs only against fake `t3` and `claude` scripts in a temp folder.

    python3 -m unittest discover -s runner -p 'test_triage.py'
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import alerts
import common
import triage
from test_alerts import REGISTRY, AlertTest

DETAILED = {
    **REGISTRY,
    "routines": {
        **REGISTRY["routines"],
        "backup": {**REGISTRY["routines"]["backup"], "project": "helm",
                   "does": "Copies the vault to the backup drive.",
                   "why": "The vault has no remote.", "writes": "the backup folder"},
    },
    "services": {"dashboard": {"project": "helm", "does": "Serves the dashboard.",
                               "command": ["dashboard/serve.py", "--no-open"]}},
}


class TriageTest(AlertTest):
    def setUp(self) -> None:
        super().setUp()
        (self.state / "triage").mkdir(parents=True)
        (self.state / "triage" / "enabled").write_text("")

    def world(self) -> alerts.World:
        return alerts.World(DETAILED, self.jobs, self.state, self.vault, self.now, lambda: self.up)

    def fail_backup(self, result: str = "volume absent") -> None:
        self.status("backup", {"ran": alerts.stamp(self.now), "result": result})

    def ledger(self) -> dict[str, dict]:
        day = self.state / "triage" / self.now.date().isoformat()
        return {json.loads(p.read_text())["key"]: json.loads(p.read_text()) for p in day.glob("*.json")}

    def quietly(self) -> str:
        err = io.StringIO()
        with redirect_stderr(err):
            self.run_once()
        return err.getvalue()


class StartTest(TriageTest):
    def test_nothing_starts_without_the_enabled_file(self) -> None:
        (self.state / "triage" / "enabled").unlink()
        self.fail_backup()
        self.run_once()
        self.assertEqual(self.start.requests, [])
        self.assertIsNone(self.files()["routine:backup"]["session"])
        self.assertEqual(list((self.state / "triage").iterdir()), [])

    def test_a_failed_routine_starts_one_session_recorded_on_the_alert_and_the_ledger(self) -> None:
        self.fail_backup()
        self.run_once()
        [request] = self.start.requests
        self.assertEqual((request.key, request.title), ("routine:backup", "backup failed: volume absent"))
        self.assertEqual(request.project, common.ENGINE)
        self.assertEqual(self.files()["routine:backup"]["session"], "https://t3.example/thread/1")
        entry = self.ledger()["routine:backup"]
        self.assertEqual(entry, {"key": "routine:backup", "fingerprint": "volume absent",
                                 "started": alerts.stamp(self.now), "via": "t3",
                                 "session": "https://t3.example/thread/1"})
        self.assertEqual(request.file(".md").read_text(), request.brief)

        before = {p.name: p.read_text() for p in (self.state / "alerts").glob("*.json")}
        self.now += timedelta(minutes=30)
        self.run_once()
        self.assertEqual(len(self.start.requests), 1)
        self.assertEqual({p.name: p.read_text() for p in (self.state / "alerts").glob("*.json")}, before)

    def test_ci_ideas_and_dismissed_alerts_start_nothing(self) -> None:
        self.github([{"number": 12, "author": "jordan", "ci": "fail"}])
        self.status("integrity-check", {"result": "fail", "failures": 2, "last_run": alerts.stamp(self.now)})
        (self.state / "triage" / "enabled").unlink()
        self.run_once()
        alerts.dismiss("routine:integrity-check", self.now)
        (self.state / "triage" / "enabled").write_text("")
        self.now = self.now.replace(month=10, day=2)
        for name in REGISTRY["routines"]:
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.status("integrity-check", {"result": "fail", "failures": 2, "last_run": alerts.stamp(self.now)})
        self.run_once()
        self.assertIn("ci:keel#12", self.shown())
        self.assertTrue(any(k.startswith("idea:") for k in self.shown()))
        self.assertEqual(self.start.requests, [])

    def test_quiet_routines_and_down_services_start_sessions(self) -> None:
        self.status("capture", {"result": "pass", "last_run": alerts.stamp(self.now - timedelta(hours=2))})
        self.up = False
        self.run_once()
        self.assertEqual(self.start.requests, [], "a blip waits for the settle time")
        self.now += timedelta(minutes=30)
        self.run_once()
        self.assertEqual({r.key for r in self.start.requests}, {"quiet:capture", "service:dashboard"})
        self.assertIsNotNone(self.files()["service:dashboard"]["session"])

    def test_a_new_fingerprint_the_same_day_gets_the_same_session_back(self) -> None:
        self.fail_backup()
        self.run_once()
        self.fail_backup("failed: vault bundle")
        self.now += timedelta(minutes=10)
        self.run_once()
        alert = self.files()["routine:backup"]
        self.assertEqual((alert["fingerprint"], alert["opened"]), ("vault bundle", alerts.stamp(self.now)))
        self.assertEqual(alert["session"], "https://t3.example/thread/1")
        self.assertEqual(len(self.start.requests), 1)

    def test_the_next_day_starts_a_new_session(self) -> None:
        self.fail_backup()
        self.run_once()
        self.now += timedelta(days=1)
        for name in ("capture", "integrity-check"):
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.fail_backup("failed: vault bundle")
        self.run_once()
        self.assertEqual(self.files()["routine:backup"]["session"], "https://t3.example/thread/2")

    def test_three_sessions_a_day_is_the_cap(self) -> None:
        self.fail_backup()
        self.status("integrity-check", {"result": "fail", "failures": 1, "last_run": alerts.stamp(self.now)})
        self.status("capture", {"result": "pass", "last_run": alerts.stamp(self.now - timedelta(hours=2))})
        self.up = False
        self.run_once()
        self.now += timedelta(minutes=30)
        err = self.quietly()
        self.assertEqual(len(self.start.requests), 3)
        self.assertEqual(len(self.ledger()), 3)
        self.assertEqual(sum(a["session"] is None for a in self.files().values()), 1)
        self.assertIn("3 fix sessions a day is the cap", err)
        self.assertEqual(err.count("\n"), 1)

    def test_a_start_that_fails_leaves_no_claim_and_is_tried_again(self) -> None:
        self.fail_backup()
        self.start.broken = True
        err = self.quietly()
        self.assertIn("no fix session for routine:backup", err)
        self.assertEqual(self.ledger(), {})
        self.assertEqual(list((self.state / "triage" / self.now.date().isoformat()).iterdir()), [])
        self.assertIsNone(self.files()["routine:backup"]["session"])
        self.start.broken = False
        self.run_once()
        self.assertEqual(self.files()["routine:backup"]["session"], "https://t3.example/thread/1")

    def test_an_alert_file_without_a_session_still_loads(self) -> None:
        path = alerts.path_of("routine:backup")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"key": "routine:backup", "tab": "background", "title": "backup failed",
                                    "opened": alerts.stamp(self.now), "fingerprint": "x", "pushed": None,
                                    "dismissed": None, "closed": None}))
        self.assertIsNone(alerts.load_all()["routine:backup"].session)


class BriefTest(TriageTest):
    def test_the_brief_carries_what_the_job_does_its_status_and_its_log_tail(self) -> None:
        self.fail_backup()
        logs = self.state / "logs"
        logs.mkdir(parents=True)
        (logs / "com.helm.backup.err").write_text("".join(f"old line {i}\n" for i in range(100)) + "cannot write Priya's drive\n")
        self.jobs["com.helm.backup"] = alerts.machine.LaunchdJob("com.helm.backup", None, 1)
        self.run_once()
        text = self.start.requests[0].brief
        self.assertIn("Copies the vault to the backup drive.", text)
        self.assertIn('"result": "volume absent"', text)
        self.assertIn("cannot write Priya's drive", text)
        self.assertNotIn("old line 20\n", text)
        self.assertIn("old line 99", text)
        self.assertIn("com.helm.backup.out` does not exist.", text)
        self.assertIn("launchctl kickstart -k gui/$(id -u)/com.helm.backup", text)
        self.assertIn("runner/routines/backup.sh", text)
        self.assertIn("pid none, last exit 1", text)
        self.assertIn("The owner is away", text)
        self.assertNotIn("\u2014", text)
        self.assertNotIn("\u2013", text)

    def test_a_status_that_names_a_report_says_to_read_it(self) -> None:
        self.status("integrity-check", {"result": "fail", "failures": 1, "last_run": alerts.stamp(self.now),
                                        "report": "~/Vault/Inbox/runs/integrity/2026-09-20.md"})
        self.run_once()
        self.assertIn("Read `~/Vault/Inbox/runs/integrity/2026-09-20.md` first.", self.start.requests[0].brief)

    def test_a_service_brief_names_its_command(self) -> None:
        self.up = False
        self.run_once()
        self.now += timedelta(minutes=30)
        self.run_once()
        text = self.start.requests[0].brief
        self.assertIn("Command: `dashboard/serve.py --no-open`", text)
        self.assertIn("This service is down.", text)


LATER = datetime(2026, 9, 20, 13, 0, tzinfo=timezone.utc)


class PlanTest(unittest.TestCase):
    def alert(self, key: str, **kw: object) -> alerts.Alert:
        return alerts.Alert(key, "background", key, kw.pop("opened", "2026-09-20T12:00:00Z"), "f", **kw)  # type: ignore[arg-type]

    def test_only_visible_job_alerts_without_a_session_are_candidates(self) -> None:
        found = [self.alert("routine:a"), self.alert("idea:abc"), self.alert("ci:keel#1"),
                 self.alert("routine:b", dismissed="x"), self.alert("routine:c", closed="x"),
                 self.alert("service:d", session="https://t3.example/1")]
        self.assertEqual(triage.plan(found, {}, LATER), triage.Plan({}, ("routine:a",), ()))

    def test_a_claim_still_starting_is_neither_reattached_nor_started_again(self) -> None:
        ledger = {"routine:a": triage.Entry("routine:a", "f", "t")}
        self.assertEqual(triage.plan([self.alert("routine:a")], ledger, LATER), triage.Plan({}, (), ()))

    def test_a_service_or_quiet_alert_waits_out_its_settle_time_and_a_failure_does_not(self) -> None:
        found = [self.alert("routine:a", opened="2026-09-20T12:58:00Z"),
                 self.alert("service:b", opened="2026-09-20T12:58:00Z"),
                 self.alert("quiet:c", opened="2026-09-20T12:50:00Z")]
        self.assertEqual(triage.plan(found, {}, LATER), triage.Plan({}, ("quiet:c", "routine:a"), ()))

    def test_the_cap_counts_today_s_ledger_and_this_pass(self) -> None:
        ledger = {"quiet:x": triage.Entry("quiet:x", "f", "t", "t3", "s")}
        found = [self.alert(f"routine:{n}", opened=f"2026-09-20T12:0{i}:00Z") for i, n in enumerate("abc")]
        self.assertEqual(triage.plan(found, ledger, LATER), triage.Plan({}, ("routine:a", "routine:b"), ("routine:c",)))


class ProjectTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_helm_or_no_project_is_the_engine(self) -> None:
        self.assertEqual(triage.project_root("helm", {}), common.ENGINE)
        self.assertEqual(triage.project_root(None, {}), common.ENGINE)

    def test_a_root_variable_wins_and_dashes_become_underscores(self) -> None:
        (self.root / "trip").mkdir()
        self.assertEqual(triage.project_root("lisbon-trip", {"LISBON_TRIP_ROOT": str(self.root / "trip")}),
                         self.root / "trip")

    def test_the_projects_folder_is_the_default_and_a_missing_one_falls_back_to_the_engine(self) -> None:
        (self.root / "keel").mkdir()
        with mock.patch.object(common, "PROJECTS_DIR", self.root):
            self.assertEqual(triage.project_root("keel", {}), self.root / "keel")
            self.assertEqual(triage.project_root("compiler", {}), common.ENGINE)
            self.assertEqual(triage.project_root("keel", {"KEEL_ROOT": str(self.root / "gone")}), common.ENGINE)


def script(path: Path, body: str) -> Path:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


class StarterTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.project = self.root / "keel"
        self.project.mkdir()
        self.request = triage.Request("routine:capture", "capture failed", "# Fix: capture failed\n",
                                      self.project, self.root / "ledger")
        self.err = io.StringIO()
        self.enterContext(redirect_stderr(self.err))

    def launch(self, **env: str) -> triage.Started | None:
        with mock.patch.dict(os.environ, env):
            return triage.launch(self.request, "f", "2026-09-20T12:00:00Z", triage.start)

    def entry(self) -> dict:
        return json.loads(self.request.file(".json").read_text())

    def test_t3_comes_first_and_its_link_is_the_session(self) -> None:
        t3 = script(self.bin / "t3", f'printf "%s\\n" "$@" > {self.root}/argv\ncat > {self.root}/stdin\n'
                                     'echo \'{"threadId": "th_1", "link": "https://t3.example/th_1"}\'\n')
        started = self.launch(HELM_T3_BIN=str(t3), HELM_CLAUDE_BIN=str(self.bin / "missing"))
        self.assertEqual(started, triage.Started("t3", "https://t3.example/th_1"))
        self.assertEqual((self.root / "argv").read_text().splitlines(),
                         ["thread", "start", "--json", "--provider", "claudeAgent", "--model", "claude-opus-5-5",
                          "--title", "Fix: capture failed", str(self.project), "-"])
        self.assertEqual((self.root / "stdin").read_text(), self.request.brief)
        self.assertEqual((self.entry()["via"], self.entry()["session"]), ("t3", "https://t3.example/th_1"))

    def test_a_thread_id_is_looked_up_in_the_thread_list_for_its_link(self) -> None:
        t3 = script(self.bin / "t3", 'if [ "$2" = list ]; then echo \'[{"threadId": "x"}, {"threadId": "th_3", '
                                     '"link": "https://t3.example/th_3"}]\'; exit 0; fi\n'
                                     'cat >/dev/null\necho \'{"threadId": "th_3"}\'\n')
        self.assertEqual(self.launch(HELM_T3_BIN=str(t3), HELM_CLAUDE_BIN=str(self.bin / "missing")),
                         triage.Started("t3", "https://t3.example/th_3"))

    def test_a_thread_id_alone_is_the_session_when_there_is_no_link(self) -> None:
        t3 = script(self.bin / "t3", 'cat >/dev/null\necho \'{"threadId": "th_2"}\'\n')
        self.assertEqual(self.launch(HELM_T3_BIN=str(t3), HELM_CLAUDE_BIN=str(self.bin / "missing")),
                         triage.Started("t3", "th_2"))

    def test_without_t3_a_detached_claude_run_logs_into_the_ledger(self) -> None:
        t3 = script(self.bin / "t3", "cat >/dev/null\necho 'not json'\n")
        claude = script(self.bin / "claude", f'printf "%s\\n" "$@" > {self.root}/argv\n'
                                             f'echo "$HELM_NO_SESSION_NOTE $(pwd -P)" > {self.root}/env\n'
                                             'cat\necho done\n')
        started = self.launch(HELM_T3_BIN=str(t3), HELM_CLAUDE_BIN=str(claude))
        log = self.request.file(".log")
        self.assertEqual(started, triage.Started("claude", triage.short(log)))
        self.assertEqual(self.entry()["via"], "claude")
        deadline = time.monotonic() + 5
        while "done" not in (log.read_text() if log.exists() else "") and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(log.read_text(), self.request.brief + "done\n")
        self.assertEqual((self.root / "argv").read_text().splitlines(),
                         ["-p", "--model", "opus", "--effort", "high", "--dangerously-skip-permissions"])
        self.assertEqual((self.root / "env").read_text().split(), ["1", str(self.project.resolve())])
        self.assertIn("T3 is unavailable", self.err.getvalue())

    def test_when_neither_can_start_the_claim_is_taken_back(self) -> None:
        self.assertIsNone(self.launch(HELM_T3_BIN=str(self.bin / "no-t3"), HELM_CLAUDE_BIN=str(self.bin / "no-claude")))
        self.assertEqual(list(self.request.ledger.iterdir()), [])

    def test_the_policy_refuses_haiku_and_effort_above_high(self) -> None:
        policy = json.loads((common.ENGINE / "models.json").read_text())["policy"]
        self.assertEqual(triage.settings(), ("opus", "high"))
        for model, effort in (("haiku", "high"), ("opus", "max")):
            with self.assertRaises(ValueError):
                triage.settings({"policy": policy, "on_alert": {"triage": {"model": model, "effort": effort}}})


if __name__ == "__main__":
    unittest.main()
