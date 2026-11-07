"""Alert evaluation against a temp state folder, a copy of the demo vault, a made-up launchd
and a recording sender and starter. Nothing here asks the machine, sends a push or starts
a session.

    python3 -m unittest discover -s runner -p 'test_alerts.py'
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import alerts
import common
import triage
from machine import LaunchdJob

DEMO = common.ENGINE / "demo-vault"
TZ = ZoneInfo("America/New_York")
REGISTRY = {
    "routines": {
        "backup": {"schedule": "daily 09:00 and on mount"},
        "capture": {"schedule": "every 30m"},
        "integrity-check": {"schedule": "daily 07:00"},
    },
    "services": {"dashboard": {}},
}
RUNNING = {f"com.helm.{n}": LaunchdJob(f"com.helm.{n}", None, 0) for n in REGISTRY["routines"]}
RUNNING["com.helm.dashboard"] = LaunchdJob("com.helm.dashboard", 101, None)


class Sender:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, int]] = []
        self.broken = False

    def __call__(self, title: str, tab: str, count: int) -> None:
        if self.broken:
            raise RuntimeError("push service unreachable")
        self.sent.append((title, tab, count))


class Starter:
    def __init__(self) -> None:
        self.requests: list[triage.Request] = []
        self.broken = False

    def __call__(self, request: triage.Request) -> triage.Started:
        if self.broken:
            raise RuntimeError("T3 and claude both missing")
        self.requests.append(request)
        return triage.Started("t3", f"https://t3.example/thread/{len(self.requests)}")


class AlertTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.state = root / "state"
        self.vault = root / "vault"
        shutil.copytree(DEMO, self.vault)
        self.addCleanup(setattr, common, "STATE", common.STATE)
        common.STATE = self.state
        # Before every demo idea is due, so the idea source is quiet unless a test asks.
        self.now = datetime(2026, 9, 20, 12, 0, tzinfo=TZ)
        self.jobs = dict(RUNNING)
        self.up = True
        self.send = Sender()
        self.start = Starter()
        for name in REGISTRY["routines"]:
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now - timedelta(minutes=5))})

    def status(self, name: str, doc: dict) -> None:
        path = self.state / "status" / f"{name}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc))

    def github(self, prs: list[dict], ok: bool = True) -> None:
        path = self.state / "status" / "sources" / "github.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"meta": {"ok": ok}, "items": [
            {"repo": "example/keel", "viewer": "jordan", "pull_requests": prs, "issues": None}]}))

    def world(self) -> alerts.World:
        return alerts.World(REGISTRY, self.jobs, self.state, self.vault, self.now, lambda: self.up)

    def run_once(self, sources: dict | None = None) -> list[str]:
        return alerts.evaluate(self.world(), sources or alerts.SOURCES, self.send, self.start)

    def files(self) -> dict[str, dict]:
        return {json.loads(p.read_text())["key"]: json.loads(p.read_text())
                for p in (self.state / "alerts").glob("*.json")}

    def shown(self) -> set[str]:
        return {a.key for a in alerts.visible()}


class KindsTest(AlertTest):
    def test_nothing_wrong_writes_no_alert_and_pushes_nothing(self) -> None:
        self.run_once()
        self.assertEqual(self.files(), {})
        self.assertEqual(self.send.sent, [])

    def test_a_failed_routine_opens_with_its_result_and_closes_when_it_passes(self) -> None:
        self.status("backup", {"ran": alerts.stamp(self.now), "result": "volume absent", "last_success": 0})
        self.status("integrity-check", {"result": "fail", "failures": 4, "last_run": alerts.stamp(self.now)})
        self.run_once()
        files = self.files()
        self.assertEqual(files["routine:backup"]["title"], "backup failed: volume absent")
        self.assertEqual(files["routine:backup"]["fingerprint"], "volume absent")
        self.assertEqual(files["routine:backup"]["tab"], "background")
        self.assertEqual(files["routine:integrity-check"]["title"], "integrity-check failed: 4 problems")
        self.assertEqual(alerts.counts(alerts.visible())["background"], 2)

        self.status("backup", {"ran": alerts.stamp(self.now), "result": "ok", "last_success": 1})
        self.now += timedelta(minutes=10)
        self.run_once()
        self.assertEqual(self.files()["routine:backup"]["closed"], alerts.stamp(self.now))
        self.assertEqual(self.shown(), {"routine:integrity-check"})

    def test_a_result_that_carries_a_path_stays_out_of_the_title(self) -> None:
        self.status("backup", {"ran": alerts.stamp(self.now), "result": "failed: cannot write /Volumes/Drive/x"})
        self.run_once()
        self.assertEqual(self.files()["routine:backup"]["title"], "backup failed")

    def test_a_quiet_routine_opens_after_twice_its_cadence_and_closes_when_it_runs(self) -> None:
        self.status("capture", {"result": "pass", "last_run": alerts.stamp(self.now - timedelta(minutes=59))})
        self.run_once()
        self.assertNotIn("quiet:capture", self.files())
        self.status("capture", {"result": "pass", "last_run": alerts.stamp(self.now - timedelta(minutes=61))})
        self.run_once()
        self.assertEqual(self.files()["quiet:capture"]["title"], "capture has gone quiet")
        self.status("capture", {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.run_once()
        self.assertIsNotNone(self.files()["quiet:capture"]["closed"])

    def test_a_paused_routine_never_alerts_and_pausing_closes_what_was_open(self) -> None:
        self.status("backup", {"ran": alerts.stamp(self.now - timedelta(days=5)), "result": "volume absent"})
        self.run_once()
        self.assertEqual(self.shown(), {"routine:backup", "quiet:backup"})
        (self.state / "disabled").mkdir(parents=True)
        (self.state / "disabled" / "com.helm.backup.plist").write_text("")
        self.run_once()
        self.assertEqual(self.shown(), set())

    def test_a_service_opens_when_not_loaded_not_running_or_not_answering(self) -> None:
        self.up = False
        self.jobs["com.helm.caffeinate"] = LaunchdJob("com.helm.caffeinate", None, 1)
        self.run_once()
        files = self.files()
        self.assertEqual(files["service:dashboard"]["title"], "dashboard is down: not answering")
        self.assertEqual(files["service:caffeinate"]["fingerprint"], "not running")
        del self.jobs["com.helm.dashboard"]
        self.run_once()
        self.assertEqual(self.files()["service:dashboard"]["fingerprint"], "not loaded")
        self.jobs["com.helm.dashboard"] = RUNNING["com.helm.dashboard"]
        self.jobs["com.helm.caffeinate"] = LaunchdJob("com.helm.caffeinate", 7, None)
        self.up = True
        self.run_once()
        self.assertEqual(self.shown(), set())

    def test_ci_alerts_only_on_the_owner_s_pull_requests_and_holds_while_pending(self) -> None:
        mine = {"number": 12, "author": "jordan", "ci": "fail"}
        self.github([mine, {"number": 13, "author": "priya", "ci": "fail"}])
        self.run_once()
        self.assertEqual(self.shown(), {"ci:keel#12"})
        self.assertEqual(self.files()["ci:keel#12"]["tab"], "projects")
        self.assertEqual(self.files()["ci:keel#12"]["title"], "CI fails on keel#12")
        self.github([{**mine, "ci": "pending"}])
        self.run_once()
        self.assertEqual(self.shown(), {"ci:keel#12"})
        self.github([{**mine, "ci": "pass"}])
        self.run_once()
        self.assertEqual(self.shown(), set())

    def test_ci_closes_when_the_pull_request_is_gone_but_not_while_github_is_failing(self) -> None:
        self.github([{"number": 12, "author": "jordan", "ci": "fail"}])
        self.run_once()
        self.github([], ok=False)
        self.run_once()
        self.assertEqual(self.shown(), {"ci:keel#12"})
        self.github([])
        self.run_once()
        self.assertEqual(self.shown(), set())

    def test_due_ideas_open_without_their_text_and_close_when_done_or_moved(self) -> None:
        self.now = datetime(2026, 10, 2, 9, 0, tzinfo=TZ)
        for name in REGISTRY["routines"]:
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.run_once()
        files = self.files()
        self.assertEqual(len(files), 2)
        for alert in files.values():
            self.assertEqual((alert["tab"], alert["title"]), ("ideas", "An idea is due"))
            self.assertRegex(alert["key"], r"^idea:[0-9a-f]{12}$")
        self.assertEqual(self.send.sent, [("2 ideas are due", "ideas", 2)])
        texts = " ".join(p.read_text() for p in (self.state / "alerts").glob("*.json"))
        self.assertNotIn("lisbon", texts.lower())
        self.assertNotIn("training", texts.lower())

        ideas = self.vault / "Atlas" / "Ideas"
        pricing, training = ideas / "2026-09-26-write-the-pricing-page-copy.md", ideas / "2026-09-26-finish-the-first-day-job-training-module.md"
        self.assertEqual(set(files), {alerts.idea_key(pricing.stem), alerts.idea_key(training.stem)})
        alerts.idea_edit.set_due(self.vault, pricing, "2026-12-01")
        self.run_once()
        self.assertEqual(self.shown(), {alerts.idea_key(training.stem)})
        alerts.idea_edit.set_status(self.vault, training, "done")
        self.run_once()
        self.assertEqual(self.shown(), set())


class LifecycleTest(AlertTest):
    def fail_backup(self, result: str = "volume absent") -> None:
        self.status("backup", {"ran": alerts.stamp(self.now), "result": result})

    def test_evaluating_twice_changes_nothing_and_pushes_once(self) -> None:
        self.fail_backup()
        self.assertEqual(self.run_once(), ["routine:backup"])
        before = {p.name: p.read_text() for p in (self.state / "alerts").glob("*.json")}
        self.now += timedelta(minutes=30)
        self.assertEqual(self.run_once(), [])
        self.assertEqual({p.name: p.read_text() for p in (self.state / "alerts").glob("*.json")}, before)
        self.assertEqual(self.send.sent, [("backup failed: volume absent", "background", 1)])

    def test_the_key_is_a_safe_file_name(self) -> None:
        self.github([{"number": 12, "author": "jordan", "ci": "fail"}])
        self.run_once()
        self.assertEqual([p.name for p in (self.state / "alerts").glob("*.json")], ["ci%3Akeel%2312.json"])

    def test_a_dismissed_alert_stays_hidden_until_its_fingerprint_changes(self) -> None:
        self.fail_backup()
        self.run_once()
        alert, changed = alerts.dismiss("routine:backup", self.now)
        self.assertTrue(changed)
        self.assertEqual(alerts.dismiss("routine:backup", self.now)[1], False)
        self.run_once()
        self.assertEqual(self.shown(), set())
        self.assertEqual(len(self.send.sent), 1)

        self.fail_backup("failed: vault bundle")
        self.now += timedelta(minutes=10)
        self.run_once()
        reopened = self.files()["routine:backup"]
        self.assertEqual((reopened["fingerprint"], reopened["dismissed"]), ("vault bundle", None))
        self.assertEqual(reopened["opened"], alerts.stamp(self.now))
        self.assertEqual(self.send.sent[-1], ("backup failed: vault bundle", "background", 1))

    def test_an_unknown_or_malformed_key_dismisses_nothing(self) -> None:
        self.assertIsNone(alerts.dismiss("routine:backup", self.now))
        self.assertIsNone(alerts.dismiss("../../etc/passwd", self.now))

    def test_a_condition_that_returns_after_closing_opens_again_and_pushes_again(self) -> None:
        self.fail_backup()
        self.run_once()
        self.status("backup", {"ran": alerts.stamp(self.now), "result": "ok"})
        self.run_once()
        self.fail_backup()
        self.run_once()
        self.assertEqual(self.shown(), {"routine:backup"})
        self.assertEqual(len(self.send.sent), 2)

    def test_a_closed_alert_is_deleted_after_a_week(self) -> None:
        self.fail_backup()
        self.run_once()
        self.status("backup", {"ran": alerts.stamp(self.now), "result": "ok"})
        self.run_once()
        self.now += timedelta(days=6)
        for name in ("capture", "integrity-check", "backup"):
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.run_once()
        self.assertIn("routine:backup", self.files())
        self.now += timedelta(days=1, minutes=1)
        for name in ("capture", "integrity-check", "backup"):
            self.status(name, {"result": "pass", "last_run": alerts.stamp(self.now)})
        self.run_once()
        self.assertEqual(self.files(), {})

    def test_a_failing_source_leaves_its_alerts_and_the_others_still_run(self) -> None:
        self.github([{"number": 12, "author": "jordan", "ci": "fail"}])
        self.run_once()

        def broken(w: alerts.World) -> alerts.Reading:
            raise RuntimeError("boom")

        self.fail_backup()
        self.run_once({**alerts.SOURCES, "ci:": broken})
        self.assertEqual(self.shown(), {"ci:keel#12", "routine:backup"})

    def test_a_failed_push_is_retried_on_the_next_evaluation_and_never_raises(self) -> None:
        self.fail_backup()
        self.send.broken = True
        self.assertEqual(self.run_once(), [])
        self.assertIsNone(self.files()["routine:backup"]["pushed"])
        self.send.broken = False
        self.assertEqual(self.run_once(), ["routine:backup"])
        self.assertEqual(self.files()["routine:backup"]["pushed"], alerts.stamp(self.now))

    def test_the_push_count_is_every_visible_alert(self) -> None:
        self.fail_backup()
        self.run_once()
        self.status("integrity-check", {"result": "fail", "failures": 1, "last_run": alerts.stamp(self.now)})
        self.run_once()
        self.assertEqual(self.send.sent[-1], ("integrity-check failed: 1 problem", "background", 2))


if __name__ == "__main__":
    unittest.main()
