#!/usr/bin/env python3
"""Session notes: what the last Claude session in a folder was doing, kept on disk.

Three Claude Code hooks in one file. No Claude call, no transcript read, nothing that
can take a noticeable fraction of a second.

    session_note.py stop     Stop: overwrite this session's note with the latest recap
    session_note.py end      SessionEnd: record why the session ended
    session_note.py start    SessionStart: print the newest note for this folder

A note lives at `~/.helm/status/sessions/<cwd key>/<session id>.md`. The cwd key is the
folder's path under $HOME with `/` replaced by `__`, so `~/Projects/helm2` becomes
`Projects__helm2`. A path outside $HOME keeps its leading separator through the same
substitution and so starts with `__`, which is how it cannot collide with a folder of
the same name inside $HOME.

Nothing is ever written into the session's own working directory, so a note helm writes
can never make a repo look dirty (runner/producers/sources/repos.py reads `dirty`).

The note is overwritten every turn, which makes it the latest recap rather than a log,
and the folder keeps only the newest 5 sessions. A routine that runs `claude -p` from
helm sets `HELM_NO_SESSION_NOTE=1` so its output never replaces a real session's recap.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "producers"))

import common  # noqa: E402

BODY_LIMIT = 1500
KEEP = 5
HEADER_KEYS = ("cwd", "at", "session_id", "branch", "reason")
SAFE_ID = re.compile(r"[^A-Za-z0-9_-]")


def cwd_key(cwd: str) -> str:
    path = Path(cwd).expanduser()
    try:
        path = path.resolve()
    except OSError:
        pass
    try:
        rel = path.relative_to(Path.home().resolve()).as_posix()
    except ValueError:
        rel = path.as_posix()
    if rel in ("", "."):
        return "_home"
    return rel.replace("/", "__")


def note_path(cwd: str, session_id: str) -> Path:
    return common.SESSIONS_DIR / cwd_key(cwd) / f"{SAFE_ID.sub('_', session_id)}.md"


def newest_note(cwd: str) -> Path | None:
    folder = common.SESSIONS_DIR / cwd_key(cwd)
    notes = sorted(folder.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True) if folder.is_dir() else []
    return notes[0] if notes else None


def git_branch(cwd: str) -> str:
    try:
        r = subprocess.run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
                           capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def render(header: dict[str, str], body: str) -> str:
    head = "\n".join(f"{k}: {header.get(k, '')}" for k in HEADER_KEYS if k in header)
    return f"{head}\n\n{body.rstrip()}\n"


def parse(text: str) -> tuple[dict[str, str], str]:
    head, _, body = text.partition("\n\n")
    header: dict[str, str] = {}
    for line in head.splitlines():
        key, sep, value = line.partition(":")
        if sep:
            header[key.strip()] = value.strip()
    return header, body


def write_note(path: Path, text: str) -> None:
    """Temp file beside the target, then os.replace, so `start` never reads a half file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def prune(folder: Path) -> None:
    notes = sorted(folder.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in notes[KEEP:]:
        stale.unlink(missing_ok=True)


def cmd_stop(data: dict) -> int:
    body = (data.get("last_assistant_message") or "").strip()
    if not body or os.environ.get("HELM_NO_SESSION_NOTE"):
        return 0
    cwd = data.get("cwd") or os.getcwd()
    session_id = data.get("session_id") or "unknown"
    now = datetime.now(common.local_tz(common.load_env()))
    path = note_path(cwd, session_id)
    header = {"cwd": cwd, "at": common.iso(now), "session_id": session_id, "branch": git_branch(cwd)}
    write_note(path, render(header, body[:BODY_LIMIT]))
    prune(path.parent)
    return 0


def cmd_end(data: dict) -> int:
    path = note_path(data.get("cwd") or os.getcwd(), data.get("session_id") or "unknown")
    if not path.exists():
        return 0
    header, body = parse(path.read_text())
    header["reason"] = data.get("reason") or "unknown"
    write_note(path, render(header, body))
    return 0


def cmd_start(data: dict) -> int:
    note = newest_note(data.get("cwd") or os.getcwd())
    if note is None:
        return 0
    header, body = parse(note.read_text())
    body = body.strip()
    if not body:
        return 0
    print(f"Where the last session in this folder stopped ({header.get('at', 'unknown')}):")
    print()
    print(body)
    return 0


COMMANDS = {"stop": cmd_stop, "end": cmd_end, "start": cmd_start}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in COMMANDS:
        print(f"usage: session_note.py {{{'|'.join(COMMANDS)}}}", file=sys.stderr)
        return 2
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    # A hook that raises takes the turn's tail with it, so report and stand down.
    try:
        return COMMANDS[argv[0]](data if isinstance(data, dict) else {})
    except Exception as e:  # noqa: BLE001
        print(f"session_note {argv[0]}: {type(e).__name__}: {e}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
