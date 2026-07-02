#!/usr/bin/env python3
"""Claude Code token feed for the HELM HUD Vitals panel.

Computes the rolling 5-hour OUTPUT-token total from Claude Code's local usage
data and appends one row to the vault's metrics.csv under the metric the
"Claude 5h Window" tile already reads:

    <hour-bucket-iso>,claude_code,tokens_5h,<value>,ok,

Source of truth: Claude Code writes a JSONL transcript per session under
~/.claude/projects/<project-slug>/<session-id>.jsonl. One API response spans
MULTIPLE assistant lines (one per content block), each with a different line
`uuid` but the same `message.id` and an identical usage payload — so we sum
output_tokens over distinct message.ids in the last 5 hours. That also covers
resumed/forked sessions, which copy prior lines (message.id included) verbatim
across files: every response counts exactly once.

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
import sys
from datetime import datetime, timezone
from pathlib import Path

from _metrics import append_metric_row, hour_bucket, load_home_env

WINDOW_S = 5 * 3600  # the "5h" in tokens_5h
MTIME_SLACK_S = 3600  # clock-skew slack for the file-mtime prefilter
SOURCE = "claude_code"
METRIC = "tokens_5h"


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
    """One transcript line -> (dedup key, ts_epoch, output_tokens), or None.

    Only assistant turns carrying a numeric output_tokens and a parseable
    timestamp qualify. The dedup key is message.id FIRST: one API response is
    written as one line PER CONTENT BLOCK, each with a different line uuid but
    the same message.id and an identical usage payload — keying on uuid summed
    every copy (~3x overcount, review id 52). requestId (also shared across a
    response's lines), uuid, then a synthetic key are fallbacks so a line is
    never silently dropped.
    """
    if not isinstance(entry, dict) or entry.get("type") != "assistant":
        return None
    message = entry.get("message") or {}
    usage = message.get("usage") or {}
    toks = usage.get("output_tokens")
    if not isinstance(toks, (int, float)) or isinstance(toks, bool):
        return None
    epoch = parse_iso(entry.get("timestamp"))
    if epoch is None:
        return None
    uid = (
        message.get("id")
        or entry.get("requestId")
        or entry.get("uuid")
        or f"{entry.get('timestamp')}:{toks}"
    )
    return (str(uid), epoch, int(toks))


def rolling_output_tokens(records, now: float, window_s: int = WINDOW_S) -> int:
    """Sum output_tokens over distinct dedup keys (message.id) whose timestamp is
    in [now - window_s, now]. `records` is any iterable of (key, ts_epoch, toks)."""
    cutoff = now - window_s
    by_key: dict[str, tuple[float, int]] = {}
    for uid, ts, toks in records:
        by_key[uid] = (ts, toks)  # same message.id → identical payload; last wins
    return sum(toks for ts, toks in by_key.values() if cutoff <= ts <= now)


def iter_usage_records(projects_dir: str, min_mtime: float | None = None):
    """Yield usage_record tuples from every *.jsonl under projects_dir.
    Tolerant: unreadable files and malformed lines are skipped, not fatal
    (errors="replace" turns a torn multi-byte sequence mid-append into a line
    json.loads rejects, instead of a UnicodeDecodeError killing the run).

    min_mtime: skip files last written before this epoch — a line's timestamp
    can never be later than the file's mtime, so files stale relative to the
    window can't contribute and reading them is pure waste (review id 53)."""
    root = Path(projects_dir)
    if not root.exists():
        return
    for path in root.rglob("*.jsonl"):
        try:
            if min_mtime is not None and path.stat().st_mtime < min_mtime:
                continue
            with path.open(encoding="utf-8", errors="replace") as fh:
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


# --- metrics.csv write: shared _metrics helpers (hour bucket, idempotent append)

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
    now = now_dt.timestamp()
    records = iter_usage_records(projects, min_mtime=now - WINDOW_S - MTIME_SLACK_S)
    total = rolling_output_tokens(records, now)

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    ts = hour_bucket(now_dt)
    wrote = append_metric_row(csv, ts, SOURCE, METRIC, total)
    verb = "appended" if wrote else "skipped (idempotent)"
    print(f"{verb} {SOURCE}/{METRIC}={total} at {ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
