"""What `install-routines.sh` would write, checked without booting a launchd job.

The assertions are on the plan and on the generated text, read back with `plistlib` the way
launchd reads it. Nothing here runs `launchctl`, and nothing reads the real `models.json`:
every test hands `plan` a registry and a root, which is the whole input.

    python3 -m unittest discover -s runner -p 'test_*.py'
"""
from __future__ import annotations

import contextlib
import io
import plistlib
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import launchd  # noqa: E402

REAL_ROOT = HERE.parent  # the one place a test reads helm's own models.json
# The generator honours HELM_STATE at install time; these tests pin the default.
os.environ.pop("HELM_STATE", None)

ROOT = Path("/somewhere/helm")
HOME = Path("/somewhere/home")

REGISTRY = {
    "routines": {
        "integrity-check": {"schedule": "daily 07:00"},
        "capture": {"schedule": "every 30m"},
        "backup": {"schedule": "daily 09:00 and on mount"},
    },
    "services": {
        "dashboard": {"command": ["dashboard/serve.py", "--no-open"], "throttle_s": 15},
    },
}


def text(label: str) -> str:
    job = next(j for j in launchd.plan(REGISTRY, ROOT) if j.label == label)
    return launchd.plist(job, ROOT, HOME)


def read(label: str) -> dict:
    """The plist as launchd reads it, so a malformed one fails here rather than at load."""
    return plistlib.loads(text(label).encode("utf-8"))


def run(argv: list[str]) -> str:
    """The command line `install-routines.sh` actually calls, with its stdout captured."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        launchd.main(argv)
    return out.getvalue()


class PlanTest(unittest.TestCase):
    def test_every_routine_and_every_service_gets_one_job(self) -> None:
        labels = [job.label for job in launchd.plan(REGISTRY, ROOT)]
        self.assertEqual(labels, ["com.helm.integrity-check", "com.helm.capture", "com.helm.backup", "com.helm.dashboard"])

    def test_the_listing_the_installer_reads_names_every_job_and_can_render_each(self) -> None:
        """Install and uninstall both loop over `--list`, so what the installer can create is
        exactly what it can remove. A service left loaded after --uninstall would be an orphan
        holding the port."""
        listed = run(["--list", "--root", str(REAL_ROOT), "--home", str(HOME)]).splitlines()
        labels = [row.split("\t")[0] for row in listed]
        self.assertEqual(labels, [job.label for job in launchd.plan(launchd.read_registry(REAL_ROOT),
                                                                    REAL_ROOT)])
        self.assertIn("com.helm.dashboard", labels)
        for label in labels:
            with self.subTest(label=label):
                rendered = run(["--plist", label, "--root", str(REAL_ROOT), "--home", str(HOME)])
                self.assertEqual(plistlib.loads(rendered.encode("utf-8"))["Label"], label)
        with self.assertRaises(SystemExit):
            run(["--plist", "com.helm.nothing", "--root", str(REAL_ROOT)])

    def test_a_service_needs_a_throttle_so_a_crash_loop_is_bounded(self) -> None:
        for throttle in (0, -1):
            with self.subTest(throttle=throttle):
                registry = {"services": {"dashboard": {"command": ["dashboard/serve.py"],
                                                       "throttle_s": throttle}}}
                with self.assertRaises(ValueError):
                    launchd.plan(registry, ROOT)

    def test_a_command_token_with_no_slash_is_a_bare_word(self) -> None:
        """`--no-open` is a flag, not a path. Only a token with a slash in it is helm's own."""
        self.assertEqual(launchd.program(["dashboard/serve.py", "--no-open"], ROOT),
                         (str(ROOT / "dashboard/serve.py"), "--no-open"))
        with self.assertRaises(ValueError):
            launchd.program([], ROOT)


class PlistTest(unittest.TestCase):
    def test_a_daily_routine_fires_on_the_calendar_at_its_hour_and_minute(self) -> None:
        job = read("com.helm.integrity-check")
        self.assertEqual(job["StartCalendarInterval"], {"Hour": 7, "Minute": 0})
        self.assertIs(job["RunAtLoad"], False)
        self.assertNotIn("StartInterval", job)

    def test_an_on_mount_routine_also_fires_whenever_a_volume_mounts(self) -> None:
        job = read("com.helm.backup")
        self.assertEqual(job["StartCalendarInterval"], {"Hour": 9, "Minute": 0})
        self.assertIs(job["StartOnMount"], True)
        self.assertNotIn("StartOnMount", read("com.helm.integrity-check"))

    def test_an_interval_routine_also_runs_at_load_so_waking_up_refreshes(self) -> None:
        """launchd does not fire a missed StartInterval on wake. Without RunAtLoad a laptop
        that slept through a run serves a stale snapshot until the next one."""
        job = read("com.helm.capture")
        self.assertEqual(job["StartInterval"], 1800)
        self.assertIs(job["RunAtLoad"], True)
        self.assertNotIn("StartCalendarInterval", job)

    def test_the_service_is_kept_alive_with_a_bounded_throttle(self) -> None:
        job = read("com.helm.dashboard")
        self.assertIs(job["RunAtLoad"], True)
        self.assertIs(job["KeepAlive"], True)
        self.assertEqual(job["ThrottleInterval"], 15)
        self.assertEqual(job["ProgramArguments"], [str(ROOT / "dashboard/serve.py"), "--no-open"])
        self.assertNotIn("StartInterval", job)
        self.assertNotIn("StartCalendarInterval", job)

    def test_every_job_works_from_the_engine_root_and_logs_to_the_state_folder(self) -> None:
        for label in ("com.helm.integrity-check", "com.helm.capture", "com.helm.dashboard"):
            with self.subTest(label=label):
                job = read(label)
                self.assertEqual(job["Label"], label)
                self.assertEqual(job["WorkingDirectory"], str(ROOT))
                self.assertEqual(job["StandardOutPath"], str(HOME / ".helm/logs" / f"{label}.out"))
                self.assertEqual(job["StandardErrorPath"], str(HOME / ".helm/logs" / f"{label}.err"))
                self.assertEqual(job["EnvironmentVariables"]["HOME"], str(HOME))
                self.assertIn("/usr/local/bin:/opt/homebrew/bin", job["EnvironmentVariables"]["PATH"])

    def test_no_generated_path_names_a_machine_beyond_the_root_it_was_handed(self) -> None:
        """Host portability, checked rather than described: moving helm to another machine is a
        re-run of the installer, so nothing in a plist may come from anywhere but the root and
        the home directory passed in."""
        for label in ("com.helm.integrity-check", "com.helm.capture", "com.helm.dashboard"):
            with self.subTest(label=label):
                for token in text(label).split("<string>"):
                    value = token.split("</string>")[0]
                    if not value.startswith("/"):
                        continue
                    self.assertTrue(
                        value.startswith((str(ROOT), str(HOME), "/usr/", "/bin", "/opt/homebrew")),
                        f"{value} in {label} is an absolute path from outside the root")


if __name__ == "__main__":
    unittest.main()
