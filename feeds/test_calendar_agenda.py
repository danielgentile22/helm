#!/usr/bin/env python3
"""Fixture sweep for the calendar-agenda feed (issue #56).

Asserts external behavior only: given canned Calendar API event resources and a
date/timezone, the feed produces exactly the contract JSON — never which client
method was called (the google client is never imported here). Failure-path cases
drive main() against a throwaway vault to prove non-zero exit and that a
pre-existing valid same-day cache survives a failure untouched.

Run: python3 feeds/test_calendar_agenda.py   (also wired into `npm test`)
"""
import importlib.util
import json
import tempfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "calendar_agenda", Path(__file__).with_name("calendar-agenda.py")
)
ca = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ca)

TZ = "America/New_York"
NOW_ISO = "2026-07-05T16:30:00Z"
DATE = "2026-07-05"

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


def timed(summary, start, end, location=""):
    return {"summary": summary, "location": location,
            "start": {"dateTime": start}, "end": {"dateTime": end}}


def allday(summary, date=DATE):
    return {"summary": summary, "start": {"date": date}, "end": {"date": "2026-07-06"}}


# --- timed events render in HUD tz, sorted by start ----------------------------
evs = ca.to_events([
    timed("Standup", "2026-07-05T09:00:00-04:00", "2026-07-05T09:30:00-04:00"),
    timed("Lunch", "2026-07-05T12:30:00-04:00", "2026-07-05T13:30:00-04:00", "Cafe"),
], TZ)
check("timed events render HH:MM in tz",
      evs[0] == {"time": "09:00", "end": "09:30", "item": "Standup", "allDay": False, "location": ""},
      got=evs[0])
check("location carried through", evs[1]["location"] == "Cafe", got=evs[1]["location"])

# --- ordering: all-day first, then timed by start ------------------------------
mixed = ca.to_events([
    timed("Afternoon sync", "2026-07-05T15:00:00-04:00", "2026-07-05T15:30:00-04:00"),
    allday("Conference"),
    timed("Morning review", "2026-07-05T08:00:00-04:00", "2026-07-05T08:15:00-04:00"),
], TZ)
check("all-day sorts first",
      mixed[0]["allDay"] is True and mixed[0]["time"] == "all-day" and mixed[0]["end"] == "",
      got=mixed[0])
check("timed events follow, sorted by start",
      [e["time"] for e in mixed[1:]] == ["08:00", "15:00"],
      got=[e["time"] for e in mixed[1:]])

# --- cross-timezone start: a UTC event renders in the HUD tz -------------------
cross = ca.to_events([timed("UTC noon call", "2026-07-05T12:00:00Z", "2026-07-05T13:00:00Z")], TZ)
check("UTC noon renders as 08:00 EDT", cross[0]["time"] == "08:00" and cross[0]["end"] == "09:00",
      got=(cross[0]["time"], cross[0]["end"]), want=("08:00", "09:00"))

# --- recurring instances arrive pre-expanded as ordinary timed items -----------
recur = ca.to_events([
    timed("Daily standup (instance)", "2026-07-05T09:00:00-04:00", "2026-07-05T09:15:00-04:00"),
    timed("Weekly 1:1 (instance)", "2026-07-05T14:00:00-04:00", "2026-07-05T14:30:00-04:00"),
], TZ)
check("recurring instances render and sort like any timed event",
      [e["time"] for e in recur] == ["09:00", "14:00"], got=[e["time"] for e in recur])

# --- empty day is a valid quiet day, not an error ------------------------------
check("empty day yields []", ca.to_events([], TZ) == [], got=ca.to_events([], TZ))

# --- malformed payloads are skipped, never fatal -------------------------------
bad = ca.to_events([
    {},                                                    # no start
    "not a dict",                                          # junk
    {"summary": "No start field"},                         # missing start
    {"start": {"dateTime": "garbage"}, "summary": "Bad"},  # unparseable start
    {"start": {}, "summary": "Empty start"},               # empty start dict
    timed("Survivor", "2026-07-05T10:00:00-04:00", "2026-07-05T10:30:00-04:00"),
], TZ)
check("malformed entries skipped, good one survives",
      len(bad) == 1 and bad[0]["item"] == "Survivor", got=bad)
check("missing summary falls back to (no title)",
      ca.to_events([timed("", "2026-07-05T11:00:00-04:00", "2026-07-05T11:30:00-04:00")], TZ)[0]["item"] == "(no title)")

# --- day_bounds spans the tz-local day (the recurring/tz-correct query window) -
lo, hi = ca.day_bounds(DATE, TZ)
check("day_bounds is [local-midnight, next-local-midnight) in tz",
      lo == "2026-07-05T00:00:00-04:00" and hi == "2026-07-06T00:00:00-04:00", got=(lo, hi))

