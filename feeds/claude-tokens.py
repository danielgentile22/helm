#!/usr/bin/env python3
"""Claude Code token feed for the HELM HUD Vitals panel.

Computes the rolling 5-hour OUTPUT-token total from Claude Code's local usage
data and appends one row to the vault's metrics.csv under the metric the
"Claude 5h Window" tile already reads:

    <hour-bucket-iso>,claude_code,tokens_5h,<value>,ok,

Source of truth: Claude Code writes a JSONL transcript per session under
~/.claude/projects/<project-slug>/<session-id>.jsonl. Each assistant turn is one
line carrying message.usage.output_tokens and an ISO `timestamp`. We sum
output_tokens for every assistant line whose timestamp falls in the last 5 hours,
de-duplicating by the line `uuid` (resumed/forked sessions copy prior lines
verbatim, so the same uuid can appear in more than one file — count it once).

Idempotent per window: the appended row is stamped to the top of the current
hour, and we skip the write if a claude_code/tokens_5h row already exists for
that hour. Re-running within the same hour is a no-op, so a tight launchd cadence
never duplicates a row. (metrics.csv reader keeps the last 24 points → an hourly
cadence makes the tile's sparkline a rolling 24-hour view.)

Unlike the USCF feed, a legitimate reading can be 0 (you used Claude zero in the
last 5h), so we DO write a 0 row — it keeps the sparkline continuous. We only
bail without writing on a real error (no vault, unreadable projects dir).

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT            vault folder (metrics.csv lives at system/metrics/)
  CLAUDE_PROJECTS_DIR   transcript root (default: ~/.claude/projects)
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

WINDOW_S = 5 * 3600  # the "5h" in tokens_5h
SOURCE = "claude_code"
METRIC = "tokens_5h"
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


# --- compute step (pure; exercised by feeds/test_claude_tokens.py) -------------

def parse_iso(ts: str) -> float | None:
    """ISO-8601 (with trailing Z or offset) -> epoch seconds, or None."""
    if not isinstance(ts, str) or not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def usage_record(entry: dict) -> tuple[str, float, int] | None:
    """One transcript line -> (uuid, ts_epoch, output_tokens), or None.

    Only assistant turns carrying a numeric output_tokens and a parseable
    timestamp qualify. uuid falls back to requestId then a synthetic key so a
    line is never silently dropped, but is also never double-counted.
    """
    if not isinstance(entry, dict) or entry.get("type") != "assistant":
        return None
    usage = ((entry.get("message") or {}).get("usage")) or {}
    toks = usage.get("output_tokens")
    if not isinstance(toks, (int, float)) or isinstance(toks, bool):
        return None
    epoch = parse_iso(entry.get("timestamp"))
    if epoch is None:
        return None
    uid = entry.get("uuid") or entry.get("requestId") or f"{entry.get('timestamp')}:{toks}"
    return (str(uid), epoch, int(toks))


def rolling_output_tokens(records, now: float, window_s: int = WINDOW_S) -> int:
    """Sum output_tokens over distinct uuids whose timestamp is in
    [now - window_s, now]. `records` is any iterable of (uuid, ts_epoch, toks)."""
    cutoff = now - window_s
    by_uuid: dict[str, tuple[float, int]] = {}
    for uid, ts, toks in records:
        by_uuid[uid] = (ts, toks)  # same uuid → identical payload; last wins
    return sum(toks for ts, toks in by_uuid.values() if cutoff <= ts <= now)


def iter_usage_records(projects_dir: str):
    """Yield usage_record tuples from every *.jsonl under projects_dir.
    Tolerant: unreadable files and malformed lines are skipped, not fatal."""
    root = Path(projects_dir)
    if not root.exists():
        return
    for path in root.rglob("*.jsonl"):
        try:
            with path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    # cheap prefilter — most lines (user turns, tool results)
                    # have no usage block, so skip the json.loads for them
                    if not line or '"output_tokens"' not in line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    rec = usage_record(entry)
                    if rec is not None:
                        yield rec
        except OSError:
            continue


# --- metrics.csv write (idempotent per source/metric/timestamp) ----------------

def hour_bucket(now_dt: datetime) -> str:
    """Floor an aware UTC datetime to the top of the hour, as a metrics ISO ts."""
    return now_dt.astimezone(timezone.utc).replace(
        minute=0, second=0, microsecond=0
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

    projects = os.environ.get("CLAUDE_PROJECTS_DIR", "").strip() or str(
        Path.home() / ".claude" / "projects"
    )
    if not Path(projects).exists():
        print(f"Claude projects dir not found: {projects}", file=sys.stderr)
        return 1

    now_dt = datetime.now(timezone.utc)
    total = rolling_output_tokens(iter_usage_records(projects), now_dt.timestamp())

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    ts = hour_bucket(now_dt)
    wrote = append_metric_row(csv, ts, SOURCE, METRIC, total)
    verb = "appended" if wrote else "skipped (idempotent)"
    print(f"{verb} {SOURCE}/{METRIC}={total} at {ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
