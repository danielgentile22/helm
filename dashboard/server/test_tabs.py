"""The four tabs' reads, through `dispatch`, against a copy of the demo vault, a temp state
folder and fake machine probes. Nothing here asks launchd, the tailnet or GitHub.

    python3 -m unittest dashboard/server/test_tabs.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import app  # noqa: E402
import machine  # noqa: E402
import routes  # noqa: E402
import common  # noqa: E402  after routes, which puts the producers on the path

DEMO = common.ENGINE / "demo-vault"


def get(path: str, query: str = "") -> tuple[int, dict]:
    request = app.Request(method="GET", path=path, headers={"host": "127.0.0.1:8642"}, body=b"",
                          peer="127.0.0.1", port=8642, query=query)
    out = app.dispatch(request, routes.ROUTES)
    return out.status, json.loads(out.body)


def project(slug: str, **over: object) -> dict:
    entry = {"slug": slug, "title": slug.title(), "note": f"Atlas/Projects/{slug.title()}.md", "status": "active",
             "pinned": False, "tracker": "github", "pull_requests_scope": "all", "repos": [],
             "branches": [], "last_commit": None, "problems": [], "pull_requests": [], "ideas_open": 0,
             "issues": {"open": 1, "by_status": {"open": 1}},
             "issues_list": [{"id": f"{slug}#1", "title": "One", "status": "open", "url": None, "path": None,
                              "repo": slug, "updated": None}]}
    entry.update(over)
    return entry


def envelope(ok: bool = True, reason: str | None = None) -> dict:
    return {"produced": "2026-11-04T08:00:00-05:00", "attempted": "2026-11-04T08:30:00-05:00", "ok": ok,
            "reason": reason, "count": 1, "cadence_s": 1800}


class TabTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.vault = root / "vault"
        shutil.copytree(DEMO, self.vault)
        self.state = root / "state"
        (self.state / "status").mkdir(parents=True)
        self.jobs: dict[str, machine.LaunchdJob] = {}
        self.tailnet = machine.Tailnet(None, "no tailnet in the tests")
        for module, name, value in ((common, "VAULT", self.vault), (common, "STATE", self.state),
                                    (common, "STATUS", self.state / "status"),
                                    (machine, "launchctl_list", lambda: self.jobs),
                                    (machine, "tailscale_status", lambda: self.tailnet)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)

    def write(self, rel: str, text: str, mtime: float | None = None) -> Path:
        path = self.state / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path


class ProjectsTabTest(TabTest):
    def capture(self, sources: dict, projects: list[dict]) -> None:
        self.write("status/projects.json", json.dumps({"produced": "2026-11-04T08:00:00-05:00",
                                                       "sources": sources, "projects": projects}))

    def test_no_capture_yet_is_an_empty_list_that_says_why(self) -> None:
        status, body = get("/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual(body["projects"], [])
        self.assertIn("capture", body["error"])

    def test_the_list_is_the_file_without_issue_lists_and_names_a_failing_source(self) -> None:
        self.capture({"projects": envelope(), "github": envelope(False, "network: gh pr list: offline")},
                     [project("keel", pinned=True), project("compiler")])
        status, body = get("/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual(body["error"], "github: network: gh pr list: offline")
        self.assertEqual([p["slug"] for p in body["projects"]], ["keel", "compiler"])
        self.assertNotIn("issues_list", body["projects"][0])
        self.assertEqual(body["projects"][0]["issues"], {"open": 1, "by_status": {"open": 1}})

    def test_one_project_carries_its_issues_and_its_open_ideas_from_the_vault(self) -> None:
        self.capture({"projects": envelope()}, [project("keel", ideas_open=5)])
        status, body = get("/api/projects/keel")
        self.assertEqual(status, 200)
        self.assertIsNone(body["error"])
        self.assertEqual([i["id"] for i in body["issues_list"]], ["keel#1"])
        self.assertEqual([i["project"] for i in body["ideas"]], ["Keel"])
        self.assertEqual(body["ideas_open"], 1)

    def test_an_unknown_slug_is_404(self) -> None:
        self.capture({"projects": envelope()}, [project("keel")])
        status, body = get("/api/projects/nope")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "not_found")


class IdeasTabTest(TabTest):
    def note(self, name: str) -> Path:
        return self.vault / "Atlas" / "Ideas" / name

    def test_open_is_the_default_soonest_due_first_then_newest(self) -> None:
        status, body = get("/api/ideas")
        self.assertEqual(status, 200)
        self.assertEqual(body["errors"], [])
        dues = [i["due"] for i in body["ideas"]]
        dated = [d for d in dues if d]
        self.assertEqual(dated, sorted(dated))
        self.assertEqual(dues[:len(dated)], dated)
        self.assertEqual(len(body["ideas"]), 15)

    def test_a_status_filter_and_all(self) -> None:
        done = self.note("2026-09-26-order-the-desk-lamp.md")
        done.write_text(done.read_text().replace("status: open", "status: done"))
        self.assertEqual([i["status"] for i in get("/api/ideas", "status=done")[1]["ideas"]], ["done"])
        self.assertEqual(len(get("/api/ideas", "status=open")[1]["ideas"]), 14)
        self.assertEqual(len(get("/api/ideas", "status=all")[1]["ideas"]), 15)

    def test_an_unknown_status_is_400(self) -> None:
        status, body = get("/api/ideas", "status=later")
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "bad_request")

    def test_a_broken_note_is_reported_and_the_rest_still_come(self) -> None:
        self.note("2026-11-01-broken.md").write_text("---\ntype: idea\nstatus: someday\n---\nA broken one\n")
        status, body = get("/api/ideas")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["ideas"]), 15)
        self.assertEqual(len(body["errors"]), 1)
        self.assertIn("2026-11-01-broken.md", body["errors"][0])


class BackgroundTabTest(TabTest):
    def routine(self, body: dict, name: str) -> dict:
        return next(r for r in body["routines"] if r["name"] == name)

    def test_every_routine_in_models_json_with_its_status_normalised(self) -> None:
        self.jobs = {
            "com.helm.capture": machine.LaunchdJob("com.helm.capture", None, 0),
            "com.helm.backup": machine.LaunchdJob("com.helm.backup", None, 0),
            "com.helm.integrity-check": machine.LaunchdJob("com.helm.integrity-check", 512, 1),
            "com.helm.dashboard": machine.LaunchdJob("com.helm.dashboard", 900, -15),
            "com.helm.caffeinate": machine.LaunchdJob("com.helm.caffeinate", 901, 0),
        }
        self.write("status/capture.json", json.dumps({"routine": "capture", "last_run": "2026-11-04T12:25:12Z",
                                                      "result": "pass", "failures": 0}))
        self.write("status/backup.json", json.dumps({"ran": "2026-11-03T14:00:05Z", "result": "volume absent",
                                                     "last_success": 1792945851}))
        self.write("disabled/com.helm.job-search.plist", "<plist/>")
        self.write("status/job-search.json", json.dumps({"last_run": "2026-11-01T09:01:01Z", "result": "fail",
                                                         "failures": 1}))
        status, body = get("/api/background")
        self.assertEqual(status, 200)
        self.assertEqual([r["name"] for r in body["routines"]],
                         ["integrity-check", "job-search", "capture", "backup"])

        capture = self.routine(body, "capture")
        self.assertEqual((capture["result"], capture["result_text"], capture["loaded"], capture["running"]),
                         ("pass", "pass", True, False))
        self.assertEqual(capture["last_success"], "2026-11-04T12:25:12+00:00")
        self.assertIsNotNone(capture["next_run"])
        self.assertEqual(capture["schedule"], "every 30m")

        backup = self.routine(body, "backup")
        self.assertEqual((backup["result"], backup["result_text"]), ("fail", "volume absent"))
        self.assertEqual(backup["last_run"], "2026-11-03T14:00:05+00:00")
        self.assertEqual(backup["last_success"], "2026-10-25T16:30:51+00:00")

        paused = self.routine(body, "job-search")
        self.assertEqual((paused["result"], paused["result_text"], paused["paused"], paused["loaded"]),
                         ("paused", "fail", True, False))
        self.assertIsNone(paused["next_run"])

        never = self.routine(body, "integrity-check")
        self.assertEqual((never["result"], never["running"], never["last_exit"]), ("unknown", True, 1))

        self.assertEqual([(s["name"], s["listed"], s["last_exit"]) for s in body["services"]],
                         [("caffeinate", False, 0), ("dashboard", True, -15)])

    def test_the_log_tail_is_the_last_forty_lines_of_the_newer_log(self) -> None:
        now = time.time()
        self.write("logs/com.helm.capture.out", "old out\n", mtime=now - 600)
        self.write("logs/com.helm.capture.err", "".join(f"line {n}\n" for n in range(100)), mtime=now - 60)
        capture = self.routine(get("/api/background")[1], "capture")
        self.assertEqual(capture["log_tail"], [f"line {n}" for n in range(60, 100)])
        self.assertIsNotNone(capture["log_updated"])
        self.assertEqual(self.routine(get("/api/background")[1], "backup")["log_tail"], [])

    def test_launchctl_output_is_parsed_into_jobs(self) -> None:
        jobs = machine.parse_launchctl("PID\tStatus\tLabel\n-\t0\tcom.helm.capture\n88791\t-15\tcom.helm.dashboard\n"
                                       "garbage\n")
        self.assertEqual(jobs["com.helm.capture"], machine.LaunchdJob("com.helm.capture", None, 0))
        self.assertEqual(jobs["com.helm.dashboard"], machine.LaunchdJob("com.helm.dashboard", 88791, -15))
        self.assertEqual(len(jobs), 2)


class DevicesTabTest(TabTest):
    TAILNET = {
        "Self": {"DNSName": "studio-desk.example.ts.net.", "HostName": "Studio Desk", "Online": True,
                 "LastSeen": "0001-01-01T00:00:00Z"},
        "Peer": {"k1": {"DNSName": "travel-laptop.example.ts.net.", "HostName": "Travel-Laptop", "Online": False,
                        "LastSeen": "2026-11-03T21:14:00Z"}},
    }

    def by_title(self) -> dict[str, dict]:
        status, body = get("/api/devices")
        self.assertEqual(status, 200)
        return {d["title"]: d for d in body["devices"]}

    def test_device_notes_joined_to_presence_on_the_tailnet_name(self) -> None:
        self.tailnet = machine.Tailnet(self.TAILNET, None)
        found = self.by_title()
        self.assertEqual(sorted(found), ["Desk display", "Studio desk Mac", "Travel laptop"])
        mac = found["Studio desk Mac"]
        self.assertEqual(mac["presence"], {"online": True, "last_seen": None})
        self.assertEqual(mac["specs"], {"chip": "M5 Max", "memory": "64 GB", "storage": "2 TB"})
        self.assertEqual((mac["kind"], mac["t3"], mac["purchased"], mac["warranty_until"]),
                         ("desktop", "host", "2026-09-23", "2029-09-23"))
        self.assertEqual(mac["path"], "Atlas/Life/Devices/Studio desk Mac.md")
        self.assertEqual(found["Travel laptop"]["presence"], {"online": False, "last_seen": "2026-11-03T21:14:00Z"})
        self.assertIsNone(found["Desk display"]["presence"])

    def test_no_tailnet_means_no_presence_and_says_why(self) -> None:
        status, body = get("/api/devices")
        self.assertEqual(body["tailnet_error"], "no tailnet in the tests")
        self.assertTrue(all(d["presence"] is None for d in body["devices"]))

    def test_a_name_the_tailnet_does_not_know_is_offline_never_seen(self) -> None:
        self.tailnet = machine.Tailnet({"Self": {}, "Peer": {}}, None)
        self.assertEqual(self.by_title()["Travel laptop"]["presence"], {"online": False, "last_seen": None})

    def test_a_bad_note_is_validated_not_fatal(self) -> None:
        (self.vault / "Atlas" / "Life" / "Devices" / "Odd.md").write_text(
            "---\ntype: device\ntitle: Odd\nkind: toaster\nspecs: lots\npurchased: last spring\n---\n")
        odd = self.by_title()["Odd"]
        self.assertEqual(odd["kind"], "toaster")
        self.assertIsNone(odd["specs"])
        self.assertIsNone(odd["purchased"])
        self.assertEqual(len(odd["problems"]), 3)


if __name__ == "__main__":
    unittest.main()
