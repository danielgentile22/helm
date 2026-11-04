"""Run now, pause and resume a routine (ADR 0038).

A routine is one of three states, read off two places: loaded in launchd with its plist in
`~/Library/LaunchAgents/`, paused with its plist parked in `~/.helm/disabled/` and nothing
loaded, or somewhere between the two after an interrupted pause or resume. `pause` and
`resume` read both places every time and finish whatever is left, so running either twice,
or again after a crash halfway, ends in the state it names.

Whether a job is loaded is asked of `launchctl print`, one job at a time, because its exit
code tells "no such job" (113) apart from a launchctl that failed. `launchctl list` cannot:
it answers empty either way, and a pause that read a failure as "not loaded" would park a
plist launchd still fires.

Only a label built from a routine name in models.json reaches here, and every launchctl
argument is that label or a path made from it. The machine is reached only through
`machine.py`, which the tests replace.
"""
from __future__ import annotations

import re
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import common
import machine
from app import ApiError

# One action at a time, so two taps on Pause cannot interleave a bootout and a move.
LOCK = threading.Lock()
NO_SUCH_JOB = 113
# launchd refuses a bootstrap with error 5 while it is still tearing down a job it just
# booted out, so a resume right after a pause retries for a few seconds.
BOOTSTRAP_TRIES = 8
RETRY_DELAY_S = 1.0
INSTALL = "run runner/install-routines.sh to install it"
PID = re.compile(r"^\tpid = (\d+)$", re.MULTILINE)


@dataclass(frozen=True)
class Loaded:
    running: bool


def plists(label: str) -> tuple[Path, Path]:
    """Where launchd loads the plist from, and where a paused one is parked."""
    return machine.LAUNCH_AGENTS / f"{label}.plist", common.STATE / "disabled" / f"{label}.plist"


def target(label: str) -> str:
    return f"{machine.gui_domain()}/{label}"


def loaded(label: str) -> Loaded | None:
    code, out = machine.launchctl("print", target(label))
    if code == NO_SUCH_JOB:
        return None
    if code != 0:
        raise ApiError(502, "launchctl", f"launchctl print exited {code}, so whether {label} is loaded is unknown: "
                                         f"{out.strip()[:200]}")
    return Loaded(running=PID.search(out) is not None)


def run(label: str) -> bool:
    with LOCK:
        _, parked = plists(label)
        if parked.is_file():
            raise ApiError(409, "conflict", f"{label} is paused; resume it before running it")
        job = loaded(label)
        if job is None:
            raise ApiError(409, "conflict", f"{label} is not loaded in launchd; {INSTALL}")
        if job.running:
            raise ApiError(409, "conflict", f"{label} is already running")
        code, out = machine.launchctl("kickstart", target(label))
        if code != 0:
            raise ApiError(502, "launchctl", f"launchctl kickstart exited {code}: {out.strip()[:200]}")
        return True


def pause(label: str) -> bool:
    """Boot the job out, then park its plist. Booting out first means an interruption leaves
    a routine that is unloaded but not yet parked, never one that is parked and still fires."""
    with LOCK:
        active, parked = plists(label)
        if not active.is_file() and not parked.is_file():
            raise ApiError(409, "conflict", f"{label} has no plist in either place; {INSTALL}")
        changed = False
        job = loaded(label)
        if job is not None:
            if job.running:
                raise ApiError(409, "conflict", f"{label} is running now; pause it once this run ends")
            code, out = machine.launchctl("bootout", target(label))
            if loaded(label) is not None:
                raise ApiError(502, "launchctl", f"launchctl bootout exited {code} and {label} is still loaded: "
                                                 f"{out.strip()[:200]}")
            changed = True
        if active.is_file():
            parked.parent.mkdir(parents=True, exist_ok=True)
            # Over a parked copy an interrupted pause left behind: the active one is newer.
            shutil.move(active, parked)
            changed = True
        return changed


def resume(label: str) -> bool:
    """Move the plist back, then bootstrap it. An interruption between the two leaves a
    plist in place that is not loaded, which the next resume, or the next login, loads."""
    with LOCK:
        active, parked = plists(label)
        changed = False
        if parked.is_file():
            if active.is_file():
                parked.unlink()
            else:
                active.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(parked, active)
            changed = True
        if not active.is_file():
            raise ApiError(409, "conflict", f"{label} has no plist in either place; {INSTALL}")
        if loaded(label) is None:
            code, out = 0, ""
            for attempt in range(BOOTSTRAP_TRIES):
                code, out = machine.launchctl("bootstrap", machine.gui_domain(), str(active))
                if code == 0 or loaded(label) is not None:
                    break
                if attempt + 1 < BOOTSTRAP_TRIES:
                    time.sleep(RETRY_DELAY_S)
            if loaded(label) is None:
                raise ApiError(502, "launchctl", f"launchctl bootstrap exited {code}: {out.strip()[:200]}; "
                                                 "the plist is back in place, so resume again or log in again")
            changed = True
        return changed
