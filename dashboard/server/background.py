"""The Background tab's records, assembled per request so the tab never disagrees with the
machine (docs/data-shapes.md, Routine record).

A routine is a row in models.json's `routines`; a service is any other `com.helm.*` job,
listed in models.json's `services` or found loaded in launchd. Every input is handed in:
the registry, launchd's answer from `machine.launchctl_list`, the state folder and `now`,
so the tests build each one and the machine is never asked.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

import common
from launchd import PREFIX
from machine import LaunchdJob
from schedule import next_fire, parse_schedule

Result = Literal["pass", "fail", "paused", "unknown"]
# What the routines write when they did their job. Backup says `ok`, or `fresh` when the
# last one is recent enough to skip; anything else it writes ("volume absent", "failed: x")
# is a run that left no backup, which is the alert ADR 0039 names.
PASSING = {"pass", "ok", "fresh"}
LOG_LINES = 40
LOG_READ_BYTES = 64 * 1024


def result_of(raw: str | None, paused: bool) -> Result:
    if paused:
        return "paused"
    if not raw:
        return "unknown"
    return "pass" if raw.strip().lower() in PASSING else "fail"


def stamp(value: object) -> str | None:
    """A status file's time as ISO: backup writes epoch seconds, the rest write ISO. Zero
    and anything unreadable are no time at all."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return common.iso(datetime.fromtimestamp(value, timezone.utc)) if value > 0 else None
    if isinstance(value, str) and value:
        try:
            return common.iso(datetime.fromisoformat(value))
        except ValueError:
            return None
    return None


def log_tail(state: Path, label: str) -> tuple[list[str], str | None]:
    """The last lines of whichever of the job's two logs was written last, and when."""
    logs = [p for p in (state / "logs" / f"{label}.err", state / "logs" / f"{label}.out") if p.is_file()]
    if not logs:
        return [], None
    newest = max(logs, key=lambda p: p.stat().st_mtime)
    with newest.open("rb") as fh:
        size = fh.seek(0, 2)
        fh.seek(max(0, size - LOG_READ_BYTES))
        text = fh.read().decode("utf-8", errors="replace")
    lines = text.splitlines()
    if size > LOG_READ_BYTES:
        lines = lines[1:]
    return lines[-LOG_LINES:], common.iso(datetime.fromtimestamp(newest.stat().st_mtime, timezone.utc))


def launchd_fields(label: str, jobs: dict[str, LaunchdJob]) -> dict:
    job = jobs.get(label)
    return {"label": label, "loaded": job is not None, "running": job is not None and job.pid is not None,
            "last_exit": job.last_exit if job else None}


def routine(name: str, spec: dict, jobs: dict[str, LaunchdJob], state: Path, now: datetime) -> dict:
    label = PREFIX + name
    paused = (state / "disabled" / f"{label}.plist").is_file()
    status = common.read_json(state / "status" / f"{name}.json") or {}
    raw = status.get("result")
    raw = raw if isinstance(raw, str) else None
    result = result_of(raw, paused)
    last_run = stamp(status.get("last_run") or status.get("ran"))
    failures = status.get("failures")
    schedule = str(spec.get("schedule") or "")
    try:
        next_run = None if paused else common.iso(next_fire(parse_schedule(schedule), now))
    except ValueError:
        next_run = None
    tail, updated = log_tail(state, label)
    return {
        "name": name,
        "kind": "routine",
        "schedule": schedule,
        "model": spec.get("model"),
        "effort": spec.get("effort"),
        "why": spec.get("why"),
        **launchd_fields(label, jobs),
        "paused": paused,
        "last_run": last_run,
        "result": result,
        "result_text": raw,
        "failures": failures if isinstance(failures, int) and not isinstance(failures, bool) else None,
        "last_success": stamp(status.get("last_success")) or (last_run if result_of(raw, False) == "pass" else None),
        "next_run": next_run,
        "log_tail": tail,
        "log_updated": updated,
    }


def service(name: str, spec: dict | None, jobs: dict[str, LaunchdJob], state: Path) -> dict:
    label = PREFIX + name
    tail, updated = log_tail(state, label)
    return {"name": name, "kind": "service", "why": (spec or {}).get("why"), "listed": spec is not None,
            **launchd_fields(label, jobs), "log_tail": tail, "log_updated": updated}


def assemble(registry: dict, jobs: dict[str, LaunchdJob], state: Path, now: datetime) -> dict:
    routines = registry.get("routines") or {}
    services = dict(registry.get("services") or {})
    for label in jobs:
        name = label[len(PREFIX):]
        if label.startswith(PREFIX) and name not in routines:
            services.setdefault(name, None)
    return {
        "routines": [routine(n, spec or {}, jobs, state, now) for n, spec in routines.items()],
        "services": [service(n, services[n], jobs, state) for n in sorted(services)],
    }
