"""The todos source against a temp vault that is its own git repo. Nothing here reads the
real vault.

    python3 -m unittest runner/producers/test_todos.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
from sources import todos  # noqa: E402

TZ = ZoneInfo("America/New_York")
CREATED = "2026-09-01T09:00:00-04:00"
ADDED = "2026-09-10T09:00:00-04:00"
TODAY = datetime(2026, 9, 23, 12, 0, tzinfo=TZ)


def git(cwd: Path, *args: str, when: str) -> None:
    env = dict(os.environ, GIT_AUTHOR_DATE=when, GIT_COMMITTER_DATE=when)
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True, env=env)


class TodosSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.vault = root / "Vault"
        self.note = self.vault / "Atlas" / "Chess" / "Chess.md"
        self.note.parent.mkdir(parents=True)
        for name, value in (("VAULT", self.vault), ("STATUS", root / "status"),
                            ("SOURCES_DIR", root / "status" / "sources")):
            self.addCleanup(setattr, common, name, getattr(common, name))
            setattr(common, name, value)
        git(self.vault, "init", "-q", "-b", "main", when=CREATED)
        git(self.vault, "config", "user.email", "test@example.invalid", when=CREATED)
        git(self.vault, "config", "user.name", "test", when=CREATED)
        self.note.write_text("# Chess\n\n## Todos\n\n- [ ] the first todo\n")
        git(self.vault, "add", "-A", when=CREATED)
        git(self.vault, "commit", "-q", "-m", "the note", when=CREATED)

    def rows(self) -> dict[str, dict]:
        return {row["text"]: row for row in todos.collect({}, TODAY) if row["kind"] != "directive"}

    def directives(self) -> list[dict]:
        return [row for row in todos.collect({}, TODAY) if row["kind"] == "directive"]

    def test_since_is_the_commit_that_added_the_line(self) -> None:
        """A todo added in a later commit than the note used to read as the note's mtime,
        which is today after any edit, so pressure and phase saw every todo as new."""
        self.note.write_text(self.note.read_text() + "- [ ] the later todo\n")
        git(self.vault, "commit", "-q", "-am", "add the later todo", when=ADDED)
        os.utime(self.note, (TODAY.timestamp(), TODAY.timestamp()))

        rows = self.rows()
        self.assertEqual(rows["the later todo"]["since"], ADDED)
        self.assertEqual(rows["the first todo"]["since"], CREATED)

    def test_since_is_the_oldest_commit_when_the_line_moved(self) -> None:
        self.note.write_text(self.note.read_text() + "- [ ] the later todo\n")
        git(self.vault, "commit", "-q", "-am", "add the later todo", when=ADDED)
        self.note.write_text("# Chess\n\n## Todos\n\n- [ ] the later todo\n- [ ] the first todo\n")
        moved = (datetime.fromisoformat(ADDED) + timedelta(days=3)).isoformat()
        git(self.vault, "commit", "-q", "-am", "reorder", when=moved)

        self.assertEqual(self.rows()["the later todo"]["since"], ADDED)

    def test_a_starred_heading_gives_its_rank_and_keeps_its_name(self) -> None:
        self.note.write_text("# Chess\n\n## Todos\n\n### Coaching ★3\n\n- [ ] analyse both games\n\n"
                             "### Club\n\n- [ ] pay the dues\n")
        rows = self.rows()
        self.assertEqual((rows["analyse both games"]["project"], rows["analyse both games"]["star"]), ("Coaching", 3))
        self.assertEqual((rows["pay the dues"]["project"], rows["pay the dues"]["star"]), ("Club", None))

    def test_only_a_trailing_star_one_to_three_is_a_rank(self) -> None:
        self.assertEqual(todos.directive_heading("Job search ★1"), ("Job search", 1))
        self.assertEqual(todos.directive_heading("Job search ★4"), ("Job search ★4", None))
        self.assertEqual(todos.directive_heading("★1 Job search"), ("★1 Job search", None))

    def test_a_starred_directive_is_reported_with_or_without_todos(self) -> None:
        """A first priority with nothing queued had no row at all, so the map could not show
        it. Every starred heading inside ## Todos is its own row; unstarred ones and starred
        headings outside ## Todos are not."""
        self.note.write_text("# Chess\n\n## Facts\n\n### Rating ★2\n\n## Todos\n\n"
                             "### Coaching ★1\n\n### Club\n\n- [ ] pay the dues\n\n"
                             "### Tournaments ★3\n\n- [ ] enter the October open\n")
        self.assertEqual(
            [(d["dept"], d["name"], d["star"], d["line"]) for d in self.directives()],
            [("Chess", "Coaching", 1, 9), ("Chess", "Tournaments", 3, 15)],
        )
        self.assertTrue(all("id" not in d and "text" not in d for d in self.directives()))
        self.assertEqual(sorted(self.rows()), ["enter the October open", "pay the dues"])

    def test_an_uncommitted_line_falls_back_to_the_note_s_mtime(self) -> None:
        self.note.write_text(self.note.read_text() + "- [ ] not committed yet\n")
        os.utime(self.note, (TODAY.timestamp(), TODAY.timestamp()))

        self.assertEqual(self.rows()["not committed yet"]["since"], common.iso(TODAY))


if __name__ == "__main__":
    unittest.main()
