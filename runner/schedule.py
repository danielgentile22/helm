"""The schedule grammar in models.json, parsed in exactly one place.

`daily HH:MM` fires once a day at that local time, and `daily HH:MM and on mount` also
fires whenever a volume mounts. `every Nm` or `every Nh` fires on an
interval. The installer maps the first to StartCalendarInterval and the second to
StartInterval; the routines source and the freshness check call `next_fire` and
`cadence_seconds`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass(frozen=True)
class Daily:
    hour: int
    minute: int
    on_mount: bool = False


@dataclass(frozen=True)
class Every:
    seconds: int


Schedule = Daily | Every

_DAILY = re.compile(r"^daily (\d{1,2}):(\d{2})( and on mount)?$")
_EVERY = re.compile(r"^every (\d+)([mh])$")


def parse_schedule(text: str) -> Schedule:
    m = _DAILY.match(text.strip())
    if m:
        return Daily(int(m.group(1)), int(m.group(2)), bool(m.group(3)))
    m = _EVERY.match(text.strip())
    if m:
        n = int(m.group(1))
        return Every(n * 60 if m.group(2) == "m" else n * 3600)
    raise ValueError(f"unknown schedule: {text!r} (want 'daily HH:MM' or 'every Nm')")


def cadence_seconds(s: Schedule) -> int:
    return 86400 if isinstance(s, Daily) else s.seconds


def next_fire(s: Schedule, now: datetime) -> datetime:
    """First scheduled instant strictly after `now`, in now's zone."""
    if isinstance(s, Every):
        return now + timedelta(seconds=s.seconds)
    candidate = now.replace(hour=s.hour, minute=s.minute, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate
