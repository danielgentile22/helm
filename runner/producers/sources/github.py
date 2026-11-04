"""GitHub: open pull requests for every GitHub repo a project has, and open issues for the
projects whose tracker is GitHub. The only source that calls the network.

    gh pr list    -R <repo> --state open --json number,title,url,isDraft,author,headRefName,statusCheckRollup
    gh issue list -R <repo> --state open --json number,title,labels,url,updatedAt --limit 50
    gh api user -q .login     once per run, so `pull_requests: mine` can keep the owner's own

Row contract, one per repo, joined onto the projects rows by `repo` in `projects.join`:

    {"repo": "owner/name", "viewer": login,
     "pull_requests": [{"number", "title", "url", "draft": bool, "ci": "pass"|"fail"|"pending"|"none",
                        "author": login | None, "branch": str}],
     "issues": [{"number", "title", "labels": [str], "url", "updated": ISO}] | None}

`issues` is None for a repo whose project reads another tracker, which is how a
workspace with a local tracker never shows its repos' GitHub issues. Any one call failing
fails the source, so the last good rows stay and the envelope says why (ADR 0020): a row
that read zero pull requests because the network blinked would be worse.
"""
from __future__ import annotations

import json
import subprocess
from datetime import datetime

import common
from sources import projects

GH_TIMEOUT_S = 20
ISSUE_LIMIT = 50
PR_LIMIT = 100
PR_FIELDS = "number,title,url,isDraft,author,headRefName,statusCheckRollup"
ISSUE_FIELDS = "number,title,labels,url,updatedAt"

FAILED = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
PENDING = {"PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"}


def gh(*args: str) -> str:
    """stdout of one `gh` call. The seam the tests replace."""
    try:
        r = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=GH_TIMEOUT_S)
    except subprocess.TimeoutExpired as e:
        raise common.SourceError("timeout", f"gh {' '.join(args[:2])} exceeded {GH_TIMEOUT_S}s") from e
    except OSError as e:
        raise common.SourceError("deps", f"gh not runnable ({e})") from e
    if r.returncode != 0:
        detail = r.stderr.strip() or r.stdout.strip() or f"exit {r.returncode}"
        reason = "auth" if "auth" in detail.lower() else "network"
        raise common.SourceError(reason, f"gh {' '.join(args[:3])}: {detail}")
    return r.stdout


def gh_json(*args: str) -> list:
    out = gh(*args)
    try:
        parsed = json.loads(out)
    except ValueError as e:
        raise common.SourceError("parse", f"gh {' '.join(args[:3])} answered something that is not JSON") from e
    if not isinstance(parsed, list):
        raise common.SourceError("parse", f"gh {' '.join(args[:3])} answered {type(parsed).__name__}, not a list")
    return parsed


def ci(rollup: list | None) -> str:
    """A pull request's checks as one word. Any failure is a fail, then anything unfinished
    is pending, and no checks at all is none."""
    if not rollup:
        return "none"
    states = []
    for check in rollup:
        if check.get("__typename") == "StatusContext" or "state" in check:
            states.append(str(check.get("state") or "").upper())
        elif str(check.get("status") or "").upper() != "COMPLETED":
            states.append("PENDING")
        else:
            states.append(str(check.get("conclusion") or "").upper())
    if any(s in FAILED for s in states):
        return "fail"
    if any(s in PENDING or not s for s in states):
        return "pending"
    return "pass"


def pull_request(pr: dict) -> dict:
    return {"number": pr["number"], "title": pr["title"], "url": pr["url"], "draft": bool(pr.get("isDraft")),
            "ci": ci(pr.get("statusCheckRollup")), "author": (pr.get("author") or {}).get("login"),
            "branch": pr.get("headRefName")}


def issue(raw: dict) -> dict:
    return {"number": raw["number"], "title": raw["title"], "url": raw.get("url"),
            "labels": [label["name"] for label in raw.get("labels") or [] if label.get("name")],
            "updated": raw.get("updatedAt")}


def targets(found: list[projects.Project]) -> dict[str, bool]:
    """Every GitHub repo a project has, and whether its project reads GitHub Issues."""
    wanted: dict[str, bool] = {}
    for p in found:
        for r in p.repos:
            if r.github:
                wanted[r.github] = wanted.get(r.github, False) or p.tracker == "github"
    return wanted


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    wanted = targets(projects.resolve(common.VAULT, common.PROJECTS_DIR))
    if not wanted:
        return []
    viewer = gh("api", "user", "-q", ".login").strip()
    rows = []
    for repo, with_issues in sorted(wanted.items()):
        prs = gh_json("pr", "list", "-R", repo, "--state", "open", "--limit", str(PR_LIMIT), "--json", PR_FIELDS)
        issues = (gh_json("issue", "list", "-R", repo, "--state", "open", "--limit", str(ISSUE_LIMIT),
                          "--json", ISSUE_FIELDS) if with_issues else None)
        rows.append({"repo": repo, "viewer": viewer,
                     "pull_requests": [pull_request(p) for p in prs],
                     "issues": None if issues is None else [issue(i) for i in issues]})
    return rows
