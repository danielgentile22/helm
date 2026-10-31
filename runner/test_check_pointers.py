import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "checks"))

import check_pointers  # noqa: E402


class UnmountedTest(unittest.TestCase):
    def setUp(self):
        self.volumes = Path(tempfile.mkdtemp())
        (self.volumes / "Plugged").mkdir()

    def test_path_on_a_drive_that_is_not_plugged_in_is_unmounted(self):
        self.assertTrue(check_pointers.unmounted(self.volumes / "Unplugged" / "Backup", self.volumes))

    def test_path_on_a_plugged_in_drive_is_checked(self):
        self.assertFalse(check_pointers.unmounted(self.volumes / "Plugged" / "Gone", self.volumes))

    def test_the_volumes_folder_itself_and_other_paths_are_checked(self):
        self.assertFalse(check_pointers.unmounted(self.volumes, self.volumes))
        self.assertFalse(check_pointers.unmounted(Path.home() / "Vault", self.volumes))


class SkipTest(unittest.TestCase):
    def test_placeholders_are_not_pointers(self):
        for raw in ("~/Desktop/Job Apps/{Company} - {Job Title}/", "~/Projects/<name>", "Inbox/runs/*.md"):
            self.assertTrue(check_pointers.SKIP.search(raw), raw)

    def test_a_plain_path_is_a_pointer(self):
        self.assertFalse(check_pointers.SKIP.search("~/Projects/helm/CLAUDE.md"))


if __name__ == "__main__":
    unittest.main()
