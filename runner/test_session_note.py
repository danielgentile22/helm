"""The session-recap hook keeps vault sessions out of the recap.

The vault is one folder holding every topic, so "the last session in this folder" there
is whatever ran last, often private. Repo folders keep their recap.

    python3 -m unittest discover -s runner -p 'test_*.py'
"""
from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "hooks"))

import session_note  # noqa: E402


class SessionNoteTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        self.vault = tmp / "vault"
        self.repo = tmp / "repo"
        for folder in (self.vault / "Atlas", self.repo):
            folder.mkdir(parents=True)
        patches = (mock.patch.object(session_note.common, "SESSIONS_DIR", tmp / "sessions"),
                   mock.patch.object(session_note.common, "VAULT", self.vault))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_hook(self, command: str, cwd: Path, **data: str) -> str:
        out = io.StringIO()
        with redirect_stdout(out), mock.patch("sys.stdin", io.StringIO(json.dumps({"cwd": str(cwd), **data}))):
            session_note.main([command])
        return out.getvalue()

    def test_repo_session_gets_its_recap(self) -> None:
        self.run_hook("stop", self.repo, session_id="s1", last_assistant_message="Shipped the parser.")
        self.assertIn("Shipped the parser.", self.run_hook("start", self.repo))

    def test_vault_session_writes_no_note(self) -> None:
        for cwd in (self.vault, self.vault / "Atlas"):
            self.run_hook("stop", cwd, session_id="s1", last_assistant_message="A private summary.")
        self.assertEqual(list(session_note.common.SESSIONS_DIR.glob("*/*.md")), [])

    def test_vault_session_prints_no_recap_even_from_an_old_note(self) -> None:
        for cwd in (self.vault, self.vault / "Atlas"):
            session_note.write_note(session_note.note_path(str(cwd), "old"), "at: then\n\nA private summary.\n")
            self.assertEqual(self.run_hook("start", cwd), "")


if __name__ == "__main__":
    unittest.main()
