"""The backup routine, run for real against a throwaway home, vault and drive.

The script is bash under `set -u`, so an unbound variable only shows up when it runs.
These cases run it the way launchd does and read what it wrote."""
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "routines" / "backup.sh"


class BackupTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.home, self.vault, self.drive = self.root / "home", self.root / "vault", self.root / "drive"
        for p in (self.home, self.vault, self.drive):
            p.mkdir()
        (self.vault / "note.md").write_text("hello\n")
        for argv in (["init", "-q", "-b", "main"], ["add", "-A"],
                     ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "v"]):
            subprocess.run(["git", "-C", str(self.vault), *argv], check=True, capture_output=True)
        self.state = self.home / ".helm"
        (self.state / "backup").mkdir(parents=True)
        (self.state / "threads").mkdir()
        (self.state / "threads" / "t.json").write_text("{}")

    def run_backup(self) -> dict:
        env = {"HOME": str(self.home), "PATH": os.environ["PATH"], "HELM_VAULT_ROOT": str(self.vault)}
        subprocess.run(["/bin/bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)
        return json.loads((self.state / "status" / "backup.json").read_text())

    def test_unconfigured_does_nothing(self) -> None:
        self.assertEqual(self.run_backup()["result"], "not configured")

    def test_a_present_drive_gets_the_bundle_the_tree_and_the_state(self) -> None:
        (self.state / "backup" / "target").write_text(f"{self.drive}/latest\n")
        self.assertEqual(self.run_backup()["result"], "ok")
        self.assertEqual(sorted(p.name for p in (self.drive / "latest").iterdir()),
                         ["state.tar.gz", "vault-tree.tar.gz", "vault.bundle"])
        self.assertEqual(self.run_backup()["result"], "fresh", "a second run within 12 hours skips")

    def test_an_absent_drive_is_quiet(self) -> None:
        (self.state / "backup" / "target").write_text(f"{self.root}/missing/latest\n")
        (self.state / "backup" / "last-success").write_text(str(int(time.time())))
        self.assertEqual(self.run_backup()["result"], "volume absent")


if __name__ == "__main__":
    unittest.main()
