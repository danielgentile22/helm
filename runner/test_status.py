import json
import tempfile
import unittest
from pathlib import Path

import status


class WriteTest(unittest.TestCase):
    def setUp(self):
        self.state = Path(tempfile.mkdtemp())

    def read(self):
        return json.loads((self.state / "status" / "capture.json").read_text())

    def test_a_pass_records_its_own_time_as_last_success(self):
        status.write("capture", "pass", 0, state=self.state, now="2026-11-04T09:00:00Z")
        self.assertEqual(self.read()["last_success"], "2026-11-04T09:00:00Z")

    def test_a_failure_keeps_the_previous_last_success(self):
        status.write("capture", "pass", 0, state=self.state, now="2026-11-03T09:00:00Z")
        status.write("capture", "fail", 2, {"report": "r"}, state=self.state, now="2026-11-04T09:00:00Z")
        record = self.read()
        self.assertEqual(record["last_success"], "2026-11-03T09:00:00Z")
        self.assertEqual((record["result"], record["failures"], record["report"]), ("fail", 2, "r"))

    def test_a_first_failure_has_no_last_success(self):
        status.write("capture", "fail", 1, state=self.state)
        self.assertIsNone(self.read()["last_success"])

    def test_extra_fields_cannot_overwrite_last_success(self):
        status.write("capture", "pass", 0, {"last_success": "forged"}, state=self.state, now="2026-11-04T09:00:00Z")
        self.assertEqual(self.read()["last_success"], "2026-11-04T09:00:00Z")

    def test_cli_stores_null_and_strings(self):
        import os
        os.environ["HELM_STATE"] = str(self.state)
        status.STATE = self.state
        self.assertEqual(status.main(["capture", "fail", "1", "report=null", "detail=run.py exited 1"]), 0)
        record = self.read()
        self.assertIsNone(record["report"])
        self.assertEqual(record["detail"], "run.py exited 1")

    def test_rejects_an_unknown_result(self):
        with self.assertRaises(ValueError):
            status.write("capture", "ok", 0, state=self.state)


if __name__ == "__main__":
    unittest.main()
