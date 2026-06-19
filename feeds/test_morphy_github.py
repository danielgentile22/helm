#!/usr/bin/env python3
"""Fixture sweep for the Morphy GitHub feed — github_stats + row shape + idempotency.

Drives the pure compute step against sample GitHub API JSON (no network, nothing
written to the real vault: the CSV write runs against a tempfile). Mirrors
feeds/test_job_applications.py (PASS/FAIL lines, nonzero exit on any failure).

Run: python3 feeds/test_morphy_github.py   (also wired into `npm test`)
"""
import importlib.util
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# load the hyphenated feed module by path (can't `import morphy-github`)
_spec = importlib.util.spec_from_file_location(
    "morphy_github", Path(__file__).with_name("morphy-github.py")
)
mg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mg)

# fixed reference clock — no Date.now() so the sweep is deterministic
NOW = datetime(2026, 6, 19, 12, 0, 0, tzinfo=timezone.utc)
NOW_EPOCH = NOW.timestamp()
DAY = 86400


def days_ago_iso(n: float) -> str:
    """A GitHub ISO-8601 timestamp `n` days before NOW."""
    return datetime.fromtimestamp(NOW_EPOCH - n * DAY, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def commit(n_days_ago: float, who: str = "committer") -> dict:
    """A commit object shaped like the GitHub API's, dated `n_days_ago`."""
    return {"sha": "abc", "commit": {who: {"date": days_ago_iso(n_days_ago)}}}


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


# --- commits: only those inside the 7-day window count -------------------------
commits = [
    commit(0),                       # today        → in
    commit(1),                       # yesterday    → in
    commit(6.9),                     # just inside  → in
    commit(7.5),                     # last week    → out
    commit(30),                      # last month   → out
    commit(2, who="author"),         # author date used when committer absent → in
    {"sha": "nodate", "commit": {}},  # undated      → not counted
    {"sha": "junk"},                 # malformed    → not counted
]
n_commits = mg.count_recent_commits(commits, NOW_EPOCH)
check("commits_7d counts only commits inside the window", n_commits == 4,
      got=n_commits, want=4)

# --- open issues: PRs folded into the /issues feed are excluded ----------------
issues = [
    {"number": 1, "title": "real issue"},
    {"number": 2, "title": "another issue"},
    {"number": 3, "title": "a PR in disguise", "pull_request": {"url": "..."}},
    "garbage",  # non-dict tolerated
]
n_issues = mg.count_open_issues(issues)
check("open_issues excludes pull requests and junk", n_issues == 2,
      got=n_issues, want=2)

# --- open PRs: the /pulls feed is PRs only -------------------------------------
pulls = [{"number": 3, "title": "feat"}, {"number": 4, "title": "fix"}]
n_prs = mg.count_open_prs(pulls)
check("open_prs counts the pulls feed", n_prs == 2, got=n_prs, want=2)

# --- the combined roll-up ------------------------------------------------------
c, p, i = mg.github_stats(commits, pulls, issues, NOW_EPOCH)
check("github_stats rolls up (commits, prs, issues)", (c, p, i) == (4, 2, 2),
      got=(c, p, i), want=(4, 2, 2))

# --- a dead-quiet repo is a legitimate (0, 0, 0), not an error -----------------
z = mg.github_stats([], [], [], NOW_EPOCH)
check("an empty repo yields (0, 0, 0)", z == (0, 0, 0), got=z, want=(0, 0, 0))

# --- end-to-end row shape + idempotency against a tempfile ---------------------
with tempfile.TemporaryDirectory() as d:
    csv = Path(d) / "system" / "metrics" / "metrics.csv"
    ts = mg.day_bucket(NOW)  # 2026-06-19T00:00:00Z

    w1 = mg.append_metric_row(csv, ts, mg.SOURCE, mg.METRIC_COMMITS, c)
    w2 = mg.append_metric_row(csv, ts, mg.SOURCE, mg.METRIC_PRS, p)
    w3 = mg.append_metric_row(csv, ts, mg.SOURCE, mg.METRIC_ISSUES, i)
    again = mg.append_metric_row(csv, ts, mg.SOURCE, mg.METRIC_COMMITS, c)  # same day → no-op

    body = csv.read_text().splitlines()
    data = [ln for ln in body[1:] if ln.strip()]

    check("first writes append, re-run is idempotent no-op",
          (w1, w2, w3, again) == (True, True, True, False),
          got=(w1, w2, w3, again), want=(True, True, True, False))
    check("header is the frozen contract",
          body[0] == "timestamp,source,metric,value,status,error", got=body[0])
    check("three data rows after re-run (one per metric)", len(data) == 3,
          got=len(data), want=3)

    cols = data[0].split(",")
    check("commits row is well-formed: 6 cols, right values",
          cols == [ts, "github", "commits_7d", "4", "ok", ""],
          got=cols, want=[ts, "github", "commits_7d", "4", "ok", ""])

    # a new day DOES append (idempotency is per-window, not forever)
    ts_next = mg.day_bucket(datetime(2026, 6, 20, 9, 0, 0, tzinfo=timezone.utc))
    wnext = mg.append_metric_row(csv, ts_next, mg.SOURCE, mg.METRIC_COMMITS, 5)
    data2 = [ln for ln in csv.read_text().splitlines()[1:] if ln.strip()]
    check("a new day appends a fresh row",
          wnext is True and len(data2) == 4, got=(wnext, len(data2)), want=(True, 4))

total_cases = passed + failed
print(f"\nAll {total_cases} cases pass." if failed == 0 else f"\n{failed}/{total_cases} FAILED")
raise SystemExit(1 if failed else 0)