# --- agenda_payload / failure_payload contract shape ---------------------------
payload = ca.agenda_payload([timed("X", "2026-07-05T09:00:00-04:00", "2026-07-05T09:30:00-04:00")],
                            DATE, TZ, NOW_ISO)
check("ok payload has the frozen keys",
      payload["ok"] is True and payload["date"] == DATE and payload["tz"] == TZ
      and payload["last_sync_ts"] == NOW_ISO and len(payload["events"]) == 1,
      got=payload)
fail = ca.failure_payload("auth: no stored token — run: x", DATE, TZ, NOW_ISO)
check("failure payload is ok:false with reason + empty events",
      fail["ok"] is False and fail["reason"].startswith("auth") and fail["events"] == [],
      got=fail)

# --- typed reasons: auth error names the re-auth command -----------------------
check("AuthError message points at the re-auth command",
      ca.REAUTH_CMD in str(ca.AuthError(f"no stored token — run: {ca.REAUTH_CMD}")))
check("_reason_for passes typed exceptions through, wraps unknown ones",
      ca._reason_for(ca.TransportError("network: down")) == "network: down"
      and ca._reason_for(ValueError("boom")) == "error: boom")

# --- has_valid_same_day_cache guards the don't-clobber rule --------------------
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "agenda.json"
    ca.write_agenda(p, ca.agenda_payload([], DATE, TZ, NOW_ISO))
    check("write_agenda round-trips + leaves no .tmp",
          json.loads(p.read_text())["date"] == DATE and not (Path(d) / "agenda.json.tmp").exists())
    check("valid same-day ok:true cache is recognized", ca.has_valid_same_day_cache(p, DATE))
    check("a different day is not a same-day cache", not ca.has_valid_same_day_cache(p, "2026-07-04"))
    ca.write_agenda(p, ca.failure_payload("network: down", DATE, TZ, NOW_ISO))
    check("an ok:false record is not a valid same-day cache", not ca.has_valid_same_day_cache(p, DATE))

# --- _store_token: atomic, private, leaves no .tmp (issue #24) ------------------
with tempfile.TemporaryDirectory() as d:
    import os as _os
    tok = Path(d) / "token.json"

    class _Creds:
        def to_json(self):
            return '{"token":"secret","refresh_token":"r"}'

    ca._store_token(tok, _Creds())
    check("_store_token writes the token + leaves no .tmp",
          json.loads(tok.read_text())["token"] == "secret" and not (Path(d) / "token.json.tmp").exists())
    check("_store_token file is 0o600", (_os.stat(tok).st_mode & 0o777) == 0o600,
          got=oct(_os.stat(tok).st_mode & 0o777))

# --- failure path end-to-end: non-zero exit, valid cache survives untouched ----
# No token exists in the temp home, so get_credentials fails (auth or deps — both
# typed). main must exit non-zero either way and MUST NOT touch a good cache.
with tempfile.TemporaryDirectory() as d:
    vault = Path(d) / "vault"
    home = Path(d) / "home"
    (home / ".claude").mkdir(parents=True)
    agenda = vault / "system" / "agenda.json"
    agenda.parent.mkdir(parents=True)

    import os
    env_snapshot = dict(os.environ)
    os.environ["VAULT_ROOT"] = str(vault)
    os.environ["HUD_TZ"] = TZ
    os.environ["HOME"] = str(home)  # ~/.claude/.env + token paths resolve here
    os.environ.pop("GCAL_TOKEN", None)
    os.environ.pop("GCAL_CLIENT_SECRET", None)
    try:
        # (a) no pre-existing cache → failure writes a typed ok:false, exit non-zero
        rc1 = ca.main([])
        written = json.loads(agenda.read_text())
        typed = any(written["reason"].startswith(p) for p in ("auth", "deps", "network", "error"))
        check("failure with no cache: non-zero exit + typed ok:false written",
              rc1 != 0 and written["ok"] is False and typed, got=(rc1, written.get("reason")))

        # (b) a pre-existing valid same-day cache survives a failure byte-for-byte
        # main() dates the cache from the real clock, so the fixture must too —
        # a frozen DATE here rots the moment the calendar day rolls over.
        from datetime import datetime
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo(TZ)).strftime("%Y-%m-%d")
        good = ca.agenda_payload(
            [timed("Keep me", f"{today}T09:00:00-04:00", f"{today}T09:30:00-04:00")],
            today, TZ, NOW_ISO)
        ca.write_agenda(agenda, good)
        before = agenda.read_bytes()
        rc2 = ca.main([])
        check("failure with a good same-day cache: non-zero exit + cache untouched",
              rc2 != 0 and agenda.read_bytes() == before, got=rc2)
    finally:
        os.environ.clear()
        os.environ.update(env_snapshot)

total = passed + failed
print(f"\nAll {total} cases pass." if failed == 0 else f"\n{failed}/{total} FAILED")
raise SystemExit(1 if failed else 0)
