#!/usr/bin/env python3
"""Claude usage feed for the HELM HUD Vitals panel.

Reads the SAME source Claude Code's /usage screen reads — the OAuth usage
endpoint — and appends its three utilization percentages to the vault's
metrics.csv:

    <hour-bucket-iso>,claude_code,pct_5h,<0-100>,ok,        (session)
    <hour-bucket-iso>,claude_code,pct_7d,<0-100>,ok,        (week, all models)
    <hour-bucket-iso>,claude_code,pct_7d_fable,<0-100>,ok,  (week, Fable)

This replaces the old transcript-summing estimate (rolling output-token total
vs. an "auto-calibrating" all-time peak), which had no idea what Anthropic's
real limit is and read 100% whenever the current window happened to be a
personal record. The endpoint returns the true percentages, so the tile now
matches /usage exactly.

Auth: Claude Code's own OAuth token — macOS keychain item
"Claude Code-credentials" (or ~/.claude/.credentials.json elsewhere). An
expired token just means a 401 → we skip the write and the tile goes stale;
Claude Code refreshes the token whenever it's used, so the next hourly run
heals. No reading is written on any failure — unlike a token COUNT, a percent
has no honest 0 fallback.

Idempotent per hour bucket, same as every other feed (metrics.csv reader keeps
the last 24 points → hourly cadence = rolling 24h sparkline).

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT   vault folder (metrics.csv lives at system/metrics/)
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from _metrics import append_metric_row, hour_bucket, load_home_env

SOURCE = "claude_code"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
KEYCHAIN_SERVICE = "Claude Code-credentials"


# --- compute step (pure; exercised by feeds/test_claude_tokens.py) -------------

def _pct(v) -> int | None:
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return None
    return max(0, min(100, round(v)))


def usage_pcts(payload) -> dict[str, int]:
    """OAuth usage payload -> {metric: percent} for the three /usage bars:
    pct_5h (session), pct_7d (weekly all models), pct_7d_fable (weekly scoped).
    Malformed blocks are simply absent — never a fake value."""
    if not isinstance(payload, dict):
        return {}
    out = {}
    for metric, block in (("pct_5h", payload.get("five_hour")),
                          ("pct_7d", payload.get("seven_day"))):
        p = _pct((block or {}).get("utilization") if isinstance(block, dict) else None)
        if p is not None:
            out[metric] = p
    # ponytail: hardcoded to the single scoped weekly limit the plan exposes
    # (Fable); go scope-aware if the endpoint ever returns more than one
    for lim in payload.get("limits") or []:
        if isinstance(lim, dict) and lim.get("kind") == "weekly_scoped":
            p = _pct(lim.get("percent"))
            if p is not None:
                out["pct_7d_fable"] = p
            break
    return out


# --- auth + fetch ---------------------------------------------------------------

def access_token() -> str | None:
    """Claude Code's OAuth access token: credentials file, else macOS keychain."""
    try:
        raw = (Path.home() / ".claude" / ".credentials.json").read_text()
    except OSError:
        try:
            raw = subprocess.run(
                ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                capture_output=True, text=True, timeout=10, check=True,
            ).stdout
        except (OSError, subprocess.SubprocessError):
            return None
    try:
        tok = json.loads(raw)["claudeAiOauth"]["accessToken"]
        return tok if isinstance(tok, str) and tok else None
    except (ValueError, KeyError, TypeError):
        return None


def fetch_usage(token: str) -> dict:
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)


def main() -> int:
    load_home_env()
    vault = os.environ.get("VAULT_ROOT", "").strip()
    if not vault:
        print("VAULT_ROOT not set", file=sys.stderr)
        return 2

    token = access_token()
    if not token:
        print("no Claude Code OAuth token (keychain / ~/.claude/.credentials.json)",
              file=sys.stderr)
        return 1

    try:
        pcts = usage_pcts(fetch_usage(token))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        print(f"usage endpoint failed: {e}", file=sys.stderr)
        return 1
    if not pcts:
        print("no utilization values in usage response", file=sys.stderr)
        return 1

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    ts = hour_bucket(datetime.now(timezone.utc))
    for metric, pct in pcts.items():
        wrote = append_metric_row(csv, ts, SOURCE, metric, pct)
        verb = "appended" if wrote else "skipped (idempotent)"
        print(f"{verb} {SOURCE}/{metric}={pct} at {ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
