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


# --- usage_pcts: the happy path, shape captured from the live endpoint ---------
LIVE_SHAPE = {
    "five_hour": {"utilization": 8.0, "resets_at": "2026-07-06T04:59:59+00:00"},
    "seven_day": {"utilization": 33.0, "resets_at": "2026-07-11T05:59:59+00:00"},
    "limits": [
        {"kind": "session", "group": "session", "percent": 8},
        {"kind": "weekly_all", "group": "weekly", "percent": 33},
        {"kind": "weekly_scoped", "group": "weekly", "percent": 43,
         "scope": {"model": {"id": None, "display_name": "Fable"}}},
    ],
}
WANT = {"pct_5h": 8, "pct_7d": 33, "pct_7d_fable": 43}
check("live-shaped payload -> all three percentages",
      ct.usage_pcts(LIVE_SHAPE) == WANT, got=ct.usage_pcts(LIVE_SHAPE), want=WANT)

check("fractional utilization rounds",
      ct.usage_pcts({"five_hour": {"utilization": 42.6}}) == {"pct_5h": 43})
check("0 is a legitimate reading",
      ct.usage_pcts({"five_hour": {"utilization": 0}}) == {"pct_5h": 0})
check("clamped to 0-100",
      ct.usage_pcts({"five_hour": {"utilization": 250}}) == {"pct_5h": 100}
      and ct.usage_pcts({"five_hour": {"utilization": -3}}) == {"pct_5h": 0})
check("no weekly_scoped limit -> no fable metric, others intact",
      ct.usage_pcts({"seven_day": {"utilization": 33}, "limits": [{"kind": "session", "percent": 8}]})
      == {"pct_7d": 33})

# --- usage_pcts: malformed shapes are absent (skip write, never a fake row) ----
for name, payload in [
    ("non-dict payload", None),
    ("empty payload", {}),
    ("blocks null", {"five_hour": None, "seven_day": None, "limits": None}),
    ("missing utilization", {"five_hour": {"resets_at": "x"}}),
    ("utilization null", {"five_hour": {"utilization": None}}),
    ("utilization string", {"five_hour": {"utilization": "8"}}),
    ("utilization bool", {"five_hour": {"utilization": True}}),
    ("scoped percent string", {"limits": [{"kind": "weekly_scoped", "percent": "43"}]}),
    ("limits not a list of dicts", {"limits": ["weekly_scoped"]}),
]:
    check(f"{name} -> empty", ct.usage_pcts(payload) == {}, got=ct.usage_pcts(payload), want={})

# --- row shape + idempotency against a tempfile --------------------------------
NOW = datetime(2026, 6, 17, 14, 30, 0, tzinfo=timezone.utc)

with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ct.hour_bucket(NOW)  # 2026-06-17T14:00:00Z

    wrote1 = ct.append_metric_row(csv, ts, ct.SOURCE, "pct_5h", 8)
    wrote2 = ct.append_metric_row(csv, ts, ct.SOURCE, "pct_5h", 8)  # same hour → no-op

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

    # a sibling metric in the SAME hour appends (idempotency is per-metric)
    wrote_sib = ct.append_metric_row(csv, ts, ct.SOURCE, "pct_7d_fable", 43)
    check("sibling metric in the same hour appends", wrote_sib is True, got=wrote_sib)

    # a different hour bucket DOES append (idempotency is per-window, not forever)
    ts_next = ct.hour_bucket(datetime(2026, 6, 17, 15, 5, 0, tzinfo=timezone.utc))
    wrote3 = ct.append_metric_row(csv, ts_next, ct.SOURCE, "pct_5h", 9)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("new hour bucket appends a fresh row",
          wrote3 is True and len(data2) == 3, got=(wrote3, len(data2)), want=(True, 3))

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
