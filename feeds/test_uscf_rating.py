#!/usr/bin/env python3
"""Fixture sweep for the USCF rating feed — regular_rating parse + row shape +
per-day idempotency.

No network, nothing written to the real vault: the parse step runs against
sample API JSON and the CSV write runs against a tempfile. Mirrors
feeds/test_claude_tokens.py (PASS/FAIL lines, nonzero exit on any failure).

Run: python3 feeds/test_uscf_rating.py   (also wired into `npm test`)
"""
import importlib.util
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# load the hyphenated feed module by path (can't `import uscf-rating`)
_spec = importlib.util.spec_from_file_location(
    "uscf_rating", Path(__file__).with_name("uscf-rating.py")
)
ur = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ur)

NOW = datetime(2026, 6, 17, 14, 30, 0, tzinfo=timezone.utc)

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


def raises(fn, needle: str) -> bool:
    """fn() must raise RuntimeError mentioning `needle`."""
    try:
        fn()
        return False
    except RuntimeError as e:
        return needle in str(e)


# --- parse: R among other rating systems, Unrated, missing R -------------------
multi = {"ratings": [
    {"rating": 1400, "ratingSystem": "Q", "floor": 1200},
    {"rating": 1545, "ratingSystem": "R", "floor": 1300},
    {"rating": 1300, "ratingSystem": "B"},
]}
val = ur.regular_rating(multi)
check("picks Regular ('R') among Q/R/B systems", val == 1545, got=val, want=1545)

check("Unrated in Regular (no 'rating' key) raises",
      raises(lambda: ur.regular_rating({"ratings": [{"ratingSystem": "R"}]}), "Unrated"))
check("no 'R' system at all raises",
      raises(lambda: ur.regular_rating({"ratings": [{"rating": 1400, "ratingSystem": "Q"}]}),
             "no Regular"))
check("empty / ratings-less document raises",
      raises(lambda: ur.regular_rating({}), "no Regular"))

# --- row shape + per-day idempotency against a tempfile (review id 55: manual
# re-runs and launchctl kickstarts must be no-ops, like every other feed) -------
with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = ur.day_bucket(NOW)  # 2026-06-17T00:00:00Z

    wrote1 = ur.append_metric_row(csv, ts, ur.SOURCE, ur.METRIC, 1545)
    wrote2 = ur.append_metric_row(csv, ts, ur.SOURCE, ur.METRIC, 1545)  # same day → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first write appends, same-day re-run is idempotent no-op",
          wrote1 is True and wrote2 is False, got=(wrote1, wrote2), want=(True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("exactly one data row after re-run", len(data) == 1, got=len(data), want=1)

    cols = data[0].split(",") if data else []
    check("row is well-formed: 6 cols, right values",
          cols == [ts, "uscf", "rating", "1545", "ok", ""],
          got=cols, want=[ts, "uscf", "rating", "1545", "ok", ""])

    # a new day DOES append (idempotency is per-window, not forever)
    ts_next = ur.day_bucket(datetime(2026, 6, 18, 8, 0, 0, tzinfo=timezone.utc))
    wrote3 = ur.append_metric_row(csv, ts_next, ur.SOURCE, ur.METRIC, 1550)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("a new day appends a fresh row",
          wrote3 is True and len(data2) == 2, got=(wrote3, len(data2)), want=(True, 2))

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
