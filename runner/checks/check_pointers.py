#!/usr/bin/env python3
"""Verify that every pointer in every router resolves to a real path.

A router is a pointer file. Its whole value is that an agent can follow a line
without searching, so a pointer whose target has moved is worse than no pointer:
the agent follows it, finds nothing, and falls back to globbing the vault.

Checks helm's CLAUDE.md, the department routers at the vault root, and the department
notes inside Atlas. A relative pointer resolves against the root its router lives in.
Prints one line per broken pointer and exits non-zero if any are broken.
"""
import os
import re
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
VAULT = Path(os.environ.get("HELM_VAULT_ROOT") or Path.home() / "Vault")

# (router, the root its relative pointers resolve against)
ROUTERS = [(ENGINE / "CLAUDE.md", ENGINE)] + [
    (VAULT / name, VAULT) for name in ("CLAUDE.md", "WORK.md", "PROJECTS.md", "CHESS.md", "LIFE.md", "TOOLS.md",
                                       "Atlas/Work/Work.md", "Atlas/Projects/Projects.md",
                                       "Atlas/Chess/Chess.md", "Atlas/Life/Life.md")
]

# A pointer is a backticked path: absolute, home-relative, or relative to its router's root.
POINTER = re.compile(r"`((?:~|/|Atlas/|Inbox/|Archive/|runner/|dashboard/|docs/|scripts/)[^`]*)`")

# Paths that are illustrative rather than pointers.
SKIP = re.compile(r"[*?<]|YYYY|^/bin/|^/usr/|^/[\w-]+$")  # globs, placeholders, slash commands


def show(path: Path) -> str:
    return str(path).replace(str(Path.home()), "~", 1)


def resolve(raw: str, root: Path) -> Path:
    if raw.startswith("~"):
        return Path(os.path.expanduser(raw))
    if raw.startswith("/"):
        return Path(raw)
    return root / raw


def main() -> int:
    broken, checked, missing_routers = [], 0, []
    for router, root in ROUTERS:
        if not router.exists():
            missing_routers.append(router)
            continue
        text = router.read_text(encoding="utf-8")
        for m in POINTER.finditer(text):
            raw = m.group(1)
            if SKIP.search(raw):
                continue
            checked += 1
            if not resolve(raw, root).exists():
                line = text[: m.start()].count("\n") + 1
                broken.append((show(router), line, raw))

    for router in missing_routers:
        print(f"FAIL  router missing: {show(router)}")
    for rel, line, raw in broken:
        print(f"FAIL  {rel}:{line}  {raw}")

    total_bad = len(broken) + len(missing_routers)
    status = "PASS" if total_bad == 0 else "FAIL"
    print(f"{status}  {checked} pointers checked across {len(ROUTERS) - len(missing_routers)} routers, {total_bad} broken")
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())
