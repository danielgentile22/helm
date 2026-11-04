"""Projects: every project note in the vault, joined to the local facts of its repos.

A project is a note with `type: project` anywhere in Atlas (shape in docs/data-shapes.md).
Its `repo` is one git repo or a workspace folder whose `repos/` holds several. A folder
under ~/Projects that no project note names still becomes a project, titled by the
folder and with `note: null`, so drift between the vault and the disk is visible. A note
whose `status` is `archived` is left out, and so is the folder it names.

Local only: notes, git and `.scratch/` files. Everything GitHub knows comes from the
`github` source, and `join` puts the two together for projects.json, so a GitHub outage
keeps these rows fresh and only the pull requests go stale (ADR 0020).

Row contract, one per project:

    {"slug": str, "title": str, "note": "Atlas/.../<note>.md" | None,
     "status": "active" | "dormant" | "shipped" | None, "pinned": bool,
     "tracker": "github" | "scratch" | "none", "pull_requests_scope": "all" | "mine",
     "repos": [{"name": str, "path": "~/Projects/...", "github": "owner/repo" | None}],
     "scratch_issues": [Issue] | None (open ones, for a scratch tracker),
     "branches": [{"repo", "name", "ahead": int, "at": ISO}],
     "last_commit": {"at": ISO, "repo": str, "subject": str} | None,
     "problems": [str] (fields in the note this could not use, and what it did instead)}

    Issue: {"id": "<effort>/<NN>" | "<repo>#<n>", "title", "status", "url" | None,
            "path": "~/..." | None, "repo": str | None, "updated": ISO | None}
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Literal, get_args

import common
import frontmatter
from sources.repos import default_branch, git, github_slug, is_workspace, project_dirs, tilde

Tracker = Literal["github", "scratch", "none"]
Scope = Literal["all", "mine"]
TRACKERS: tuple[Tracker, ...] = get_args(Tracker)
SCOPES: tuple[Scope, ...] = get_args(Scope)
NOTE_STATUSES = ("active", "dormant", "shipped", "archived")
CLOSED_STATUSES = {"resolved", "wontfix", "done"}
TRIAGE_LABELS = ("needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix")

STATUS_LINE = re.compile(r"^Status:\s*(?P<v>.+?)\s*$", re.MULTILINE | re.IGNORECASE)
REPO_LINE = re.compile(r"^Repo:\s*(?P<v>.+?)\s*$", re.MULTILINE | re.IGNORECASE)
HEADING = re.compile(r"^# (?P<v>.+?)\s*$", re.MULTILINE)
NUMBER = re.compile(r"^(\d+)")


@dataclass(frozen=True)
class Repo:
    name: str
    path: Path
    github: str | None

    def row(self) -> dict:
        return {"name": self.name, "path": tilde(self.path), "github": self.github}


@dataclass(frozen=True)
class Project:
    slug: str
    title: str
    note: str | None
    status: str | None
    pinned: bool
    tracker: Tracker
    scope: Scope
    root: Path | None
    repos: tuple[Repo, ...]
    problems: tuple[str, ...] = ()


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", re.sub(r"['’]", "", text.lower())).strip("-") or "project"


def expand(repo: str) -> Path:
    """A note's `repo:` as a path. Notes write `~/Projects/<name>`, which resolves against
    PROJECTS_DIR so a test that moves the projects folder moves this with it."""
    path = Path(repo).expanduser()
    try:
        return common.PROJECTS_DIR / path.relative_to(Path.home() / "Projects")
    except ValueError:
        return path


def repos_of(root: Path | None) -> tuple[Repo, ...]:
    if root is None or not root.is_dir():
        return ()
    if (root / ".git").exists():
        return (Repo(root.name, root, github_slug(root)),)
    members = root / "repos"
    if is_workspace(root) and members.is_dir():
        return tuple(Repo(p.name, p, github_slug(p)) for p in sorted(members.iterdir())
                     if p.is_dir() and (p / ".git").exists())
    return ()


def scratch_files(root: Path | None) -> list[Path]:
    return sorted((root / ".scratch").glob("*/issues/*.md")) if root is not None else []


def default_tracker(root: Path | None, repos: tuple[Repo, ...]) -> Tracker:
    """A local tracker wins when there is one (GLOSSARY: Tracker), then GitHub, then none."""
    if scratch_files(root):
        return "scratch"
    return "github" if any(r.github for r in repos) else "none"


def choice(fields: dict, key: str, allowed: tuple[str, ...], fallback: str | None,
           problems: list[str]) -> str | None:
    value = frontmatter.text_of(fields.get(key))
    if value is None:
        return fallback
    if value.lower() in allowed:
        return value.lower()
    problems.append(f"{key}: {value!r} is not one of {', '.join(allowed)}; read as {fallback or 'unset'}")
    return fallback


def resolve(vault: Path, projects_dir: Path) -> list[Project]:
    """Every project the tab shows: the live notes, then the folders no note names."""
    out: list[Project] = []
    claimed: set[Path] = set()
    for rel, fields, _ in frontmatter.typed_notes(vault, "project"):
        problems: list[str] = []
        repo = frontmatter.text_of(fields.get("repo"))
        root = expand(repo) if repo else None
        if root is not None:
            claimed.add(root.resolve())
        status = choice(fields, "status", NOTE_STATUSES, None, problems)
        if status == "archived":
            continue
        repos = repos_of(root)
        title = frontmatter.text_of(fields.get("title")) or Path(rel).stem
        tracker = choice(fields, "tracker", TRACKERS, None, problems) or default_tracker(root, repos)
        out.append(Project(
            slug=slugify(title), title=title, note=rel, status=status,
            pinned=frontmatter.text_of(fields.get("pinned")) in ("true", "yes"),
            tracker=tracker,  # type: ignore[arg-type]
            scope=choice(fields, "pull_requests", SCOPES, "all", problems),  # type: ignore[arg-type]
            root=root, repos=repos, problems=tuple(problems)))
    if projects_dir.is_dir():
        for folder in project_dirs(projects_dir):
            if folder.resolve() in claimed:
                continue
            repos = repos_of(folder)
            out.append(Project(slug=slugify(folder.name), title=folder.name, note=None, status=None,
                               pinned=False, tracker=default_tracker(folder, repos), scope="all",
                               root=folder, repos=repos))
    return dedupe_slugs(out)


def dedupe_slugs(projects: list[Project]) -> list[Project]:
    """The slug is the route's address, so two projects never share one."""
    seen: Counter[str] = Counter()
    out = []
    for p in projects:
        seen[p.slug] += 1
        out.append(p if seen[p.slug] == 1 else
                   replace(p, slug=f"{p.slug}-{seen[p.slug]}"))
    return out


