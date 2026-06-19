#!/usr/bin/env python3
"""Job-application feed for the HELM HUD Vitals panel.

Derives Daniel's top-directive numbers — how many jobs he's applied to, and how
many of those landed in the last 7 days — from a plain-file vault store, and
appends them to metrics.csv under two metrics the Vitals tile reads:

    <day-bucket-iso>,jobs,applications,<total>,ok,
    <day-bucket-iso>,jobs,applied_7d,<count in last 7 days>,ok,

Source of truth: a JSONL store at <vault>/jobs/applications.jsonl — one
application per line, e.g.

    {"company":"Acme","role":"Backend Engineer","applied":"2026-06-15","status":"applied","link":"https://..."}

The file is yours: greppable, hand-editable, and append-only, so it survives
independent of the HUD and any future capture mechanism (voice / inbox-scan /
manual edit — deliberately left open for now) just appends a line. Required per
record is a company OR a role; `applied` (YYYY-MM-DD) drives the 7-day window;
everything else is optional. Records are de-duplicated by `id` when present,
else by company|role|applied, so an accidental double entry never double-counts.

Idempotent per day: each row is stamped to the top of the current UTC day, and
we skip the write if a row already exists for that (source, metric, day). A
daily launchd cadence therefore never duplicates a row, and the metrics reader's
24-point cap turns the sparkline into a rolling ~24-day momentum view.

A legitimate reading can be 0 (no applications yet, or none this week), so we DO
write a 0 row — it keeps the sparkline continuous. We only bail without writing
on a real error (no vault). A missing store is treated as zero applications, not
an error: the tile should read "0 applied" honestly rather than going stale.

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT   vault folder (metrics.csv lives at system/metrics/)
  JOBS_DIR     application-store folder (default: <vault>/jobs)
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

WINDOW_S = 7 * 86400  # the "7d" in applied_7d
SOURCE = "jobs"
METRIC_TOTAL = "applications"
METRIC_WEEK = "applied_7d"
STORE_FILE = "applications.jsonl"
CSV_HEADER = "timestamp,source,metric,value,status,error\n"


def load_home_env() -> None:
    """Mirror the runner/HUD/USCF loader: ~/.claude/.env, real env wins."""
    f = Path.home() / ".claude" / ".env"
    try:
        for line in f.read_text().splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip("\"'")
    except FileNotFoundError:
        pass


# --- compute step (pure; exercised by feeds/test_job_applications.py) ----------

def parse_day(value) -> float | None:
    """A YYYY-MM-DD (or full ISO) date -> epoch seconds at UTC, or None."""
    if not isinstance(value, str) or not value:
        return None
    head = value.strip()[:10]
    try:
        d = datetime.strptime(head, "%Y-%m-%d")
        return d.replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def application_record(entry: dict) -> dict | None:
    """One store line -> normalized {key, applied_epoch}, or None.

    A record qualifies if it carries a non-empty company or role. `key` is the
    explicit `id` when present, else company|role|applied — the de-dup handle so
    a line is counted exactly once. applied_epoch is None when the date is
    missing or unparseable (the record still counts toward the total, just not
    toward the 7-day window).
    """
    if not isinstance(entry, dict):
        return None
    company = str(entry.get("company") or "").strip()
    role = str(entry.get("role") or "").strip()
    if not company and not role:
        return None
    applied = entry.get("applied")
    key = str(entry.get("id") or "").strip() or f"{company}|{role}|{applied}"
    return {"key": key, "applied_epoch": parse_day(applied)}


def job_stats(records, now: float, window_s: int = WINDOW_S) -> tuple[int, int]:
    """The pure `jobStats`: (total applications, applications in the last
    `window_s`). `records` is any iterable of application_record() dicts;
    de-duplicated by `key` so the same application is never counted twice."""
    by_key: dict[str, float | None] = {}
    for rec in records:
        by_key[rec["key"]] = rec["applied_epoch"]
    cutoff = now - window_s
    total = len(by_key)
    week = sum(1 for ts in by_key.values() if ts is not None and cutoff <= ts <= now)
    return (total, week)


def iter_application_records(store_path: Path):
    """Yield application_record dicts from the JSONL store. Tolerant: a missing
    file yields nothing, and malformed lines are skipped rather than fatal."""
    try:
        lines = store_path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError):
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        rec = application_record(entry)
        if rec is not None:
            yield rec


# --- metrics.csv write (idempotent per source/metric/timestamp) ----------------

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
    if not csv_path.exists():
        csv_path.write_text(CSV_HEADER)
    if row_exists(csv_path, ts, source, metric):
        return False
    with csv_path.open("a") as fh:
        fh.write(f"{ts},{source},{metric},{value},{status},\n")
    return True


def main() -> int:
    load_home_env()
    vault = os.environ.get("VAULT_ROOT", "").strip()
    if not vault:
        print("VAULT_ROOT not set", file=sys.stderr)
        return 2

    jobs_dir = os.environ.get("JOBS_DIR", "").strip() or str(Path(vault) / "jobs")
    store = Path(jobs_dir) / STORE_FILE

    now_dt = datetime.now(timezone.utc)
    total, week = job_stats(iter_application_records(store), now_dt.timestamp())

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    ts = day_bucket(now_dt)
    w1 = append_metric_row(csv, ts, SOURCE, METRIC_TOTAL, total)
    w2 = append_metric_row(csv, ts, SOURCE, METRIC_WEEK, week)
    verb = "appended" if (w1 or w2) else "skipped (idempotent)"
    print(f"{verb} {SOURCE}: {total} applications, {week} in last 7d at {ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
