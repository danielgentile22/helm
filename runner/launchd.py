#!/usr/bin/env python3
"""models.json turned into launchd jobs: one per routine, one per service.

Everything that decides what a job is lives here, as pure functions over the registry and
the two paths handed to them. Everything that touches `launchctl` or writes into
`~/Library/LaunchAgents` stays in `install-routines.sh`, which calls this module for the
plan and for the plist text and owns nothing else.

A routine is a script on a timer. A service is a process launchd keeps alive. They differ
only in their trigger, so both are a `Job` with one of three triggers, and the schedule
grammar stays parsed in exactly one place, `schedule.py`.

    runner/launchd.py --list            one row per job: label, program, when
    runner/launchd.py --plist <label>   that job's plist, on stdout
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from schedule import Daily, parse_schedule  # noqa: E402

ENGINE = HERE.parent
PREFIX = "com.helm."


@dataclass(frozen=True)
class Calendar:
    """Once a day at a local time. launchd fires a missed one on wake, not at the hour.
    on_mount also fires it whenever any volume mounts; the routine decides if it cares."""
    hour: int
    minute: int
    on_mount: bool = False


@dataclass(frozen=True)
class Interval:
    seconds: int


@dataclass(frozen=True)
class Supervised:
    """Started at login and restarted whenever it exits, no faster than the throttle."""
    throttle_s: int


Trigger = Calendar | Interval | Supervised


@dataclass(frozen=True)
class Job:
    label: str
    program: tuple[str, ...]
    trigger: Trigger
    when: str


def program(command: list[str], root: Path) -> tuple[str, ...]:
    """The argv launchd runs. A token with a slash in it is a path inside helm and is joined
    to the root it is handed; anything else is a bare word and is left alone. Nothing in the
    registry names a machine, so moving helm is a re-run rather than an edit."""
    if not command:
        raise ValueError("a job needs a command")
    return tuple(str(root / token) if "/" in token else token for token in command)


def plan(registry: dict, root: Path) -> tuple[Job, ...]:
    """Every job launchd runs on Daniel's behalf, routines first, in registry order."""
    jobs: list[Job] = []
    for name, cfg in (registry.get("routines") or {}).items():
        schedule = parse_schedule(cfg["schedule"])
        if isinstance(schedule, Daily):
            trigger: Trigger = Calendar(schedule.hour, schedule.minute, schedule.on_mount)
            when = f"daily at {schedule.hour:02d}:{schedule.minute:02d}" + (" and on mount" if schedule.on_mount else "")
        else:
            trigger = Interval(schedule.seconds)
            when = f"every {schedule.seconds // 60} minutes"
        jobs.append(Job(PREFIX + name, program([f"runner/routines/{name}.sh"], root), trigger, when))

    for name, cfg in (registry.get("services") or {}).items():
        throttle = int(cfg["throttle_s"])
        if throttle <= 0:
            raise ValueError(f"service {name} needs a positive throttle_s, so a crash loop is bounded")
        jobs.append(Job(PREFIX + name, program(list(cfg["command"]), root), Supervised(throttle),
                        "at login, restarted if it exits"))
    return tuple(jobs)


def lifecycle(trigger: Trigger) -> str:
    match trigger:
        case Calendar(hour, minute, on_mount):
            return (f"\t<key>StartCalendarInterval</key>\n"
                    f"\t<dict>\n"
                    f"\t\t<key>Hour</key><integer>{hour}</integer>\n"
                    f"\t\t<key>Minute</key><integer>{minute}</integer>\n"
                    f"\t</dict>\n"
                    f"\t<key>RunAtLoad</key><false/>"
                    + ("\n\t<key>StartOnMount</key><true/>" if on_mount else ""))
        case Interval(seconds):
            # launchd does not fire a missed StartInterval on wake, so a laptop that slept
            # through a run would serve a stale snapshot until the next one. RunAtLoad makes
            # waking up produce a fresh one.
            return (f"\t<key>StartInterval</key><integer>{seconds}</integer>\n"
                    f"\t<key>RunAtLoad</key><true/>")
        case Supervised(throttle_s):
            # KeepAlive without a throttle spins on a broken build. ThrottleInterval is the
            # floor between one start and the next, so a crash loop costs a restart every
            # throttle_s rather than a busy core.
            return (f"\t<key>RunAtLoad</key><true/>\n"
                    f"\t<key>KeepAlive</key><true/>\n"
                    f"\t<key>ThrottleInterval</key><integer>{throttle_s}</integer>")


def plist(job: Job, root: Path, home: Path) -> str:
    args = "\n".join(f"\t\t<string>{escape(arg)}</string>" for arg in job.program)
    # /usr/local/bin before /opt/homebrew/bin, matching the login shell. The other order picks
    # the homebrew python3, which has none of the Google client libraries, and the calendar
    # source fails with a deps error.
    path = f"{home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
    logs = Path(os.environ.get("HELM_STATE") or home / ".helm") / "logs"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key><string>{escape(job.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
{args}
\t</array>
\t<key>WorkingDirectory</key><string>{escape(str(root))}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key><string>{escape(path)}</string>
\t\t<key>HOME</key><string>{escape(str(home))}</string>
\t</dict>
{lifecycle(job.trigger)}
\t<key>StandardOutPath</key><string>{escape(str(logs / (job.label + ".out")))}</string>
\t<key>StandardErrorPath</key><string>{escape(str(logs / (job.label + ".err")))}</string>
</dict>
</plist>
"""


def is_loaded(label: str) -> bool:
    """Whether launchd is holding a job with this label for this user.

    The one function here that reaches outside the process. Everything above is a pure
    function of the registry and the two paths handed to it, which is what makes the plists
    testable without booting a job."""
    done = subprocess.run(["launchctl", "list", label], capture_output=True)
    return done.returncode == 0


def read_registry(root: Path) -> dict:
    return json.loads((root / "models.json").read_text())


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=ENGINE)
    ap.add_argument("--home", type=Path, default=Path.home())
    ap.add_argument("--list", action="store_true", help="one tab separated row per job")
    ap.add_argument("--plist", metavar="LABEL", help="that job's plist, on stdout")
    args = ap.parse_args(argv)

    root = args.root.resolve()
    jobs = plan(read_registry(root), root)
    if args.list:
        for job in jobs:
            print(f"{job.label}\t{job.program[0]}\t{job.when}")
        return 0
    if args.plist:
        for job in jobs:
            if job.label == args.plist:
                sys.stdout.write(plist(job, root, args.home))
                return 0
        sys.exit(f"launchd.py: no job labelled {args.plist} in models.json")
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