def scratch_issue(path: Path, now: datetime) -> dict:
    text = path.read_text(errors="replace")
    heading = HEADING.search(text)
    status = STATUS_LINE.search(text)
    repo = REPO_LINE.search(text)
    number = NUMBER.match(path.stem)
    return {
        "id": f"{path.parent.parent.name}/{number.group(1) if number else path.stem}",
        "title": heading.group("v") if heading else path.stem,
        "status": status.group("v").lower() if status else "open",
        "url": None,
        "path": tilde(path),
        "repo": repo.group("v") if repo else None,
        "updated": common.iso(datetime.fromtimestamp(path.stat().st_mtime, now.tzinfo)),
    }


def open_scratch_issues(root: Path | None, now: datetime) -> list[dict]:
    issues = (scratch_issue(p, now) for p in scratch_files(root))
    return [i for i in issues if i["status"] not in CLOSED_STATUSES]


def owner_email(repo: Repo) -> str | None:
    email = git(repo.path, "config", "user.email")
    return email.lower() if email else None


def branches(repo: Repo, scope: Scope) -> list[dict]:
    """Local branches not merged into the default branch. With `mine`, only those whose
    last commit the owner authored, by the email git commits as in that repo."""
    name, ref = default_branch(repo.path)
    if ref is None:
        return []
    listing = git(repo.path, "for-each-ref", "--no-merged", ref, "refs/heads",
                  "--format=%(refname:short)%09%(committerdate:iso-strict)%09%(authoremail)")
    mine = owner_email(repo) if scope == "mine" else None
    out = []
    for line in (listing or "").splitlines():
        branch, at, email = (line.split("\t") + ["", ""])[:3]
        if branch == name:
            continue
        if scope == "mine" and (mine is None or email.strip("<>").lower() != mine):
            continue
        ahead = git(repo.path, "rev-list", "--count", f"{ref}..refs/heads/{branch}")
        out.append({"repo": repo.name, "name": branch, "ahead": int(ahead) if ahead and ahead.isdigit() else 0,
                    "at": common.iso(datetime.fromisoformat(at))})
    return out


