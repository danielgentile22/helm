#!/usr/bin/env python3
"""Report drift between the repos on disk and the project notes that claim them.

Every project note carries a `repo:` field. A folder with no note is invisible to
the Projects router; a note pointing at a folder that no longer exists is a stale
pointer with extra steps. Reports both and exits non-zero if either is found.

Folders listed in the vault's `Atlas/Projects/_registry-ignore.md` are not projects,
the same list `update-vault`'s scanner drops.

This only reports. `update-vault` is what regenerates the registry.
"""
import os
import re
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
PROJECTS_DIR = Path.home() / "Projects"
VAULT = Path(os.environ.get("HELM_VAULT_ROOT") or Path.home() / "Vault")
NOTES_DIR = VAULT / "Atlas/Projects"
IGNORE = {"archive"}  # archive holds retired repos

REPO_FIELD = re.compile(r"^repo:\s*(.+?)\s*$", re.M)


def ignored() -> set[Path]:
    """One `~/...` or absolute path per line of the ignore note; prose lines are skipped."""
    f = NOTES_DIR / "_registry-ignore.md"
    if not f.exists():
        return set()
    lines = (line.strip().lstrip("-").strip().strip("`") for line in f.read_text().splitlines())
    return {Path(os.path.expanduser(line)).resolve() for line in lines if line.startswith(("~", "/"))}


def main() -> int:
    if not NOTES_DIR.exists():
        print(f"FAIL  project notes missing: {NOTES_DIR}")
        return 1

    claimed = {}
    for note in NOTES_DIR.rglob("*.md"):
        m = REPO_FIELD.search(note.read_text(encoding="utf-8", errors="replace")[:800])
        if m:
            claimed[Path(os.path.expanduser(m.group(1))).resolve()] = note.stem

    on_disk = {p.resolve() for p in PROJECTS_DIR.iterdir() if p.is_dir() and p.name not in IGNORE and not p.name.startswith(".")}
    on_disk -= ignored()

    unnoted = sorted(on_disk - set(claimed))
    missing = sorted(p for p in claimed if not p.exists())

    for p in unnoted:
        print(f"FAIL  repo with no project note: ~/Projects/{p.name}")
    for p in missing:
        print(f"FAIL  note [[{claimed[p]}]] points at a folder that does not exist: {p}")

    bad = len(unnoted) + len(missing)
    status = "PASS" if bad == 0 else "FAIL"
    print(f"{status}  {len(on_disk)} repos on disk, {len(claimed)} claimed by notes, {bad} drifting")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
