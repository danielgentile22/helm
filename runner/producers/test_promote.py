"""Promotion against a git copy of the demo vault, real git repos in a temp projects folder,
and a fake `gh`. Nothing here calls GitHub or creates a real issue.

    python3 -m unittest runner/producers/test_promote.py
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
import idea_edit  # noqa: E402
from sources import github  # noqa: E402
from sources.repos import tilde  # noqa: E402
from test_projects import SCRATCH, repo  # noqa: E402

DEMO = common.ENGINE / "demo-vault"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"}
KEEL_IDEA = "2026-09-26-export-the-weekly-lead-report-as-csv"
COMPILER_IDEA = "2026-09-26-fix-the-importer-for-large-pgn-files"


def make_projects(root: Path) -> Path:
    """Keel with one GitHub repo, the Compiler workspace with two and a scratch tracker,
    and Team Wiki with no remote."""
    projects_dir = root / "Projects"
    repo(projects_dir / "keel", "example/keel")
    compiler = projects_dir / "compiler"
    shutil.copytree(SCRATCH, compiler / ".scratch")
    repo(compiler / "repos" / "importer", "example/compiler-importer")
    repo(compiler / "repos" / "explorer", "example/compiler-explorer")
    repo(projects_dir / "team-wiki", None)
    return projects_dir


class FakeGh:
    """`gh issue create` answers the next issue URL; `gh api user` answers the login."""

    def __init__(self, login: str = "jordan") -> None:
        self.calls: list[tuple[str, ...]] = []
        self.login = login
        self.down = False

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        if self.down:
            raise common.SourceError("network", "gh issue create: could not resolve api.github.com")
        if args[:2] == ("api", "user"):
            return f"{self.login}\n"
        if args[:2] == ("issue", "create"):
            repo_slug = args[args.index("--repo") + 1]
            n = 11 + len(self.created())
            return f"Creating issue in {repo_slug}\n\nhttps://github.com/{repo_slug}/issues/{n}\n"
        raise AssertionError(f"unexpected gh call {args}")

    def created(self) -> list[tuple[str, ...]]:
        return [c for c in self.calls if c[:2] == ("issue", "create")]


class PromoteTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.vault = root / "vault"
        shutil.copytree(DEMO, self.vault)
        env = mock.patch.dict(os.environ, GIT_ENV)
        env.start()
        self.addCleanup(env.stop)
        self.git("init", "-q")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "start")
        self.projects_dir = make_projects(root)
        self.gh = FakeGh()
        for module, name, value in ((common, "VAULT", self.vault), (common, "STATUS", root / "state" / "status"),
                                    (common, "PROJECTS_DIR", self.projects_dir), (github, "gh", self.gh)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)

    def git(self, *argv: str) -> str:
        return subprocess.run(["git", "-C", str(self.vault), *argv], check=True,
                              capture_output=True, text=True).stdout

    def note(self, stem: str) -> Path:
        return self.vault / "Atlas" / "Ideas" / f"{stem}.md"

    def promote(self, stem: str, repo: str | None = None) -> idea_edit.Promotion:
        return idea_edit.promote(self.vault, self.note(stem), repo)

    def set_tracker(self, project: str, tracker: str) -> None:
        note = self.vault / "Atlas" / "Projects" / f"{project}.md"
        note.write_text(note.read_text().replace("tracker: scratch", f"tracker: {tracker}"))

    def scratch_issues(self) -> Path:
        return self.projects_dir / "compiler" / ".scratch" / "ideas" / "issues"


class GitHubTrackerTest(PromoteTest):
    def test_files_the_issue_records_it_and_commits(self) -> None:
        note = self.note(KEEL_IDEA)
        note.write_text(note.read_text() + "\nSam wants it every Monday.\n")
        self.git("commit", "-qam", "body")
        done = self.promote(KEEL_IDEA)
        self.assertEqual(done.issue, "https://github.com/example/keel/issues/12")
        self.assertTrue(done.changed)
        (call,) = self.gh.created()
        self.assertEqual(call, ("issue", "create", "--repo", "example/keel",
                                "--title", "Export the weekly lead report as CSV",
                                "--body", "Sam wants it every Monday.\n\nPromoted from an idea in helm."))
        self.assertEqual((done.idea.status, done.idea.issue), ("promoted", done.issue))
        text = note.read_text()
        self.assertIn("status: promoted\n", text)
        self.assertIn('issue: "https://github.com/example/keel/issues/12"\n', text)
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "Promote an idea")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_an_idea_with_no_body_sends_only_the_helm_line(self) -> None:
        self.promote(KEEL_IDEA)
        self.assertEqual(self.gh.created()[0][-1], "Promoted from an idea in helm.")

    def test_several_github_repos_need_one_named(self) -> None:
        self.set_tracker("Compiler", "github")
        with self.assertRaisesRegex(idea_edit.IdeaError, "has 2 GitHub repos; name one"):
            self.promote(COMPILER_IDEA)
        with self.assertRaisesRegex(idea_edit.IdeaError, "not a GitHub repo of Compiler"):
            self.promote(COMPILER_IDEA, "example/keel")
        self.assertEqual(self.gh.created(), [])
        done = self.promote(COMPILER_IDEA, "example/compiler-importer")
        self.assertEqual(done.issue, "https://github.com/example/compiler-importer/issues/12")

    def test_an_answer_with_no_issue_url_records_nothing(self) -> None:
        before = self.note(KEEL_IDEA).read_text()
        with mock.patch.object(github, "gh", lambda *a: "something went sideways\n"):
            with self.assertRaisesRegex(idea_edit.TrackerFailed, "no issue URL"):
                self.promote(KEEL_IDEA)
        self.assertEqual(self.note(KEEL_IDEA).read_text(), before)

    def test_gh_failing_writes_nothing(self) -> None:
        self.gh.down = True
        before = self.note(KEEL_IDEA).read_text()
        with self.assertRaises(idea_edit.TrackerFailed):
            self.promote(KEEL_IDEA)
        self.assertEqual(self.note(KEEL_IDEA).read_text(), before)
        self.assertEqual(self.git("status", "--porcelain"), "")


class ScratchTrackerTest(PromoteTest):
    def test_numbers_the_files_and_writes_the_shape(self) -> None:
        first = self.promote(COMPILER_IDEA, "importer")
        second = self.promote("2026-09-26-write-the-release-notes-for-0-4")
        self.assertEqual(sorted(p.name for p in self.scratch_issues().iterdir()),
                         ["01-fix-the-importer-for-large-pgn-files.md", "02-write-the-release-notes-for-0-4.md"])
        made = self.scratch_issues() / "01-fix-the-importer-for-large-pgn-files.md"
        self.assertEqual(made.read_text(), "# Fix the importer for large PGN files\n\n"
                                           "Status: needs-triage\nRepo: importer\n")
        self.assertNotIn("Repo:", (self.scratch_issues() / "02-write-the-release-notes-for-0-4.md").read_text())
        self.assertEqual(first.issue, tilde(made))
        self.assertEqual(second.idea.status, "promoted")
        self.assertEqual(self.gh.calls, [])
        self.assertEqual(self.git("log", "-2", "--format=%s").splitlines(), ["Promote an idea"] * 2)

    def test_the_next_number_follows_the_highest_in_the_folder(self) -> None:
        self.scratch_issues().mkdir(parents=True)
        (self.scratch_issues() / "07-older.md").write_text("# Older\n")
        note = self.note(COMPILER_IDEA)
        note.write_text(note.read_text() + "\nLarge files time out.\n")
        self.promote(COMPILER_IDEA)
        made = self.scratch_issues() / "08-fix-the-importer-for-large-pgn-files.md"
        self.assertEqual(made.read_text(), "# Fix the importer for large PGN files\n\n"
                                           "Status: needs-triage\n\nLarge files time out.\n")

    def test_a_repo_outside_the_workspace_is_refused(self) -> None:
        with self.assertRaisesRegex(idea_edit.IdeaError, "not a repo of Compiler"):
            self.promote(COMPILER_IDEA, "keel")
        self.assertFalse(self.scratch_issues().exists())


class RefusalTest(PromoteTest):
    def test_a_project_with_no_tracker_is_refused(self) -> None:
        idea = idea_edit.add(self.vault, "Add a search box", project="Team Wiki")
        with self.assertRaisesRegex(idea_edit.Refused, "Team Wiki has no tracker"):
            self.promote(idea.id)
        self.assertEqual(self.gh.calls, [])

    def test_only_an_open_project_idea_is_promoted(self) -> None:
        with self.assertRaisesRegex(idea_edit.Refused, "belongs to a project"):
            self.promote("2026-09-26-order-the-desk-lamp")
        idea_edit.set_status(self.vault, self.note(KEEL_IDEA), "done")
        with self.assertRaisesRegex(idea_edit.Refused, "this one is done"):
            self.promote(KEEL_IDEA)
        self.assertEqual(self.gh.calls, [])

    def test_approve_can_stop_it_before_anything_is_filed(self) -> None:
        seen = []

        def approve(to: idea_edit.Target) -> None:
            seen.append(to)
            raise idea_edit.Refused("not today")

        with self.assertRaisesRegex(idea_edit.Refused, "not today"):
            idea_edit.promote(self.vault, self.note(KEEL_IDEA), approve=approve)
        self.assertEqual(seen, [idea_edit.GitHubTarget("example/keel")])
        self.assertEqual(self.gh.created(), [])


class RetryTest(PromoteTest):
    def test_promoting_twice_files_once(self) -> None:
        first = self.promote(KEEL_IDEA)
        again = self.promote(KEEL_IDEA)
        self.assertEqual((again.issue, again.changed, again.commit), (first.issue, False, None))
        self.assertEqual(len(self.gh.created()), 1)
        self.assertEqual(self.git("log", "--format=%s").splitlines().count("Promote an idea"), 1)

    def test_a_failed_commit_keeps_the_issue_and_a_retry_files_no_second(self) -> None:
        hook = self.vault / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        with self.assertRaises(idea_edit.Unrecorded) as caught:
            self.promote(KEEL_IDEA)
        url = "https://github.com/example/keel/issues/12"
        self.assertEqual(caught.exception.issue, url)
        self.assertIn(url, str(caught.exception))
        idea = idea_edit.load(self.vault, self.note(KEEL_IDEA))
        self.assertEqual((idea.status, idea.issue), ("open", url))

        hook.unlink()
        done = self.promote(KEEL_IDEA)
        self.assertEqual((done.issue, done.changed, done.idea.status), (url, True, "promoted"))
        self.assertEqual(len(self.gh.created()), 1)
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(), "Promote an idea")
        self.assertEqual(self.git("status", "--porcelain"), "")

    def test_a_scratch_retry_writes_no_second_file(self) -> None:
        hook = self.vault / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        with self.assertRaises(idea_edit.Unrecorded):
            self.promote(COMPILER_IDEA)
        hook.unlink()
        self.promote(COMPILER_IDEA)
        self.assertEqual(len(list(self.scratch_issues().iterdir())), 1)


class CliTest(PromoteTest):
    def cli(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
             mock.patch.object(idea_edit, "refresh_capture", lambda: None):
            rc = idea_edit.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def test_promote_prints_the_issue(self) -> None:
        rc, out, _ = self.cli("promote", "export-the-weekly-lead-report-as-csv")
        self.assertEqual(rc, 0)
        result = json.loads(out)
        self.assertEqual(result["issue"], "https://github.com/example/keel/issues/12")
        self.assertEqual(result["idea"]["status"], "promoted")
        self.assertRegex(result["commit"], r"^[0-9a-f]{7,}$")

    def test_an_unrecorded_issue_exits_3_and_prints_it(self) -> None:
        hook = self.vault / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\nexit 1\n")
        hook.chmod(0o755)
        rc, out, err = self.cli("promote", KEEL_IDEA)
        self.assertEqual(rc, 3)
        self.assertEqual(json.loads(out), {"issue": "https://github.com/example/keel/issues/12", "recorded": False})
        self.assertIn("promoting again commits it", err)

    def test_none_is_refused_with_exit_2(self) -> None:
        idea = idea_edit.add(self.vault, "Add a search box", project="Team Wiki")
        rc, out, err = self.cli("promote", idea.id)
        self.assertEqual((rc, out), (2, ""))
        self.assertIn("no tracker", err)


if __name__ == "__main__":
    unittest.main()