def last_commit(repos: tuple[Repo, ...]) -> dict | None:
    """The newest commit on any local branch of any of the project's repos."""
    newest = None
    for repo in repos:
        out = git(repo.path, "log", "-1", "--branches", "--format=%cI%x09%s")
        if not out or "\t" not in out:
            continue
        at, subject = out.split("\t", 1)
        if newest is None or datetime.fromisoformat(at) > datetime.fromisoformat(newest["at"]):
            newest = {"at": common.iso(datetime.fromisoformat(at)), "repo": repo.name, "subject": subject}
    return newest


def row(p: Project, now: datetime) -> dict:
    return {
        "slug": p.slug,
        "title": p.title,
        "note": p.note,
        "status": p.status,
        "pinned": p.pinned,
        "tracker": p.tracker,
        "pull_requests_scope": p.scope,
        "repos": [r.row() for r in p.repos],
        "scratch_issues": open_scratch_issues(p.root, now) if p.tracker == "scratch" else None,
        "branches": sorted((b for r in p.repos for b in branches(r, p.scope)),
                           key=lambda b: b["at"], reverse=True),
        "last_commit": last_commit(p.repos),
        "problems": list(p.problems),
    }


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    return [row(p, now) for p in resolve(common.VAULT, common.PROJECTS_DIR)]


def _activity(entry: dict) -> str:
    stamps = [entry["last_commit"]["at"]] if entry["last_commit"] else []
    stamps += [b["at"] for b in entry["branches"]]
    return max(stamps, key=datetime.fromisoformat) if stamps else ""


def github_issue(repo: str, issue: dict) -> dict:
    labels = issue.get("labels") or []
    status = next((label for label in TRIAGE_LABELS if label in labels), "open")
    return {"id": f"{repo}#{issue['number']}", "title": issue["title"], "status": status,
            "url": issue.get("url"), "path": None, "repo": repo, "updated": issue.get("updated")}


def join(local: list[dict], github: list[dict], ideas: list[dict]) -> list[dict]:
    """projects.json's `projects`: each local row with its pull requests and GitHub issues
    from the github source and its count of open ideas, pinned first, then the most
    recently worked on. A repo GitHub has not answered for yet has no pull requests, and a
    GitHub tracker with no answer at all has `issues: null` rather than a zero."""
    by_slug = {g["repo"]: g for g in github}
    ideas_open = Counter(i.get("project") for i in ideas if i.get("status", "open") == "open")
    out = []
    for p in local:
        pull_requests: list[dict] = []
        gh_issues: list[dict] = []
        answered = False
        for repo in p["repos"]:
            g = by_slug.get(repo["github"]) if repo["github"] else None
            if g is None:
                continue
            for pr in g["pull_requests"]:
                if p["pull_requests_scope"] == "mine" and pr["author"] != g["viewer"]:
                    continue
                pull_requests.append({"repo": repo["name"], **pr})
            if g["issues"] is not None:
                answered = True
                gh_issues += [github_issue(repo["name"], i) for i in g["issues"]]
        if p["tracker"] == "scratch":
            issues_list = p["scratch_issues"] or []
        elif p["tracker"] == "github" and answered:
            issues_list = gh_issues
        else:
            issues_list = None
        entry = {k: v for k, v in p.items() if k != "scratch_issues"}
        entry.update({
            "issues": None if issues_list is None else
            {"open": len(issues_list), "by_status": dict(Counter(i["status"] for i in issues_list))},
            "pull_requests": pull_requests,
            "ideas_open": ideas_open.get(p["title"], 0),
            "issues_list": issues_list or [],
        })
        out.append(entry)
    out.sort(key=lambda e: (not e["pinned"], _neg(_activity(e)), e["title"].lower()))
    return out


def _neg(stamp: str) -> float:
    """Newest first: the negated epoch, with no activity at all sorting last."""
    return -datetime.fromisoformat(stamp).timestamp() if stamp else float("inf")
