#!/usr/bin/env python3
"""Report capture sources that are failing or stale, from the artifacts themselves.

`agenda.json` and `projects.json` each copy the envelope of every source that fed them,
so staleness is read off the file the dashboard already holds rather than off a status
file claiming to summarise it (ADR 0008). A source is a problem when it is failing, when
it has never produced anything, or when its last success is older than twice its cadence,
which is one missed run plus the run that should have caught up.

This only reports. `runner/routines/capture.sh` is what refreshes the files.
"""
import sys
from datetime import datetime
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
MERGED = ("agenda.json", "projects.json")

sys.path.insert(0, str(ENGINE / "runner" / "producers"))

import common  # noqa: E402


def age_limit_s(meta: dict) -> int:
    return 2 * int(meta.get("cadence_s") or 0)


def parse_at(text: str, now: datetime) -> datetime | None:
    try:
        at = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return at if at.tzinfo else at.replace(tzinfo=now.tzinfo)


def problems(label: str, doc: dict, now: datetime) -> tuple[list[str], int]:
    sources = doc.get("sources") or {}
    found = []
    for name, meta in sorted(sources.items()):
        if not meta.get("ok"):
            found.append(f"FAIL  {label} source {name} is failing: {meta.get('reason') or 'no reason recorded'}")
            continue
        produced = meta.get("produced")
        if not produced:
            found.append(f"FAIL  {label} source {name} has never produced rows")
            continue
        at = parse_at(produced, now)
        if at is None:
            found.append(f"FAIL  {label} source {name} has an unreadable produced time: {produced!r}")
            continue
        age = int((now - at).total_seconds())
        limit = age_limit_s(meta)
        if limit and age > limit:
            found.append(f"FAIL  {label} source {name} last produced {produced}, {age}s ago, over its {limit}s limit")
    return found, len(sources)


def main() -> int:
    now = datetime.now(common.local_tz(common.load_env()))
    lines: list[str] = []
    counted = 0
    for filename in MERGED:
        path = common.STATUS / filename
        doc = common.read_json(path)
        if doc is None:
            lines.append(f"FAIL  {filename} is absent or unreadable, so nothing knows how old the dashboard is")
            continue
        found, n = problems(filename, doc, now)
        lines.extend(found)
        counted += n

    for line in lines:
        print(line)
    status = "PASS" if not lines else "FAIL"
    print(f"{status}  {counted} capture sources checked, {len(lines)} failing or stale")
    return 1 if lines else 0


if __name__ == "__main__":
    sys.exit(main())
