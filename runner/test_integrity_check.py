"""The integrity check routine, run for real against a stub engine, vault and model.

The script is copied into a throwaway engine whose checks print canned lines, so these
cases control what fails. A stub `claude` on the PATH counts the model calls."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "routines" / "integrity-check.sh"

CHECK = """import os, sys
text = open(os.environ["STUB_FAILS"]).read() if "{name}" == "check_pointers" else "PASS  stub\\n"
print(text, end="")
sys.exit(1 if "FAIL" in text else 0)
"""

CLAUDE = """#!/bin/bash
echo call >> "$STUB_CALLS"
[ -f "$STUB_CLAUDE_FAILS" ] && exit 1
echo "- the stub explanation"
"""

GIT_ID = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
          "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}


class IntegrityCheckTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.home, self.vault, self.engine, self.bin = (self.root / n for n in ("home", "vault", "engine", "bin"))
        for p in (self.home, self.vault, self.bin):
            p.mkdir()
        (self.engine / "runner" / "routines").mkdir(parents=True)
        shutil.copy(SCRIPT, self.engine / "runner" / "routines")
        (self.engine / "runner" / "checks").mkdir()
        for name in ("check_pointers", "check_links", "check_registry", "check_freshness", "check_service"):
            (self.engine / "runner" / "checks" / f"{name}.py").write_text(CHECK.format(name=name))
        for suite in ("dashboard/server", "runner", "runner/producers", "runner/jobs"):
            (self.engine / suite).mkdir(parents=True, exist_ok=True)
            (self.engine / suite / "test_ok.py").write_text("import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n")
        (self.engine / "dashboard" / "node_modules").mkdir()
        (self.engine / "models.json").write_text(json.dumps({"routines": {"integrity-check": {"model": "m", "effort": "low"}}}))
        for name, body in (("claude", CLAUDE), ("npm", "#!/bin/bash\nexit 0\n")):
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        (self.vault / "note.md").write_text("hello\n")
        for argv in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-qm", "v"]):
            self.git(*argv)
        self.fails = self.root / "fails.txt"
        self.calls = self.root / "calls.txt"
        self.set_failures("FAIL  ~/Vault/PROJECTS.md:3  ~/Projects/gone\n")

    def env(self) -> dict:
        return {"HOME": str(self.home), "PATH": f"{self.bin}:{os.environ['PATH']}", "HELM_VAULT_ROOT": str(self.vault),
                "STUB_FAILS": str(self.fails), "STUB_CALLS": str(self.calls),
                "STUB_CLAUDE_FAILS": str(self.root / "claude-fails"), **GIT_ID}

    def git(self, *argv: str) -> str:
        return subprocess.run(["git", "-C", str(self.vault), *argv], check=True, capture_output=True, text=True,
                              env={**os.environ, **GIT_ID}).stdout

    def set_failures(self, text: str) -> None:
        self.fails.write_text(f"{text}FAIL  1 pointers checked across 1 routers, 1 broken\n" if text else "PASS  all good\n")

    def run_check(self) -> subprocess.CompletedProcess:
        return subprocess.run(["/bin/bash", str(self.engine / "runner" / "routines" / "integrity-check.sh")],
                              env=self.env(), capture_output=True, text=True, timeout=120)

    def model_calls(self) -> int:
        return len(self.calls.read_text().splitlines()) if self.calls.exists() else 0

    def reports(self) -> list[Path]:
        return sorted((self.vault / "Inbox" / "runs" / "integrity").glob("*.md"))

    def test_identical_failures_make_one_model_call(self) -> None:
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.run_check().returncode, 1)
        self.assertEqual(self.model_calls(), 1, "the same failures twice are explained once")
        self.assertIn("the stub explanation", self.reports()[0].read_text(), "the reused explanation is in the report")
        self.set_failures("FAIL  ~/Vault/PROJECTS.md:4  ~/Projects/also-gone\n")
        self.run_check()
        self.assertEqual(self.model_calls(), 2, "new failures are explained again")

    def test_a_failed_model_call_is_retried_next_run(self) -> None:
        (self.root / "claude-fails").write_text("")
        self.run_check()
        (self.root / "claude-fails").unlink()
        self.run_check()
        self.assertEqual(self.model_calls(), 2)
        self.assertIn("the stub explanation", self.reports()[0].read_text())

    def test_the_report_is_committed_and_so_is_its_removal(self) -> None:
        self.run_check()
        self.assertEqual(self.git("status", "--porcelain"), "", "a failing run leaves nothing uncommitted")
        self.assertEqual(len(self.git("ls-files", "Inbox").splitlines()), 1)
        self.set_failures("")
        self.assertEqual(self.run_check().returncode, 0)
        self.assertEqual(self.git("status", "--porcelain"), "", "a passing run commits the removed report")
        self.assertEqual(self.git("ls-files", "Inbox"), "")

    def test_it_commits_only_its_own_output(self) -> None:
        (self.vault / "note.md").write_text("an edit in progress\n")
        self.git("add", "note.md")
        self.run_check()
        self.assertEqual(self.git("status", "--porcelain"), "M  note.md\n", "a staged edit is left staged")


if __name__ == "__main__":
    unittest.main()
