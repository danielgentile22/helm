#!/usr/bin/env python3
"""Morphy GitHub-activity feed for the HELM HUD Vitals panel.

Reports recent engineering activity for ONE repository — the Morphy repo only —
and appends it to metrics.csv under a `github` source, three metrics the Vitals
tile reads:

    <day-bucket-iso>,github,commits_7d,<commits in the last 7 days>,ok,
    <day-bucket-iso>,github,open_prs,<open pull requests>,ok,
    <day-bucket-iso>,github,open_issues,<open issues, PRs excluded>,ok,

Scope is deliberately ONE repo, identified by a single configurable setting, so
Morphy's build progress shows on the cockpit without leaking Daniel's other
GitHub work. If the setting is unset, the feed NO-OPS cleanly: it writes no rows
and exits 0. That is the configured-off state, distinct from an error.

    GET /repos/{owner}/{repo}/commits?since=<7d ago>  → recent commits
    GET /repos/{owner}/{repo}/pulls?state=open        → open PRs
    GET /repos/{owner}/{repo}/issues?state=open       → open issues + PRs

The issues endpoint returns pull requests too (GitHub models a PR as an issue);
we exclude any item carrying a `pull_request` key so open_issues is issues only
and open_prs never double-counts. That gotcha is the crux of the compute test.

Auth: a token lifts the 60-req/hr anonymous cap and is REQUIRED for a private
repo. We read GITHUB_TOKEN from the env (or ~/.claude/.env); if absent we fall
back to `gh auth token` (the gh CLI is logged in on this machine). Anonymous
still works for a public repo.

On any API failure (network, 404, rate limit, auth) we log to stderr and exit
non-zero WITHOUT writing rows, so the tile keeps its last good value instead of
flashing an error — same contract as the USCF feed. A legitimately quiet repo
(0 commits this week) DOES write a 0 row: that is real data, not a failure.

Idempotent per day: each row is stamped to the top of the current UTC day and
skipped if a row already exists for that (source, metric, day). A daily launchd
cadence therefore never duplicates a row, and the reader's history cap turns the
commits sparkline into a rolling momentum view.

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT     vault folder (metrics.csv lives at system/metrics/)
  MORPHY_REPO    the one repo as "owner/repo"; unset/blank → feed no-ops
  GITHUB_TOKEN   optional PAT/OAuth token; falls back to `gh auth token`
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://api.github.com"
USER_AGENT = "helm-morphy-feed/1.0 (+https://github.com/danielgentile22)"
TIMEOUT = 30.0
WINDOW_S = 7 * 86400  # the "7d" in commits_7d
PER_PAGE = 100
MAX_PAGES = 10  # backstop: never walk more than 1000 items for one count

SOURCE = "github"
METRIC_COMMITS = "commits_7d"
METRIC_PRS = "open_prs"
METRIC_ISSUES = "open_issues"
CSV_HEADER = "timestamp,source,metric,value,status,error\n"


def load_home_env() -> None:
    """Mirror the runner/HUD/feeds loader: ~/.claude/.env, real env wins."""
    f = Path.home() / ".claude" / ".env"
    try:
        for line in f.read_text().splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip("\"'")
    except FileNotFoundError:
        pass


# --- compute step (pure; exercised by feeds/test_morphy_github.py) -------------

def parse_iso(value) -> float | None:
    """A GitHub ISO-8601 timestamp ('2026-06-18T12:00:00Z') -> epoch seconds."""
    if not isinstance(value, str) or not value:
        return None
    try:
        d = datetime.strptime(value.strip(), "%Y-%m-%dT%H:%M:%SZ")
        return d.replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def commit_epoch(commit: dict) -> float | None:
    """When a commit landed: committer date, falling back to author date."""
    c = commit.get("commit") if isinstance(commit, dict) else None
    if not isinstance(c, dict):
        return None
    for who in ("committer", "author"):
        sub = c.get(who)
        if isinstance(sub, dict):
            ts = parse_iso(sub.get("date"))
            if ts is not None:
                return ts
    return None


def count_recent_commits(commits, now: float, window_s: int = WINDOW_S) -> int:
    """Commits whose landing time is within the last `window_s`. We filter by
    date here (not just trusting the API `since=`) so the count is meaningful in
    the test and robust to clock skew. Undated commits are not counted."""
    cutoff = now - window_s
    return sum(
        1 for c in commits
        if (ts := commit_epoch(c)) is not None and cutoff <= ts <= now
    )


def count_open_prs(pulls) -> int:
    """Open pull requests — the /pulls list is already PRs only."""
    return sum(1 for p in pulls if isinstance(p, dict))


def count_open_issues(issues) -> int:
    """Open issues with PRs excluded. The /issues endpoint folds PRs in (each
    carries a `pull_request` key); dropping them keeps open_issues honest and
    disjoint from open_prs."""
    return sum(
        1 for i in issues
        if isinstance(i, dict) and "pull_request" not in i
    )


def github_stats(commits, pulls, issues, now: float,
                 window_s: int = WINDOW_S) -> tuple[int, int, int]:
    """The pure roll-up: (commits in window, open PRs, open issues)."""
    return (
        count_recent_commits(commits, now, window_s),
        count_open_prs(pulls),
        count_open_issues(issues),
    )


# --- GitHub fetch --------------------------------------------------------------

def resolve_token() -> str:
    """GITHUB_TOKEN if set, else `gh auth token`, else '' (anonymous).

    The gh fallback tries bare `gh` (PATH) then known absolute locations, because
    launchd runs with a minimal PATH that omits Homebrew's /opt/homebrew/bin."""
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if tok:
        return tok
    for gh in ("gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"):
        try:
            out = subprocess.run(
                [gh, "auth", "token"], capture_output=True, text=True, timeout=10
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip()
        except (FileNotFoundError, subprocess.SubprocessError):
            continue
    return ""


def fetch_json(url: str, token: str):
    """One GET against the GitHub API, parsed as JSON. Raises RuntimeError with a
    human cause on any failure so main() can bail without writing rows."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError(f"repo not found or no access (404): {url}") from e
        if e.code in (401, 403):
            raise RuntimeError(f"auth/rate-limit (HTTP {e.code}): {url}") from e
        raise RuntimeError(f"GitHub API HTTP {e.code}: {url}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"GitHub API unreachable: {e}") from e


def fetch_list(path: str, token: str, params: str = "") -> list:
    """Fetch a paginated list endpoint and concatenate the pages. Walks `page=`
    until a short page (or MAX_PAGES). Raises if the API returns a non-list."""
    items: list = []
    for page in range(1, MAX_PAGES + 1):
        sep = "&" if params else ""
        url = f"{API_BASE}{path}?per_page={PER_PAGE}{sep}{params}&page={page}"
        data = fetch_json(url, token)
        if not isinstance(data, list):
            raise RuntimeError(f"expected a list from {path}, got {type(data).__name__}")
        items.extend(data)
        if len(data) < PER_PAGE:
            break
    return items


def fetch_repo_activity(repo: str, token: str, now: float,
                        window_s: int = WINDOW_S) -> tuple[int, int, int]:
    """Hit the three endpoints for `owner/repo` and roll them up."""
    since = datetime.fromtimestamp(now - window_s, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    commits = fetch_list(f"/repos/{repo}/commits", token, params=f"since={since}")
    pulls = fetch_list(f"/repos/{repo}/pulls", token, params="state=open")
    issues = fetch_list(f"/repos/{repo}/issues", token, params="state=open")
    return github_stats(commits, pulls, issues, now, window_s)


# --- metrics.csv write (idempotent per source/metric/day) ----------------------

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

    repo = os.environ.get("MORPHY_REPO", "").strip()
    if not repo:
        # configured-off, not an error: no rows, clean exit.
        print("MORPHY_REPO not set — feed no-op (no rows written)")
        return 0
    if not re.fullmatch(r"[^/\s]+/[^/\s]+", repo):
        print(f"MORPHY_REPO must be 'owner/repo', got {repo!r}", file=sys.stderr)
        return 2

    now_dt = datetime.now(timezone.utc)
    try:
        commits_7d, open_prs, open_issues = fetch_repo_activity(
            repo, resolve_token(), now_dt.timestamp()
        )
    except Exception as e:  # noqa: BLE001 — log and bail without writing a row
        print(f"morphy github feed failed: {e}", file=sys.stderr)
        return 1

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    ts = day_bucket(now_dt)
    w1 = append_metric_row(csv, ts, SOURCE, METRIC_COMMITS, commits_7d)
    w2 = append_metric_row(csv, ts, SOURCE, METRIC_PRS, open_prs)
    w3 = append_metric_row(csv, ts, SOURCE, METRIC_ISSUES, open_issues)
    verb = "appended" if (w1 or w2 or w3) else "skipped (idempotent)"
    print(
        f"{verb} {SOURCE} ({repo}): {commits_7d} commits/7d, "
        f"{open_prs} open PRs, {open_issues} open issues at {ts}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
