#!/usr/bin/env python3
"""Run the voice-todo fixture against a throwaway copy of the vault and grade it.

The skill's judgment has no unit test. This is the check instead: every sentence in
`fixture.json` goes through the same headless command the dashboard's talk route
builds, against a copy of `demo-vault/` made into its own git repo (so commits and `since` behave),
and the departments and operations that came back are compared to the fixture.

    python3 skills/voice-todo/check_fixture.py            every case
    python3 skills/voice-todo/check_fixture.py --only 4   one case, 1-based
    python3 skills/voice-todo/check_fixture.py --keep     leave the copy on disk

Each case starts from the same copy, reset with git between cases, so the cases never see
one another's writes. The real vault is never opened for writing: `HELM_VAULT_ROOT` points the
todo editor at the copy, and the run aborts if it is not under the temporary directory.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1]
FIXTURE = HERE / "fixture.json"
TIMEOUT_S = 90

OPS = {"add", "tick", "untick", "edit", "note", "sub", "none", "decline"}
NO_WRITE = {"none", "decline"}
NOTHING_TO_DO = "Nothing to do there"


def copy_vault() -> tuple[Path, Path]:
    root = Path(tempfile.mkdtemp(prefix="voice-todo-fixture-"))
    dest = root / "Vault"
    shutil.copytree(ENGINE / "demo-vault", dest, symlinks=True)
    for argv in (["init", "-q", "-b", "main"], ["add", "-A"],
                 ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "demo vault"]):
        subprocess.run(["git", "-C", str(dest), *argv], check=True, capture_output=True)
    return root, dest


def restore(vault: Path) -> None:
    """The copy as it was before any case ran. Every sentence is graded against the same
    vault, so a tick in case 2 cannot turn the edit in case 12 into an add. The todo editor
    commits each write, so the reset goes to the copy's first commit, not to HEAD."""
    base = subprocess.run(["git", "-C", str(vault), "rev-list", "--max-parents=0", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.split()[0]
    for argv in (["reset", "-q", "--hard", base], ["clean", "-fdq"]):
        subprocess.run(["git", "-C", str(vault), *argv], check=True, capture_output=True)


def normalise(case: dict) -> tuple[list[str], list | None]:
    op = case["op"]
    ops = list(op) if isinstance(op, list) else [op]
    bad = [o for o in ops if o not in OPS]
    if bad:
        raise SystemExit(f"fixture: unknown op {bad}")
    if ops[0] in NO_WRITE:
        return ops, None
    dept = case["dept"]
    if isinstance(op, list):
        if not isinstance(dept, list) or len(dept) != len(ops):
            raise SystemExit(f"fixture: dept must be a list of {len(ops)} for {case['say']!r}")
        return ops, [[d] for d in dept]
    allowed = dept if isinstance(dept, list) else [dept]
    return ops, [allowed]


def expected_label(case: dict) -> str:
    ops, depts = normalise(case)
    if depts is None:
        return ops[0]
    if len(ops) == 1 and len(depts[0]) > 1:
        return f"{ops[0]} in {' or '.join(str(d) for d in depts[0])}"
    return " + ".join(f"{o} {allowed[0]}" for o, allowed in zip(ops, depts))


def actions_label(actions: list) -> str:
    if not actions:
        return "no actions"
    return " + ".join(f"{a.get('op', '?')} {a.get('dept', '?')}" for a in actions)


def grade(case: dict, actions: list | None, confirmation: str) -> tuple[bool, str, str]:
    ops, depts = normalise(case)
    expected = expected_label(case)
    if actions is None:
        return False, expected, "no JSON on the last line"
    confirmation = confirmation.strip()
    got = actions_label(actions)

    if ops[0] in NO_WRITE:
        if actions:
            return False, expected, got
        is_nothing = confirmation == NOTHING_TO_DO
        if ops[0] == "none":
            return is_nothing, expected, "none" if is_nothing else f"declined: {confirmation}"
        return not is_nothing, expected, "decline" if not is_nothing else "none"

    if len(actions) != len(ops):
        return False, expected, got
    for action, want_op, want_depts in zip(actions, ops, depts):
        # `note --sub` prints the same op as a plain note, so a subtask grades as a note.
        if action.get("op") != ("note" if want_op == "sub" else want_op):
            return False, expected, got
        if want_depts != [None] and action.get("dept") not in want_depts:
            return False, expected, got
    return True, expected, got


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", type=int, help="run one case, 1-based")
    ap.add_argument("--keep", action="store_true", help="leave the vault copy on disk")
    ap.add_argument("--now", help='"YYYY-MM-DD HH:MM" to pin the clock, default is now')
    a = ap.parse_args(argv)

    cases = json.loads(FIXTURE.read_text())["cases"]
    if a.only is not None:
        if not 1 <= a.only <= len(cases):
            raise SystemExit(f"--only takes 1 to {len(cases)}")
        cases = [cases[a.only - 1]]

    root, vault = copy_vault()
    if not str(vault).startswith(tempfile.gettempdir()):
        raise SystemExit(f"refusing to run: {vault} is not a temporary copy")

    # `common.VAULT` and `run_command`'s env both read the environment, the first at import
    # time, so the copy has to be in place before turns is imported.
    os.environ["HELM_VAULT_ROOT"] = str(vault)
    sys.path[:0] = [str(ENGINE / "dashboard" / "server"), str(ENGINE / "runner"),
                    str(ENGINE / "runner" / "producers")]
    import turns  # noqa: E402

    now = turns.local_now()
    if a.now:
        now = datetime.strptime(a.now, "%Y-%m-%d %H:%M").replace(tzinfo=now.tzinfo)

    failures = 0
    for i, case in enumerate(cases, 1):
        restore(vault)
        outcome = turns.run_command(turns.command(case["say"], now), TIMEOUT_S)
        result = turns.parse_result(outcome.stdout)
        ok, expected, got = grade(case, result.actions if result else None,
                                  result.confirmation if result else "")
        failures += 0 if ok else 1
        confirmation = result.confirmation if result else "(none)"
        if outcome.timed_out:
            confirmation = "(timed out)"
        seconds = outcome.ms / 1000

        print(f"[{'PASS' if ok else 'FAIL'}] {i}. {case['say']}")
        print(f"        expected  {expected}")
        print(f"        got       {got}")
        print(f"        said      {confirmation}")
        print(f"        took      {seconds:.1f}s")

    total = len(cases)
    print(f"\n{total - failures} of {total} PASS, {failures} FAIL")
    if a.keep:
        print(f"vault copy kept at {vault}")
    else:
        shutil.rmtree(root, ignore_errors=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
