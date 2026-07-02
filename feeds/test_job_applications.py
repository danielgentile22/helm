#!/usr/bin/env python3
"""Fixture sweep for the job-application feed — jobStats + row shape + idempotency.

No real vault scan, nothing written to the real vault: job_stats runs against
synthetic application records and the CSV write runs against a tempfile. Mirrors
scripts/test-router.ts and feeds/test_claude_tokens.py (PASS/FAIL lines, nonzero
exit on any failure).

Run: python3 feeds/test_job_applications.py   (also wired into `npm test`)
"""
import importlib.util
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# load the hyphenated feed module by path (can't `import job-applications`)
_spec = importlib.util.spec_from_file_location(
    "job_applications", Path(__file__).with_name("job-applications.py")
)
ja = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ja)

# fixed reference clock — no Date.now() so the sweep is deterministic
NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)
NOW_EPOCH = NOW.timestamp()
DAY = 86400


def days_ago(n: float) -> str:
    """A YYYY-MM-DD date `n` days before NOW."""
    return datetime.fromtimestamp(NOW_EPOCH - n * DAY, tz=timezone.utc).strftime("%Y-%m-%d")


def app(company="Acme", role="SWE", applied=None, **extra) -> dict:
    rec = {"company": company, "role": role, "status": "applied"}
    if applied is not None:
        rec["applied"] = applied
    rec.update(extra)
    return rec


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


# --- record parsing: junk and empties drop, real records normalize -------------
check("blank / company-less / non-dict records parse to None",
      ja.application_record({}) is None
      and ja.application_record({"status": "applied"}) is None
      and ja.application_record("nope") is None)
check("a record with only a role still qualifies",
      ja.application_record({"role": "SWE"}) is not None)

# --- jobStats: total counts all, applied_7d counts only the window -------------
records = [
    ja.application_record(app("Acme", "Backend", days_ago(1))),    # this week
    ja.application_record(app("Globex", "Frontend", days_ago(6))),  # this week (inside 7d)
    ja.application_record(app("Initech", "Platform", days_ago(20))),  # older
    ja.application_record(app("Umbrella", "ML", applied=None)),     # no date → total only
]
total, week = ja.job_stats(records, NOW_EPOCH)
check("total counts every application", total == 4, got=total, want=4)
check("applied_7d counts only the last 7 days", week == 2, got=week, want=2)

# --- de-dup: same application logged twice is counted once ----------------------
dupe = [
    ja.application_record(app("Acme", "Backend", days_ago(1))),
    ja.application_record(app("Acme", "Backend", days_ago(1))),
]
dt, dw = ja.job_stats(dupe, NOW_EPOCH)
check("duplicate application counted once", (dt, dw) == (1, 1), got=(dt, dw), want=(1, 1))

# --- explicit id is the de-dup handle even when other fields differ ------------
byid = [
    ja.application_record(app("Acme", "Backend", days_ago(1), id="x1")),
    ja.application_record(app("Acme Corp", "Backend Eng", days_ago(2), id="x1")),
]
it, _ = ja.job_stats(byid, NOW_EPOCH)
check("same id counted once regardless of other fields", it == 1, got=it, want=1)

# --- empty store is a legitimate zero, not an error ----------------------------
zt, zw = ja.job_stats([], NOW_EPOCH)
check("no applications yields (0, 0)", (zt, zw) == (0, 0), got=(zt, zw), want=(0, 0))

# --- date boundary: today and a future-dated record --------------------------
edge = [
    ja.application_record(app("Today", "SWE", days_ago(0))),    # applied today → in
    ja.application_record(app("Future", "SWE", days_ago(-2))),  # dated 2d ahead → out
]
_, ew = ja.job_stats(edge, NOW_EPOCH)
check("today counts, future date excluded", ew == 1, got=ew, want=1)

# --- end-to-end store read + row shape + idempotency against a tempfile ---------
with tempfile.TemporaryDirectory() as d:
    import json
    store = Path(d) / "jobs" / ja.STORE_FILE
    store.parent.mkdir(parents=True)
    lines = [
        json.dumps(app("Acme", "Backend", days_ago(1))),
        json.dumps(app("Globex", "Frontend", days_ago(6))),
        json.dumps(app("Initech", "Platform", days_ago(20))),
        "",                          # blank line tolerated
        json.dumps({"junk": True}),  # company-less → skipped
        "# a comment line",          # comment → skipped
        "{ not valid json",          # malformed → skipped
    ]
    store.write_text("\n".join(lines) + "\n")
    st, sw = ja.job_stats(ja.iter_application_records(store), NOW_EPOCH)
    check("store read: 3 valid records, 2 this week", (st, sw) == (3, 2), got=(st, sw), want=(3, 2))

    # a stray non-UTF-8 byte in this hand-editable file is a one-line skip,
    # not a UnicodeDecodeError killing both metrics (review id 54)
    torn = Path(d) / "jobs" / "torn.jsonl"
    torn.write_bytes(
        json.dumps(app("Acme", "Backend", days_ago(1))).encode()
        + b"\n" + b'{"company": "Bad\xff", "role": "SWE"\n'
    )
    tt, tw = ja.job_stats(ja.iter_application_records(torn), NOW_EPOCH)
    check("non-UTF-8 byte skips the bad line, keeps the rest",
          (tt, tw) == (1, 1), got=(tt, tw), want=(1, 1))

    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ja.day_bucket(NOW)  # 2026-06-19T00:00:00Z

    w1 = ja.append_metric_row(csv, ts, ja.SOURCE, ja.METRIC_TOTAL, st)
    w2 = ja.append_metric_row(csv, ts, ja.SOURCE, ja.METRIC_WEEK, sw)
    again = ja.append_metric_row(csv, ts, ja.SOURCE, ja.METRIC_TOTAL, st)  # same day → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first writes append, re-run is idempotent no-op",
          (w1, w2, again) == (True, True, False), got=(w1, w2, again), want=(True, True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("two data rows after re-run (one per metric)", len(data) == 2, got=len(data), want=2)

    cols = data[0].split(",")
    check("total row is well-formed: 6 cols, right values",
          cols == [ts, "jobs", "applications", "3", "ok", ""],
          got=cols, want=[ts, "jobs", "applications", "3", "ok", ""])

    # a new day DOES append (idempotency is per-window, not forever)
    ts_next = ja.day_bucket(datetime(2026, 6, 20, 9, 0, 0, tzinfo=timezone.utc))
    wnext = ja.append_metric_row(csv, ts_next, ja.SOURCE, ja.METRIC_TOTAL, 4)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("a new day appends a fresh row",
          wnext is True and len(data2) == 3, got=(wnext, len(data2)), want=(True, 3))

total_cases = passed + failed
print(f"\nAll {total_cases} cases pass." if failed == 0 else f"\n{failed}/{total_cases} FAILED")
raise SystemExit(1 if failed else 0)
