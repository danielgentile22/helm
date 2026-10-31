"""The repos-against-notes check, run for real against a throwaway home and vault."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "checks" / "check_registry.py"


class CheckRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.notes = self.home / "Vault" / "Atlas" / "Projects"
        self.notes.mkdir(parents=True)
        for name in ("keel", "scratch"):
            (self.home / "Projects" / name).mkdir(parents=True)
        (self.notes / "Keel.md").write_text("---\ntype: project\nrepo: ~/Projects/keel\n---\n")

    def run_check(self) -> subprocess.CompletedProcess:
        env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "HELM_VAULT_ROOT": str(self.home / "Vault")}
        return subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, timeout=30)

    def test_a_repo_with_no_note_fails(self) -> None:
        r = self.run_check()
        self.assertEqual(r.returncode, 1)
        self.assertIn("repo with no project note: ~/Projects/scratch", r.stdout)

    def test_a_repo_on_the_ignore_list_is_not_a_project(self) -> None:
        (self.notes / "_registry-ignore.md").write_text("# Not projects\nProse lines are ignored.\n~/Projects/scratch\n")
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout)


if __name__ == "__main__":
    unittest.main()
