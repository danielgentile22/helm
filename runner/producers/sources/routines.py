"""Scheduled jobs: the next fire of every routine in models.json.

Row contract:

    {"kind": "job", "source": "routines", "id": "routine:<name>", "dept": "Projects",
     "title": <name>, "at": next fire as ISO with offset, "schedule": "daily 07:00",
     "path": "runner/routines/<name>.sh"}

Local only, no network. `at` is the first fire after `now`; the reader that outlives
it can advance by `schedule` (the grammar is in runner/schedule.py).
"""
from __future__ import annotations

import json
from datetime import datetime

import common
from schedule import next_fire, parse_schedule


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    try:
        models = json.loads((common.ENGINE / "models.json").read_text())
    except (OSError, ValueError) as e:
        raise common.SourceError("parse", f"models.json unreadable ({e})") from e
    rows = []
    for name, spec in sorted((models.get("routines") or {}).items()):
        text = str((spec or {}).get("schedule", "")).strip()
        try:
            fires = next_fire(parse_schedule(text), now)
        except ValueError as e:
            raise common.SourceError("parse", f"{name}: {e}") from e
        rows.append({
            "kind": "job",
            "source": "routines",
            "id": f"routine:{name}",
            "dept": "Projects",
            "title": name,
            "at": common.iso(fires),
            "schedule": text,
            "path": f"runner/routines/{name}.sh",
        })
    return rows
