"""Shared metrics.csv contract for the HELM feeds (issue #42, review id 57).

One implementation of the pieces every feed previously copy-pasted (and let
drift): the ~/.claude/.env loader, the hour/day bucket stamps, and the
idempotent metrics.csv row append. Imported as a plain sibling module — every
real invocation (launchd absolute path, `python3 feeds/<feed>.py`, the test
sweeps) runs with feeds/ as sys.path[0], so `from _metrics import ...` just
works with no path games.

The frozen contract: metrics.csv is header + append-only rows of
    timestamp,source,metric,value,status,error
and a (source, metric, timestamp) row is written at most once — re-running a
feed within the same bucket is a no-op.
"""
import os
import re
from datetime import datetime, timezone
from pathlib import Path

CSV_HEADER = "timestamp,source,metric,value,status,error\n"


def load_home_env() -> None:
    """Mirror the runner/HUD loader: ~/.claude/.env, real env wins."""
    f = Path.home() / ".claude" / ".env"
    try:
        for line in f.read_text().splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip("\"'")
    except FileNotFoundError:
        pass


def hour_bucket(now_dt: datetime) -> str:
    """Floor an aware UTC datetime to the top of the hour, as a metrics ISO ts."""
    return now_dt.astimezone(timezone.utc).replace(
        minute=0, second=0, microsecond=0
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_bucket(now_dt: datetime) -> str:
    """Floor an aware UTC datetime to the top of the day, as a metrics ISO ts."""
    return now_dt.astimezone(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).strftime("%Y-%m-%dT%H:%M:%SZ")


def row_exists(csv_path: Path, ts: str, source: str, metric: str) -> bool:
    try:
        lines = csv_path.read_text().splitlines()
    except FileNotFoundError:
        return False
    for line in lines[1:]:  # skip header
        cols = line.split(",")
        if len(cols) >= 3 and cols[0] == ts and cols[1] == source and cols[2] == metric:
            return True
    return False


def append_metric_row(
    csv_path, ts: str, source: str, metric: str, value: int, status: str = "ok"
) -> bool:
    """Append one well-formed metrics row, unless (source, metric, ts) already
    exists. Returns True if written, False on the idempotent no-op."""
    csv_path = Path(csv_path)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    # exclusive create: two feeds firing at the same minute on a fresh vault
    # race here — "x" makes one loser instead of a truncating write (review 59)
    try:
        with open(csv_path, "x") as fh:
            fh.write(CSV_HEADER)
    except FileExistsError:
        pass
    if row_exists(csv_path, ts, source, metric):
        return False
    with csv_path.open("a") as fh:
        fh.write(f"{ts},{source},{metric},{value},{status},\n")
    return True
