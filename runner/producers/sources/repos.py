"""Repos: git facts for every folder under ~/Projects, workspaces as one row.

Skips `archive/` and dot-folders. A folder with no `.git` at its root that holds a
`repos/` folder of git repos or a `.scratch/` tree is a workspace (several repos behind one product), and is one
row, not one per member repo. A folder with no git at all is still a row, with the git
fields null, because it is still a project Daniel touches.

Row contract, repo:

    {"kind": "repo", "name": str, "dept": "Projects", "path": "~/Projects/<name>",
     "git": bool, "branch": str | None, "default_branch": str | None,
     "unmerged_commits": int | None (on HEAD, not on the default branch),
     "unpushed_commits": int | None (on HEAD, not on upstream; None when no upstream),
     "dirty": int | None (porcelain lines),
     "touched": ISO | None (max of last commit time and newest mtime among dirty files;
                            the folder's newest mtime when not git),
     "remote": "owner/repo" for github, else the url, else None,
     "last_session": {"at": ISO, "session_id": str, "note": str} | None}

Row contract, workspace:

    {"kind": "workspace", "name": str, "dept": "Projects", "path": "~/Projects/<name>",
     "repos": [names under repos/], "efforts": [slugs under .scratch/],
     "touched": ISO | None (newest across member repos and the .scratch tree),
     "last_session": as above}

`last_session` is the newest note under ~/.helm/status/sessions/<cwd-key>/ for the
folder's path, written by the Stop hook (runner/hooks/session_note.py). `dirty` counts
only the tree, so a note helm writes can never make a repo look dirty.
Paths are tilde form so the file is host-portable.

`touched` is a timestamp, not a day count. The reader subtracts.
"""
from __future__ import annotations

import os
import re
import subprocess
from datetime import datetime
from pathlib import Path

import common

SKIP = {"archive"}
UNSCANNED = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build",
             ".next", ".mypy_cache", ".pytest_cache", "target"}
GITHUB = re.compile(r"github\.com[:/](?P<slug>[^/]+/[^/]+?)(?:\.git)?/?$")


def project_dirs(root: Path = common.PROJECTS_DIR) -> list[Path]:
    """Every project folder, in name order. Skips `archive/` and dot-folders."""
    return [p for p in sorted(root.iterdir())
            if p.is_dir() and p.name not in SKIP and not p.name.startswith(".")]


def git(path: Path, *args: str) -> str | None:
    """stdout of a git command, or None when the folder is not a repo or git failed."""
    if not (path / ".git").exists():
        return None
    r = subprocess.run(["git", "-C", str(path), *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def github_slug(path: Path) -> str | None:
    url = git(path, "remote", "get-url", "origin")
    m = GITHUB.search(url) if url else None
    return m.group("slug") if m else None


def is_workspace(path: Path) -> bool:
    if (path / ".git").exists():
        return False
    members = path / "repos"
    has_members = members.is_dir() and any((p / ".git").exists() for p in members.iterdir() if p.is_dir())
    return has_members or (path / ".scratch").is_dir()


def _cwd_key(path: Path) -> str:
    try:
        rel = path.resolve().relative_to(Path.home())
    except ValueError:
        return str(path).strip("/").replace("/", "__")
    return str(rel).replace("/", "__")


def last_session(path: Path) -> dict | None:
    folder = common.SESSIONS_DIR / _cwd_key(path)
    if not folder.is_dir():
        return None
    notes = sorted(folder.glob("*.md"), key=lambda p: p.stat().st_mtime)
    if not notes:
        return None
    header: dict[str, str] = {}
    body: list[str] = []
    lines = notes[-1].read_text(errors="replace").splitlines()
    for i, line in enumerate(lines):
        if not line.strip():
            body = lines[i + 1:]
            break
        if ":" in line:
            k, v = line.split(":", 1)
            header[k.strip()] = v.strip()
    else:
        body = []
    return {"at": header.get("at", ""), "session_id": header.get("session_id", ""),
            "note": "\n".join(body).strip()}


def _stamp(ts: float, now: datetime) -> datetime:
    return datetime.fromtimestamp(ts, now.tzinfo)


def _newest_mtime(root: Path, now: datetime) -> datetime | None:
    newest: float | None = None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in UNSCANNED and not d.startswith(".")]
        for name in filenames:
            try:
                ts = (Path(dirpath) / name).stat().st_mtime
            except OSError:
                continue
            if newest is None or ts > newest:
                newest = ts
    return _stamp(newest, now) if newest is not None else None


def _dirty_paths(porcelain: str) -> list[str]:
    out = []
    for line in porcelain.splitlines():
        rest = line[3:] if len(line) > 3 else ""
        if " -> " in rest:
            rest = rest.split(" -> ", 1)[1]
        rest = rest.strip().strip('"')
        if rest:
            out.append(rest)
    return out


def _default_branch(path: Path) -> tuple[str | None, str | None]:
    """(name for the row, ref to count against). origin/HEAD first, then main, then master."""
    head = git(path, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    prefix = "refs/remotes/origin/"
    if head and head.startswith(prefix):
        name = head[len(prefix):]
        return name, f"origin/{name}"
    for name in ("main", "master"):
        if git(path, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}") is not None:
            return name, name
    return None, None


def _count(path: Path, rev_range: str) -> int | None:
    out = git(path, "rev-list", "--count", rev_range)
    return int(out) if out and out.isdigit() else None


def _git_touched(path: Path, dirty_paths: list[str], now: datetime) -> datetime | None:
    stamps = []
    last = git(path, "log", "-1", "--format=%cI")
    if last:
        try:
            stamps.append(datetime.fromisoformat(last).astimezone(now.tzinfo))
        except ValueError:
            pass
    for rel in dirty_paths:
        try:
            stamps.append(_stamp((path / rel).stat().st_mtime, now))
        except OSError:
            continue
    return max(stamps) if stamps else None


def _repo_row(path: Path, now: datetime) -> dict:
    is_git = (path / ".git").exists()
    porcelain = git(path, "status", "--porcelain") if is_git else None
    dirty_paths = _dirty_paths(porcelain) if porcelain else []
    branch = git(path, "rev-parse", "--abbrev-ref", "HEAD") if is_git else None
    default_name, default_ref = _default_branch(path) if is_git else (None, None)
    remote = git(path, "remote", "get-url", "origin") if is_git else None
    touched = _git_touched(path, dirty_paths, now) if is_git else _newest_mtime(path, now)
    return {
        "kind": "repo",
        "name": path.name,
        "dept": "Projects",
        "path": f"~/{path.relative_to(Path.home())}",
        "git": is_git,
        "branch": None if branch in (None, "HEAD") else branch,
        "default_branch": default_name,
        "unmerged_commits": _count(path, f"{default_ref}..HEAD") if default_ref else None,
        "unpushed_commits": _count(path, "@{u}..HEAD") if is_git else None,
        "dirty": None if porcelain is None else len(dirty_paths),
        "touched": common.iso(touched) if touched else None,
        "remote": github_slug(path) or remote or None,
        "last_session": last_session(path),
    }


def _workspace_row(path: Path, now: datetime) -> dict:
    members = path / "repos"
    member_paths = sorted(p for p in members.iterdir() if p.is_dir()) if members.is_dir() else []
    scratch = path / ".scratch"
    efforts = sorted(p.name for p in scratch.iterdir() if p.is_dir()) if scratch.is_dir() else []
    stamps = [t for t in (_git_touched(p, _dirty_paths(git(p, "status", "--porcelain") or ""), now)
                          for p in member_paths) if t]
    scratch_touched = _newest_mtime(scratch, now) if scratch.is_dir() else None
    if scratch_touched:
        stamps.append(scratch_touched)
    return {
        "kind": "workspace",
        "name": path.name,
        "dept": "Projects",
        "path": f"~/{path.relative_to(Path.home())}",
        "repos": [p.name for p in member_paths],
        "efforts": efforts,
        "touched": common.iso(max(stamps)) if stamps else None,
        "last_session": last_session(path),
    }


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    return [_workspace_row(p, now) if is_workspace(p) else _repo_row(p, now)
            for p in project_dirs()]
