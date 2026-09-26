"""The states the service check reports, with the probes injected.

Nothing here runs `launchctl` and nothing opens a socket: `problems` takes the two questions
it asks as functions, so the states can be produced on demand.

    python3 -m unittest discover -s runner -p 'test_*.py'
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "checks"))

import check_service  # noqa: E402

REGISTRY = {"services": {"dashboard": {"command": ["dashboard/serve.py"], "throttle_s": 15},
                         "voice": {"command": ["voice/server.py"], "throttle_s": 30}}}

def LOADED(label: str) -> bool:
    return True


def ABSENT(label: str) -> bool:
    return False


def ANSWERS(name: str) -> bool:
    return True


def SILENT(name: str) -> bool:
    return False


class CheckServiceTest(unittest.TestCase):
    def test_installed_and_answering_says_nothing(self) -> None:
        """Silence is the passing case. A routine that writes something every day is a routine
        you stop reading."""
        self.assertEqual(check_service.problems(REGISTRY, LOADED, ANSWERS), [])

    def test_installed_and_silent_names_the_log_to_read(self) -> None:
        found = check_service.problems(REGISTRY, LOADED, SILENT)
        self.assertEqual(len(found), 2)
        self.assertIn("com.helm.dashboard is loaded but nothing answers", found[0])
        self.assertIn("8642", found[0])
        self.assertIn("~/.helm/logs/com.helm.dashboard.err", found[0])
        self.assertIn("com.helm.voice is loaded but nothing answers", found[1])
        self.assertIn("3108/health", found[1])

    def test_a_service_with_no_probe_is_checked_for_its_agent_only(self) -> None:
        registry = {"services": {"sync": {"command": ["scripts/sync.sh"], "throttle_s": 15}}}
        self.assertEqual(check_service.problems(registry, LOADED, SILENT), [])
        self.assertEqual(len(check_service.problems(registry, ABSENT, SILENT)), 1)

    def test_named_in_the_registry_but_never_installed_names_the_installer(self) -> None:
        found = check_service.problems(REGISTRY, ABSENT, ANSWERS)
        self.assertEqual(len(found), 2)
        self.assertIn("no launchd agent is loaded", found[0])
        self.assertIn("runner/install-routines.sh", found[0])

    def test_a_registry_with_no_services_has_nothing_to_check(self) -> None:
        self.assertEqual(check_service.problems({"routines": {}}, ABSENT, SILENT), [])

    def test_every_line_says_what_is_wrong_in_words(self) -> None:
        """No state here may be carried by colour, so every reported line starts with
        the word FAIL and reads on its own."""
        for loaded, reachable in ((LOADED, SILENT), (ABSENT, ANSWERS)):
            for line in check_service.problems(REGISTRY, loaded, reachable):
                self.assertTrue(line.startswith("FAIL  "), line)
                self.assertNotIn("\x1b[", line)


if __name__ == "__main__":
    unittest.main()
