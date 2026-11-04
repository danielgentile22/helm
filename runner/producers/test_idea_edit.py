"""idea_edit tests against a temp copy of the demo vault, made a git repo so commits are real.

    python3 -m unittest runner/producers/test_idea_edit.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
import idea_edit  # noqa: E402

DEMO = common.ENGINE / "demo-vault"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}

NOTE = """---
type: idea
created: 2026-11-01
status: open
department: Life
---
Book the Lisbon flights
"""


class IdeaTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.vault = Path(tmp.name) / "vault"
        shutil.copytree(DEMO, self.vault)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "start")
        state = Path(tmp.name) / "state"
        for name, value in (("VAULT", self.vault), ("STATUS", state / "status")):
            self.addCleanup(setattr, common, name, getattr(common, name))
            setattr(common, name, value)

    def git(self, *argv: str) -> str:
        return subprocess.run(["git", "-C", str(self.vault), *argv], check=True,
                              capture_output=True, text=True).stdout

    def cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             mock.patch.object(idea_edit, "refresh_capture", lambda: None):
            rc = idea_edit.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def test_add_writes_the_shape_and_prints_one_json_line(self) -> None:
        rc, out, _ = self.cli("add", "Export the itinerary  as a calendar file", "--due", "2026-11-15",
                              "--created", "2026-11-01", "--body", "Sam wants it on the phone.")
        self.assertEqual(rc, 0)
        self.assertEqual(len(out.splitlines()), 1)
        result = json.loads(out)
        note = self.vault / "Atlas/Ideas/2026-11-01-export-the-itinerary-as-a-calendar-file.md"
        self.assertEqual(result["path"], str(note))
        self.assertEqual(note.read_text(), "---\ntype: idea\ncreated: 2026-11-01\nstatus: open\n"
                         "department: Life\ndue: 2026-11-15\n---\n"
                         "Export the itinerary as a calendar file\n\nSam wants it on the phone.\n")
        self.assertEqual(result["idea"], {
            "id": "2026-11-01-export-the-itinerary-as-a-calendar-file",
            "path": "Atlas/Ideas/2026-11-01-export-the-itinerary-as-a-calendar-file.md",
            "title": "Export the itinerary as a calendar file", "created": "2026-11-01",
            "status": "open", "department": "Life", "project": None, "due": "2026-11-15", "issue": None})
        self.assertRegex(result["commit"], r"^[0-9a-f]{7,}$")

    def test_the_department_comes_from_the_project_note_folder(self) -> None:
        idea = idea_edit.add(self.vault, "Add a dark theme", project="Keel")
        self.assertEqual((idea.project, idea.department), ("Keel", "Projects"))
        self.assertEqual(idea_edit.add(self.vault, "Call the coach", department="Chess").department, "Chess")
        self.assertEqual(idea_edit.add(self.vault, "Water the plants").department, "Life")

    def test_a_project_that_disagrees_or_does_not_exist_is_refused(self) -> None:
        with self.assertRaisesRegex(idea_edit.IdeaError, "is in Projects, not Work"):
            idea_edit.add(self.vault, "Add a dark theme", project="Keel", department="Work")
        with self.assertRaisesRegex(idea_edit.IdeaError, "no project note titled 'Lisbon'"):
            idea_edit.add(self.vault, "Pack", project="Lisbon")

    def test_a_slug_collision_gets_a_number(self) -> None:
        stems = [idea_edit.add(self.vault, "Order the desk lamp", created="2026-09-26").id for _ in range(2)]
        self.assertEqual(stems, ["2026-09-26-order-the-desk-lamp-2", "2026-09-26-order-the-desk-lamp-3"])
        self.assertEqual(idea_edit.resolve(self.vault, "order-the-desk-lamp-2").stem, stems[0])
        idea_edit.add(self.vault, "Order the desk lamp", created="2026-11-01")
        with self.assertRaisesRegex(idea_edit.IdeaError, "names 2 ideas"):
            idea_edit.resolve(self.vault, "order-the-desk-lamp")

    def test_status_and_due_are_idempotent(self) -> None:
        idea = idea_edit.add(self.vault, "Hang the Lisbon map", created="2026-11-01")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "seed")
        head = self.git("rev-parse", "HEAD")
        for argv in (("status", "hang-the-lisbon-map", "open"), ("due", idea.path, "none")):
            with self.subTest(argv=argv):
                rc, out, _ = self.cli(*argv)
                self.assertEqual(rc, 0)
                self.assertEqual((json.loads(out)["changed"], json.loads(out)["commit"]), (False, None))
        self.assertEqual(self.git("rev-parse", "HEAD"), head)
        for _ in range(2):
            rc, out, _ = self.cli("status", idea.id, "done")
        self.assertFalse(json.loads(out)["changed"])
        self.assertEqual(self.git("log", "-1", "--format=%s"), "Mark an idea done\n")
        self.assertEqual(idea_edit.load(self.vault, self.vault / idea.path).status, "done")

    def test_status_refuses_promoted_and_unknown_values(self) -> None:
        idea = idea_edit.add(self.vault, "Order the desk lamp")
        for value in ("promoted", "finished"):
            with self.subTest(value=value):
                rc, _, err = self.cli("status", idea.id, value, "--no-commit")
                self.assertEqual(rc, 2)
                self.assertIn("idea_edit:", err)

    def test_parse_rejects_bad_values(self) -> None:
        cases = {
            "status: open": ("status: later", "unknown status 'later'"),
            "department: Life": ("department: Hobbies", "unknown department 'Hobbies'"),
            "created: 2026-11-01": ("created: 2026-13-01", "created '2026-13-01' is not a date"),
            "type: idea": ("type: note", "no `type: idea`"),
            "Book the Lisbon flights": ("", "no title"),
        }
        self.assertEqual(idea_edit.parse_idea(NOTE, "x.md").title, "Book the Lisbon flights")
        for old, (new, message) in cases.items():
            with self.subTest(new=new):
                with self.assertRaisesRegex(idea_edit.IdeaError, f"^x.md: .*{message}"):
                    idea_edit.parse_idea(NOTE.replace(old, new), "x.md")
        with self.assertRaisesRegex(idea_edit.IdeaError, "unknown department"):
            idea_edit.add(self.vault, "Pack", department="Hobbies")

    def test_commit_subjects_carry_no_idea_text(self) -> None:
        title = "Wire the 400 euro deposit to Alex Reed"
        rc, out, _ = self.cli("add", title, "--department", "Work")
        ref = json.loads(out)["idea"]["id"]
        self.cli("due", ref, "2026-11-20")
        self.cli("status", ref, "dropped")
        self.cli("status", ref, "open")
        log = self.git("log", "--format=%B", "-4")
        self.assertEqual(log.split(), "Reopen an idea Drop an idea Change an idea's due date Add an idea".split())
        for word in ("Wire", "deposit", "400", "Alex"):
            self.assertNotIn(word, log)

    def test_list_filters_by_status(self) -> None:
        a = idea_edit.add(self.vault, "First", created="2026-11-01")
        idea_edit.add(self.vault, "Second", created="2026-11-02")
        idea_edit.set_status(self.vault, self.vault / a.path, "done")
        rc, out, _ = self.cli("list", "--status", "open", "--json")
        mine = [r["title"] for r in json.loads(out) if r["created"] >= "2026-11-01"]
        self.assertEqual(mine, ["Second"])
        self.assertTrue(all(r["status"] == "open" for r in json.loads(out)))

    def test_a_quoted_project_title_reads_back(self) -> None:
        note = self.vault / "Atlas/Projects/Odd.md"
        note.write_text('---\ntype: project\ntitle: "Keel: the sequel"\n---\n# Odd\n')
        idea = idea_edit.add(self.vault, "Name it", project="Keel: the sequel")
        self.assertIn('project: "Keel: the sequel"', (self.vault / idea.path).read_text())
        self.assertEqual(idea_edit.load(self.vault, self.vault / idea.path).project, "Keel: the sequel")


if __name__ == "__main__":
    unittest.main()
