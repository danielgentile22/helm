#!/usr/bin/env python3
"""Fixture sweep for the Claude Code token feed — compute + row shape + idempotency.

No network, no real ~/.claude scan, nothing written to the real vault: the
compute step runs against synthetic transcript records and the CSV write runs
against a tempfile. Mirrors scripts/test-router.ts (PASS/FAIL lines, nonzero
exit on any failure).

Run: python3 feeds/test_claude_tokens.py   (also wired into `npm test`)
"""
import importlib.util
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# load the hyphenated feed module by path (can't `import claude-tokens`)
_spec = importlib.util.spec_from_file_location(
    "claude_tokens", Path(__file__).with_name("claude-tokens.py")
)
ct = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ct)

# fixed reference clock — no Date.now() so the sweep is deterministic
NOW = datetime(2026, 6, 17, 14, 30, 0, tzinfo=timezone.utc)
NOW_EPOCH = NOW.timestamp()
HOUR = 3600


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def at(hours_ago: float) -> str:
    """ISO timestamp `hours_ago` before NOW."""
    return iso(datetime.fromtimestamp(NOW_EPOCH - hours_ago * HOUR, tz=timezone.utc))


# real-shaped transcript lines (subset of the keys Claude Code actually writes)
def line(uuid: str, hours_ago: float, out: int, type_: str = "assistant") -> dict:
    return {
        "type": type_,
        "uuid": uuid,
        "timestamp": at(hours_ago),
        "message": {"role": "assistant", "usage": {"input_tokens": 10, "output_tokens": out}},
    }


passed = 0
failed = 0


def check(name: str, ok: bool, got=None, want=None) -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}\n      got:  {got!r}\n      want: {want!r}")


# --- compute: in-window sum, window boundary, future excluded ------------------
records = [
    ct.usage_record(line("a", 0.5, 100)),   # 30m ago — in
    ct.usage_record(line("b", 4.9, 200)),   # 4h54m ago — in (just inside 5h)
    ct.usage_record(line("c", 5.5, 400)),   # 5h30m ago — out
    ct.usage_record(line("d", -0.5, 800)),  # 30m in the FUTURE — out
]
check("non-assistant / missing usage parse to None",
      ct.usage_record({"type": "user", "uuid": "u"}) is None
      and ct.usage_record(line("x", 1, 5, type_="user")) is None)

val = ct.rolling_output_tokens(records, NOW_EPOCH)
check("rolling sum counts only the 5h window", val == 300, got=val, want=300)

# --- dedup: same uuid across two files counted once ----------------------------
dupe = ct.rolling_output_tokens(
    [ct.usage_record(line("a", 0.5, 100)), ct.usage_record(line("a", 0.5, 100))], NOW_EPOCH
)
check("duplicate uuid counted once", dupe == 100, got=dupe, want=100)

# --- value can legitimately be 0 (nothing in window) ---------------------------
zero = ct.rolling_output_tokens([ct.usage_record(line("z", 9, 999))], NOW_EPOCH)
check("all-stale window yields 0", zero == 0, got=zero, want=0)

# --- row shape + idempotency against a tempfile --------------------------------
with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ct.hour_bucket(NOW)  # 2026-06-17T14:00:00Z

    wrote1 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 300)
    wrote2 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 300)  # same hour → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first write appends, second is idempotent no-op",
          wrote1 is True and wrote2 is False, got=(wrote1, wrote2), want=(True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("exactly one data row after re-run", len(data) == 1, got=len(data), want=1)

    cols = data[0].split(",") if data else []
    check("row is well-formed: 6 cols, right values",
          cols == [ts, "claude_code", "tokens_5h", "300", "ok", ""],
          got=cols, want=[ts, "claude_code", "tokens_5h", "300", "ok", ""])

    # a different hour bucket DOES append (idempotency is per-window, not forever)
    ts_next = ct.hour_bucket(datetime(2026, 6, 17, 15, 5, 0, tzinfo=timezone.utc))
    wrote3 = ct.append_metric_row(csv, ts_next, ct.SOURCE, ct.METRIC, 350)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("new hour bucket appends a fresh row",
          wrote3 is True and len(data2) == 2, got=(wrote3, len(data2)), want=(True, 2))

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
