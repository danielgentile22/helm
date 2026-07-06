#!/usr/bin/env python3
"""Fixture sweep for the Claude usage feed — payload transform + row shape +
idempotency.

No network, no keychain, nothing written to the real vault: session_pct runs
against canned OAuth-usage responses (shape captured from the live endpoint)
and the CSV write runs against a tempfile. Mirrors scripts/test-router.ts
(PASS/FAIL lines, nonzero exit on any failure).

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


# --- session_pct: the happy path, shape captured from the live endpoint --------
LIVE_SHAPE = {
    "five_hour": {"utilization": 8.0, "resets_at": "2026-07-06T04:59:59+00:00"},
    "seven_day": {"utilization": 33.0, "resets_at": "2026-07-11T05:59:59+00:00"},
    "limits": [{"kind": "session", "percent": 8}],
}
check("live-shaped payload -> rounded session percent",
      ct.session_pct(LIVE_SHAPE) == 8, got=ct.session_pct(LIVE_SHAPE), want=8)

check("fractional utilization rounds", ct.session_pct({"five_hour": {"utilization": 42.6}}) == 43)
check("0 is a legitimate reading", ct.session_pct({"five_hour": {"utilization": 0}}) == 0)
check("clamped to 0-100", ct.session_pct({"five_hour": {"utilization": 250}}) == 100
      and ct.session_pct({"five_hour": {"utilization": -3}}) == 0)

# --- session_pct: every malformed shape -> None (skip write, never a fake row) -
for name, payload in [
    ("non-dict payload", None),
    ("missing five_hour", {}),
    ("five_hour null", {"five_hour": None}),
    ("missing utilization", {"five_hour": {"resets_at": "x"}}),
    ("utilization null", {"five_hour": {"utilization": None}}),
    ("utilization string", {"five_hour": {"utilization": "8"}}),
    ("utilization bool", {"five_hour": {"utilization": True}}),
]:
    check(f"{name} -> None", ct.session_pct(payload) is None, got=ct.session_pct(payload))

# --- row shape + idempotency against a tempfile --------------------------------
NOW = datetime(2026, 6, 17, 14, 30, 0, tzinfo=timezone.utc)

with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ct.hour_bucket(NOW)  # 2026-06-17T14:00:00Z

    wrote1 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 8)
    wrote2 = ct.append_metric_row(csv, ts, ct.SOURCE, ct.METRIC, 8)  # same hour → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first write appends, second is idempotent no-op",
          wrote1 is True and wrote2 is False, got=(wrote1, wrote2), want=(True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("exactly one data row after re-run", len(data) == 1, got=len(data), want=1)

    cols = data[0].split(",") if data else []
    check("row is well-formed: 6 cols, right values",
          cols == [ts, "claude_code", "pct_5h", "8", "ok", ""],
          got=cols, want=[ts, "claude_code", "pct_5h", "8", "ok", ""])

    # a different hour bucket DOES append (idempotency is per-window, not forever)
    ts_next = ct.hour_bucket(datetime(2026, 6, 17, 15, 5, 0, tzinfo=timezone.utc))
    wrote3 = ct.append_metric_row(csv, ts_next, ct.SOURCE, ct.METRIC, 9)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("new hour bucket appends a fresh row",
          wrote3 is True and len(data2) == 2, got=(wrote3, len(data2)), want=(True, 2))

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
