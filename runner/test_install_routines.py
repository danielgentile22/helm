"""install-routines.sh against a fake launchctl and a temp HOME, so no real job is touched.

    python3 -m unittest runner/test_install_routines.py
"""
from __future__ import annotations

import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "install-routines.sh"

FAKE_LAUNCHCTL = """#!/bin/bash
echo "$*" >> "$LAUNCHCTL_LOG"
exit 0
"""


class InstallTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.home = root / "home"
        self.state = root / "state"
        self.agents = self.home / "Library" / "LaunchAgents"
        self.disabled = self.state / "disabled"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        fake = bin_dir / "launchctl"
        fake.write_text(FAKE_LAUNCHCTL)
        fake.chmod(0o755)
        self.log = root / "launchctl.log"
        self.env = {**os.environ, "HOME": str(self.home), "HELM_STATE": str(self.state),
                    "PATH": f"{bin_dir}:{os.environ['PATH']}", "LAUNCHCTL_LOG": str(self.log)}

    def install(self) -> str:
        done = subprocess.run([str(SCRIPT)], env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return done.stdout

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_a_paused_routine_stays_parked_and_unloaded(self) -> None:
        self.disabled.mkdir(parents=True)
        parked = self.disabled / "com.helm.capture.plist"
        parked.write_text("stale")
        self.agents.mkdir(parents=True)
        (self.agents / "com.helm.capture.plist").write_text("left by an interrupted pause")

        out = self.install()

        self.assertIn("paused com.helm.capture", out)
        self.assertFalse((self.agents / "com.helm.capture.plist").exists())
        self.assertEqual(plistlib.loads(parked.read_bytes())["Label"], "com.helm.capture")
        bootstraps = [c for c in self.calls() if c.startswith("bootstrap")]
        self.assertFalse([c for c in bootstraps if "com.helm.capture" in c], bootstraps)
        self.assertTrue([c for c in bootstraps if "com.helm.backup.plist" in c], bootstraps)
        self.assertTrue((self.agents / "com.helm.backup.plist").is_file())

    def test_with_nothing_paused_every_routine_is_loaded(self) -> None:
        out = self.install()
        self.assertNotIn("paused", out)
        self.assertTrue((self.agents / "com.helm.capture.plist").is_file())
        self.assertTrue([c for c in self.calls() if c.startswith("bootstrap") and "com.helm.capture" in c])


if __name__ == "__main__":
    unittest.main()
