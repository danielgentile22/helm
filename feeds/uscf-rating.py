#!/usr/bin/env python3
"""USCF rating feed for the HELM HUD Vitals panel.

Reads the current Regular rating from the (undocumented but stable) US Chess
ratings API and appends one row to the vault's metrics.csv:

    <iso-timestamp>,uscf,rating,<value>,ok,

  GET https://ratings-api.uschess.org/api/v1/members/{id}
  → {"ratings":[{"rating":1545,"ratingSystem":"R","floor":1300,...}, ...], ...}

The host is Cloudflare-fronted but the API itself answers a plain HTTPS GET as
long as we send an honest, non-default User-Agent (the ratings website's own JS
calls the same endpoint). No browser, no headless Chromium. Endpoint discovered
by Daniel's REDACTED-REPO project (~/Projects/REDACTED-REPO/uscf_client.py).

On any failure we log to stderr and exit non-zero WITHOUT writing a row, so the
tile keeps its last good value instead of flashing an error.

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT       vault folder (metrics.csv lives at system/metrics/)
  USCF_MEMBER_ID   8-digit member id
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://ratings-api.uschess.org/api/v1"
# Cloudflare fronts the API: identify honestly, never a default library UA.
USER_AGENT = "helm-uscf-feed/1.0 (+https://github.com/danielgentile22)"
TIMEOUT = 30.0


def load_home_env() -> None:
    """Mirror the runner/HUD loader: ~/.claude/.env, real env wins."""
    f = Path.home() / ".claude" / ".env"
    try:
        for line in f.read_text().splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip("\"'")
    except FileNotFoundError:
        pass


def fetch_regular_rating(member_id: str) -> int:
    """Return the member's Regular (ratingSystem 'R') rating as an int."""
    url = f"{API_BASE}/members/{member_id}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise RuntimeError(f"USCF has no member {member_id!r} (404)") from e
        raise RuntimeError(f"USCF API HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"USCF API unreachable: {e}") from e

    for r in data.get("ratings", []):
        if r.get("ratingSystem") == "R":
            if "rating" not in r:
                raise RuntimeError("member is Unrated in Regular")
            return int(r["rating"])
    raise RuntimeError("no Regular ('R') rating in API response")


def main() -> int:
    load_home_env()
    member_id = os.environ.get("USCF_MEMBER_ID", "").strip()
    vault = os.environ.get("VAULT_ROOT", "").strip()

    if not member_id:
        print("USCF_MEMBER_ID not set", file=sys.stderr)
        return 2
    if not vault:
        print("VAULT_ROOT not set", file=sys.stderr)
        return 2

    try:
        rating = fetch_regular_rating(member_id)
    except Exception as e:  # noqa: BLE001 — log and bail without writing a row
        print(f"uscf feed failed: {e}", file=sys.stderr)
        return 1

    csv = Path(vault) / "system" / "metrics" / "metrics.csv"
    csv.parent.mkdir(parents=True, exist_ok=True)
    if not csv.exists():
        csv.write_text("timestamp,source,metric,value,status,error\n")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with csv.open("a") as fh:
        fh.write(f"{ts},uscf,rating,{rating},ok,\n")
    print(f"appended uscf rating {rating} at {ts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
