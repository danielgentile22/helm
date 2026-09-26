"""Trackers: open issues and pull requests per project, detected rather than declared.

Detection order, per folder under ~/Projects:

1. A `.scratch/` tree at the folder root wins. Issues are
   `.scratch/<effort>/issues/*.md`; one is open when its `Status:` line is not
   `resolved`, `wontfix`, or `done`. `open_prs` is 0.
2. A git remote on github.com: `gh issue list` and `gh pr list` with `--json number`,
   one call pair per repo, 20 second timeout each. `gh` is authenticated already.
3. Otherwise no tracker: the folder gets no row.

Row contract (joined onto repos by `path` in capture.py):

    {"path": "~/Projects/<name>",
     "tracker": {"kind": "github" | "scratch", "open_issues": int, "open_prs": int,
                 "ref": "owner/repo" | ".scratch"}}

A single repo's `gh` failure is a SourceError("network", ...) for the whole source,
so the cached rows survive and the envelope says why. That is the intended trade: the
alternative is a row that silently reads 0 open issues.
"""
from __future__ import annotations

import re
import subprocess
from datetime import datetime
from pathlib import Path

import common
from sources.repos import github_slug, project_dirs

CLOSED_STATUSES = {"resolved", "wontfix", "done"}
GH_TIMEOUT_S = 20

STATUS_LINE = re.compile(r"^Status:\s*(?P<status>.+?)\s*$", re.MULTILINE)


def scratch_issues(root: Path) -> list[Path]:
    """`.scratch/<effort>/issues/*.md`. A `.scratch` holding only scratch files (notes,
    screenshots) is not a tracker, so the folder falls through to its github remote."""
    return sorted((root / ".scratch").glob("*/issues/*.md"))


def scratch_tracker(root: Path) -> dict:
    open_issues = 0
    for issue in scratch_issues(root):
        m = STATUS_LINE.search(issue.read_text(errors="replace"))
        if m is None or m.group("status").lower() not in CLOSED_STATUSES:
            open_issues += 1
    return {"kind": "scratch", "open_issues": open_issues, "open_prs": 0, "ref": ".scratch"}


def _gh_count(kind: str, owner_repo: str) -> int:
    try:
        r = subprocess.run(
            ["gh", kind, "list", "-R", owner_repo, "--state", "open", "--json", "number", "--jq", "length"],
            capture_output=True, text=True, timeout=GH_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        raise common.SourceError("timeout", f"gh {kind} list {owner_repo} exceeded {GH_TIMEOUT_S}s") from e
    except OSError as e:
        raise common.SourceError("deps", f"gh not runnable ({e})") from e
    out = r.stdout.strip()
    if r.returncode != 0 or not out.isdigit():
        raise common.SourceError("network", f"gh {kind} list {owner_repo}: {r.stderr.strip() or out or 'no count'}")
    return int(out)


def github_tracker(owner_repo: str) -> dict:
    return {"kind": "github",
            "open_issues": _gh_count("issue", owner_repo),
            "open_prs": _gh_count("pr", owner_repo),
            "ref": owner_repo}


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    rows = []
    for path in project_dirs():
        if (path / ".scratch").is_dir() and scratch_issues(path):
            tracker = scratch_tracker(path)
        else:
            slug = github_slug(path)
            if not slug:
                continue
            tracker = github_tracker(slug)
        rows.append({"path": f"~/{path.relative_to(Path.home())}", "tracker": tracker})
    return rows
