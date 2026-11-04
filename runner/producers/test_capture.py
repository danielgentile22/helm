"""Capture tests, against fake sources and a temp status directory. Nothing here reads the
real vault or a repo.

The one they exist for: a full run takes as long as its slowest source, the dashboard's
toggle re-merges in the middle of it, and the merged files must end up with the toggle
rather than with the rows the long run started out holding.

    python3 -m unittest runner/producers/test_capture.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import capture  # noqa: E402
import common  # noqa: E402

CADENCE_S = 1800


def idea(text: str) -> dict:
    return {"kind": "idea", "id": text, "title": text, "due": None}


def nothing(env: dict[str, str], now: datetime) -> list[dict]:
    return []


class CaptureTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.status = Path(tmp.name) / "status"
        self.swap(common, "STATUS", self.status)
        self.swap(common, "SOURCES_DIR", self.status / "sources")
        self.swap(capture, "cadence", lambda: CADENCE_S)
        self.idea_rows = [idea("open the box")]

    def swap(self, module: object, name: str, value: object) -> None:
        self.addCleanup(setattr, module, name, getattr(module, name))
        setattr(module, name, value)

    def use_sources(self, **fakes: common.Collector) -> None:
        table = {"ideas": nothing, "routines": nothing, "repos": nothing, "projects": nothing, "github": nothing}
        table.update(fakes)
        self.swap(capture, "SOURCES", table)

    def agenda(self) -> dict:
        return json.loads((self.status / "agenda.json").read_text())

    def projects(self) -> dict:
        return json.loads((self.status / "projects.json").read_text())

    def titles(self) -> list[str]:
        agenda = self.agenda()
        return [item["title"] for item in agenda["ideas"] + agenda["routines"]]

    def test_a_toggle_mid_run_is_what_ends_up_in_agenda(self) -> None:
        ideas_cached = threading.Event()
        toggled = threading.Event()

        def ideas(env: dict[str, str], now: datetime) -> list[dict]:
            return list(self.idea_rows)

        def routines(env: dict[str, str], now: datetime) -> list[dict]:
            ideas_cached.set()
            return []

        def slow_repos(env: dict[str, str], now: datetime) -> list[dict]:
            self.assertTrue(toggled.wait(10), "the toggle never landed")
            return [{"path": "/tmp/p", "name": "p"}]

        def toggle() -> None:
            ideas_cached.wait(10)
            self.idea_rows = [idea("done from the phone")]
            capture.refresh("ideas")
            toggled.set()

        self.use_sources(ideas=ideas, routines=routines, repos=slow_repos)
        worker = threading.Thread(target=toggle)
        worker.start()
        self.addCleanup(worker.join, 10)
        self.assertEqual(capture.main([]), 0)

        self.assertEqual(self.titles(), ["done from the phone"])
        self.assertEqual(self.agenda()["sources"]["ideas"]["count"], 1)
        self.assertEqual([r["path"] for r in self.projects()["in_flight"]], ["/tmp/p"])

    def test_a_collect_that_started_before_a_toggle_cannot_overwrite_the_toggle(self) -> None:
        """The other order from the test above. The scheduled ideas source is mid collect
        when the phone's status change re-merges; without the lock the click's rows land first and the
        slow collect then writes its pre-click rows over them, and a done idea comes back
        open until the next capture. With it the click waits for the collect and writes last."""
        remerge_started = threading.Event()
        calls: list[str] = []

        def ideas(env: dict[str, str], now: datetime) -> list[dict]:
            calls.append("collect")
            if len(calls) == 1:
                self.assertTrue(remerge_started.wait(10), "the re-merge never started")
                time.sleep(0.4)
                return [idea("open the box")]
            return [idea("done from the phone")]

        def toggle() -> None:
            remerge_started.set()
            capture.refresh("ideas")

        self.use_sources(ideas=ideas)
        worker = threading.Thread(target=toggle)
        worker.start()
        self.addCleanup(worker.join, 10)
        self.assertEqual(capture.main([]), 0)
        worker.join(10)

        self.assertEqual(calls, ["collect", "collect"])
        self.assertEqual(self.titles(), ["done from the phone"])
        cache = json.loads((self.status / "sources" / "ideas.json").read_text())
        self.assertEqual([r["title"] for r in cache["items"]], ["done from the phone"])

    def test_two_writers_in_one_process_never_leave_a_half_file(self) -> None:
        """Two dashboard threads re-merging at once share a pid. With one temp name between
        them the second replace found nothing to move, or moved the other's half written
        bytes into place."""
        target = self.status / "agenda.json"
        payload = {"items": [idea(f"row {i}") for i in range(2000)]}
        errors: list[BaseException] = []

        def write() -> None:
            try:
                for _ in range(20):
                    common.write_json(target, payload)
            except BaseException as e:  # noqa: BLE001  reported by the assertion below
                errors.append(e)

        threads = [threading.Thread(target=write) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(json.loads(target.read_text()), payload)

    def test_refresh_reruns_one_source_and_keeps_the_rest_from_their_caches(self) -> None:
        def routines(env: dict[str, str], now: datetime) -> list[dict]:
            return [{"kind": "job", "id": "routine:capture", "title": "capture",
                     "at": "2026-09-18T09:00:00-04:00"}]

        def ideas(env: dict[str, str], now: datetime) -> list[dict]:
            return list(self.idea_rows)

        self.use_sources(routines=routines, ideas=ideas)
        self.assertEqual(capture.main([]), 0)
        self.assertEqual(sorted(self.titles()), ["capture", "open the box"])

        self.idea_rows = []
        capture.refresh("ideas")
        self.assertEqual(self.titles(), ["capture"])
        self.assertEqual(self.agenda()["sources"]["routines"]["count"], 1)

    def test_each_merged_file_is_stamped_by_its_own_newest_source(self) -> None:
        """Merging is not producing. A refresh of one agenda source must not restamp
        projects.json, whose rows are as old as the last repo scan."""
        self.use_sources()
        self.assertEqual(capture.main([]), 0)
        first = self.projects()
        self.assertEqual(first["produced"], first["sources"]["projects"]["produced"])

        capture.refresh("ideas")
        agenda = self.agenda()
        self.assertEqual(agenda["produced"], agenda["sources"]["ideas"]["produced"])
        self.assertEqual(self.projects()["produced"], first["produced"])

    def test_a_failed_ideas_run_keeps_its_last_ideas(self) -> None:
        calls: list[str] = []

        def ideas(env: dict[str, str], now: datetime) -> list[dict]:
            calls.append("collect")
            if len(calls) > 1:
                raise RuntimeError("vault unreadable")
            return list(self.idea_rows)

        self.use_sources(ideas=ideas)
        self.assertEqual(capture.main([]), 0)
        capture.refresh("ideas")
        agenda = self.agenda()
        self.assertFalse(agenda["sources"]["ideas"]["ok"])
        self.assertEqual(self.titles(), ["open the box"])

    def test_a_source_with_no_cache_yet_merges_as_never_produced(self) -> None:
        self.use_sources()
        stamp = capture.refresh("ideas")
        self.assertEqual(self.agenda()["produced"], stamp)
        routines = self.agenda()["sources"]["routines"]
        self.assertFalse(routines["ok"])
        self.assertIsNone(routines["produced"])


if __name__ == "__main__":
    unittest.main()
