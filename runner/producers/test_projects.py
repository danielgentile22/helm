"""The projects join, against a copy of the demo vault and real git repos in a temp folder.

GitHub is a fake: `github.gh` is replaced, so nothing here calls the network.

    python3 -m unittest runner/producers/test_projects.py
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
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import capture  # noqa: E402
import common  # noqa: E402
import frontmatter  # noqa: E402
import idea_edit  # noqa: E402
from sources import github, projects  # noqa: E402

DEMO = common.ENGINE / "demo-vault"
SCRATCH = HERE / "fixtures" / "compiler" / ".scratch"
JORDAN = "jordan@example.com"
PRIYA = "priya@example.com"
NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)


def sh(cwd: Path, *argv: str, email: str = JORDAN, when: str = "2026-11-01T10:00:00+00:00") -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": email.split("@")[0], "GIT_AUTHOR_EMAIL": email,
           "GIT_COMMITTER_NAME": email.split("@")[0], "GIT_COMMITTER_EMAIL": email,
           "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True,
                          env=env).stdout.strip()


def repo(path: Path, remote: str | None) -> Path:
    path.mkdir(parents=True)
    sh(path, "init", "-q", "-b", "main")
    sh(path, "config", "user.email", JORDAN)
    if remote:
        sh(path, "remote", "add", "origin", f"https://github.com/{remote}.git")
    (path / "README.md").write_text(f"{path.name}\n")
    sh(path, "add", "README.md")
    sh(path, "commit", "-q", "-m", "Start")
    return path


def branch(path: Path, name: str, email: str, when: str, commits: int = 1) -> None:
    sh(path, "checkout", "-q", "-b", name)
    for n in range(commits):
        (path / f"{name}-{n}.txt").write_text("x\n")
        sh(path, "add", ".")
        sh(path, "commit", "-q", "-m", f"Work on {name} {n}", email=email, when=when)
    sh(path, "checkout", "-q", "main")


def check(conclusion: str, status: str = "COMPLETED") -> dict:
    return {"__typename": "CheckRun", "status": status, "conclusion": conclusion}


PULLS = {
    "example/keel": [
        {"number": 7, "title": "Export leads as CSV", "url": "https://github.com/example/keel/pull/7",
         "isDraft": False, "author": {"login": "jordan"}, "headRefName": "lead-export",
         "statusCheckRollup": [check("SUCCESS")]},
        {"number": 8, "title": "Alex's tweak", "url": "https://github.com/example/keel/pull/8",
         "isDraft": True, "author": {"login": "alex-reed"}, "headRefName": "tweak", "statusCheckRollup": []},
    ],
    "example/compiler-importer": [
        {"number": 3, "title": "Stream PGN", "url": "https://github.com/example/compiler-importer/pull/3",
         "isDraft": False, "author": {"login": "jordan"}, "headRefName": "stream-pgn",
         "statusCheckRollup": [check("SUCCESS"), check("FAILURE")]},
        {"number": 4, "title": "Priya's board", "url": "https://github.com/example/compiler-importer/pull/4",
         "isDraft": False, "author": {"login": "priya"}, "headRefName": "priya-board",
         "statusCheckRollup": [check("", status="IN_PROGRESS")]},
    ],
    "example/compiler-explorer": [],
}
ISSUES = {
    "example/keel": [
        {"number": 12, "title": "Triage view is slow", "url": "https://github.com/example/keel/issues/12",
         "labels": [{"name": "ready-for-agent"}], "updatedAt": "2026-11-02T09:00:00Z"},
        {"number": 13, "title": "Alex wants a weekly email", "url": "https://github.com/example/keel/issues/13",
         "labels": [], "updatedAt": "2026-11-03T09:00:00Z"},
    ],
}


class FakeGitHub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.down = False

    def __call__(self, *args: str) -> str:
        self.calls.append(args)
        if self.down:
            raise common.SourceError("network", "gh pr list: could not resolve api.github.com")
        if args[:2] == ("api", "user"):
            return "jordan\n"
        table = PULLS if args[0] == "pr" else ISSUES
        return json.dumps(table.get(args[3], []))


class ProjectsTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name).resolve()
        self.vault = root / "vault"
        shutil.copytree(DEMO, self.vault)
        self.projects_dir = root / "Projects"
        self.status = root / "state" / "status"

        keel = repo(self.projects_dir / "keel", "example/keel")
        branch(keel, "lead-export", JORDAN, "2026-11-03T10:00:00+00:00", commits=2)

        compiler = self.projects_dir / "compiler"
        shutil.copytree(SCRATCH, compiler / ".scratch")
        importer = repo(compiler / "repos" / "importer", "example/compiler-importer")
        branch(importer, "stream-pgn", JORDAN, "2026-11-02T10:00:00+00:00")
        branch(importer, "priya-board", PRIYA, "2026-11-04T08:00:00+00:00")
        repo(compiler / "repos" / "explorer", "example/compiler-explorer")

        repo(self.projects_dir / "team-wiki", None)
        (self.projects_dir / "lisbon-planner").mkdir()
        (self.projects_dir / "scratchpad").mkdir()

        self.gh = FakeGitHub()
        for module, name, value in ((common, "VAULT", self.vault), (common, "PROJECTS_DIR", self.projects_dir),
                                    (common, "STATUS", self.status),
                                    (common, "SOURCES_DIR", self.status / "sources"),
                                    (github, "gh", self.gh), (capture, "cadence", lambda: 1800)):
            self.addCleanup(setattr, module, name, getattr(module, name))
            setattr(module, name, value)
        quiet = {n: (lambda env, now: []) for n in ("routines", "repos")}
        self.addCleanup(setattr, capture, "SOURCES", capture.SOURCES)
        capture.SOURCES = {**capture.SOURCES, **quiet}

    def joined(self) -> dict[str, dict]:
        rows = projects.join(projects.collect({}, NOW), github.collect({}, NOW),
                             [i.to_row() for i in idea_edit.load_ideas(self.vault)])
        return {p["slug"]: p for p in rows}

    def test_notes_join_their_repos_and_a_folder_with_no_note_is_drift(self) -> None:
        found = self.joined()
        self.assertEqual(sorted(found), ["compiler", "keel", "scratchpad", "team-wiki"])
        self.assertEqual(found["scratchpad"]["note"], None)
        self.assertEqual(found["scratchpad"]["tracker"], "none")
        self.assertEqual(found["keel"]["note"], "Atlas/Projects/Keel.md")
        self.assertEqual([r["name"] for r in found["compiler"]["repos"]], ["explorer", "importer"])
        self.assertEqual(found["team-wiki"]["tracker"], "none")
        self.assertIsNone(found["team-wiki"]["issues"])
        self.assertEqual(found["keel"]["ideas_open"], 1)
        self.assertEqual(found["compiler"]["ideas_open"], 2)

    def test_an_archived_note_leaves_out_its_project_and_its_folder(self) -> None:
        self.assertNotIn("lisbon-planner", self.joined())
        self.assertNotIn("lisbon-planner", [p.slug for p in projects.resolve(self.vault, self.projects_dir)])

    def test_a_folder_on_the_registry_ignore_list_is_not_a_project(self) -> None:
        repo(self.projects_dir / "keel-copy", "example/keel-copy")
        (self.vault / "Atlas" / "Projects" / "_registry-ignore.md").write_text(
            "# Not projects\n\nProse lines are ignored.\n- `~/Projects/keel-copy`\n")
        self.assertNotIn("keel-copy", [p.slug for p in projects.resolve(self.vault, self.projects_dir)])

    def test_pinned_first_then_the_most_recent_work(self) -> None:
        order = [p["slug"] for p in projects.join(projects.collect({}, NOW), [], [])]
        self.assertEqual(order[0], "keel")
        self.assertLess(order.index("compiler"), order.index("team-wiki"))
        self.assertEqual(order[-1], "scratchpad")

    def test_a_scratch_tracker_reads_its_open_issue_files(self) -> None:
        compiler = self.joined()["compiler"]
        self.assertEqual(compiler["tracker"], "scratch")
        self.assertEqual(compiler["issues"], {"open": 3, "by_status": {"needs-triage": 1, "open": 1,
                                                                       "ready-for-agent": 1}})
        by_id = {i["id"]: i for i in compiler["issues_list"]}
        self.assertEqual(sorted(by_id), ["explorer/01", "explorer/02", "importer/01"])
        self.assertEqual(by_id["importer/01"]["title"], "Stream large PGN files instead of loading them whole")
        self.assertEqual(by_id["importer/01"]["repo"], "importer")
        self.assertEqual(by_id["explorer/01"]["repo"], "explorer")
        self.assertIsNone(by_id["explorer/02"]["repo"])
        self.assertTrue(by_id["importer/01"]["path"].endswith(".scratch/importer/issues/01-stream-large-pgn-files.md"))

    def test_a_scratch_tracker_never_asks_github_for_issues(self) -> None:
        self.joined()
        asked = [c[3] for c in self.gh.calls if c[0] == "issue"]
        self.assertEqual(asked, ["example/keel"])

    def test_a_github_tracker_lists_its_issues_by_triage_label(self) -> None:
        keel = self.joined()["keel"]
        self.assertEqual(keel["issues"], {"open": 2, "by_status": {"ready-for-agent": 1, "open": 1}})
        self.assertEqual(keel["issues_list"][0]["id"], "keel#12")
        self.assertEqual(keel["issues_list"][0]["url"], "https://github.com/example/keel/issues/12")

    def test_mine_keeps_only_the_owner_s_pull_requests_and_branches(self) -> None:
        found = self.joined()
        compiler = found["compiler"]
        self.assertEqual([(p["repo"], p["number"]) for p in compiler["pull_requests"]], [("importer", 3)])
        self.assertEqual([b["name"] for b in compiler["branches"]], ["stream-pgn"])
        self.assertEqual(compiler["last_commit"]["subject"], "Work on priya-board 0")

        keel = found["keel"]
        self.assertEqual([p["number"] for p in keel["pull_requests"]], [7, 8])
        self.assertEqual(keel["branches"], [{"repo": "keel", "name": "lead-export", "ahead": 2,
                                             "at": "2026-11-03T10:00:00+00:00"}])

    def test_ci_is_reduced_to_one_word(self) -> None:
        pr = {p["number"]: p for p in self.joined()["compiler"]["pull_requests"]}
        self.assertEqual(pr[3]["ci"], "fail")
        cases = [([], "none"), (None, "none"), ([check("SUCCESS"), check("SKIPPED")], "pass"),
                 ([check("SUCCESS"), check("", "QUEUED")], "pending"),
                 ([check("FAILURE"), check("", "IN_PROGRESS")], "fail"),
                 ([{"__typename": "StatusContext", "state": "PENDING"}], "pending"),
                 ([{"__typename": "StatusContext", "state": "ERROR"}], "fail"),
                 ([{"__typename": "StatusContext", "state": "SUCCESS"}, check("NEUTRAL")], "pass")]
        for rollup, want in cases:
            with self.subTest(rollup=rollup):
                self.assertEqual(github.ci(rollup), want)

    def test_github_down_keeps_the_last_pull_requests_and_says_why(self) -> None:
        self.assertEqual(capture.main([]), 0)
        self.gh.down = True
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(capture.main([]), 1)
        merged = json.loads((self.status / "projects.json").read_text())
        self.assertFalse(merged["sources"]["github"]["ok"])
        self.assertIn("network", merged["sources"]["github"]["reason"])
        self.assertTrue(merged["sources"]["projects"]["ok"])
        keel = next(p for p in merged["projects"] if p["slug"] == "keel")
        self.assertEqual([p["number"] for p in keel["pull_requests"]], [7, 8])
        self.assertEqual(keel["issues"]["open"], 2)

    def test_github_never_answered_means_unknown_issues_not_zero(self) -> None:
        keel = {p["slug"]: p for p in projects.join(projects.collect({}, NOW), [], [])}["keel"]
        self.assertIsNone(keel["issues"])
        self.assertEqual(keel["pull_requests"], [])

    def test_a_bad_field_is_reported_and_read_as_the_default(self) -> None:
        note = self.vault / "Atlas" / "Projects" / "Team Wiki.md"
        note.write_text(note.read_text().replace("status: active\n", "status: active\ntracker: jira\n"))
        wiki = {p.slug: p for p in projects.resolve(self.vault, self.projects_dir)}["team-wiki"]
        self.assertEqual(wiki.tracker, "none")
        self.assertEqual(len(wiki.problems), 1)
        self.assertIn("jira", wiki.problems[0])


class FrontmatterTest(unittest.TestCase):
    def test_the_subset_the_vault_uses(self) -> None:
        fields, body = frontmatter.split(
            "---\ntype: device\ntitle: \"Desk: display\"\nstatus: in service   # ordered | in service\n"
            "tags: [device, \"a, b\", demo]\nspecs:\n  chip: M5 Max\n  bays: \"2\"\naliases:\n  - Desk\n"
            "  - Screen\nempty:\nbroken line\n---\n# Body\n")
        self.assertEqual(fields, {"type": "device", "title": "Desk: display", "status": "in service",
                                  "tags": ["device", "a, b", "demo"], "specs": {"chip": "M5 Max", "bays": "2"},
                                  "aliases": ["Desk", "Screen"], "empty": ""})
        self.assertEqual(body, "# Body\n")

    def test_what_it_writes_it_reads_back(self) -> None:
        value = {"title": "yes", "tags": ["a b", "c"], "specs": {"chip": "M5: Max"}, "due": "2026-11-15"}
        text = "---\n" + "\n".join(frontmatter.line(k, v) for k, v in value.items()) + "\n---\nbody\n"
        self.assertEqual(frontmatter.split(text)[0], value)


if __name__ == "__main__":
    unittest.main()
