#!/usr/bin/env python3
"""Calendar-agenda feed for the HELM HUD (issue #56).

Replaces the headless `claude -p` session that used to reach Google Calendar
through the claude.ai MCP connector every 30 minutes. Fetching a day's events
into a fixed JSON schema needs no model — this is a deterministic HTTP call
authenticated directly to the Calendar API v3.

The runner spawns this on the same startup + AGENDA_SYNC_MIN cadence and reads
what it writes: <vault>/system/agenda.json, byte-shape identical to the old
contract the HUD, morning briefing and planner already consume:

    {"ok": true, "last_sync_ts": "<UTC ISO>", "date": "2026-07-05",
     "tz": "America/New_York",
     "events": [{"time":"09:00","end":"09:30","item":"...","allDay":false,"location":""}]}

All-day events use "time":"all-day", empty "end", "allDay":true, and sort first;
timed events sort by start. An empty events list with ok:true is a valid quiet
day. ok:false carries a typed `reason` (auth / network / deps) so staleness is
diagnosable from the runner log instead of masquerading as a valid sync.

Failure semantics: on error we NEVER overwrite a valid same-day ok:true cache
(a transient blip keeps the last good agenda); only when nothing usable exists
do we write a typed ok:false. Either way we exit non-zero and let the runner
decide — it keeps its own validate-then-fallback and timeout handling.

Auth: a one-time interactive bootstrap performs the OAuth consent and stores a
refresh token OUTSIDE the vault; normal runs refresh access tokens headless.

    python3 feeds/calendar-agenda.py --auth     # one-time consent (opens browser)
    python3 feeds/calendar-agenda.py            # headless sync

Config (read from ~/.claude/.env, overridable by real env vars):
  VAULT_ROOT          vault folder (agenda.json lives at system/)
  HUD_TZ              timezone events are rendered in (default America/New_York)
  GCAL_CLIENT_SECRET  Desktop OAuth client JSON (default ~/.claude/helm-gcal-client.json)
  GCAL_TOKEN          stored refresh token       (default ~/.claude/helm-gcal-token.json)

Setup: create a Desktop-app OAuth client in Google Cloud Console (Calendar API
enabled), download the client JSON to ~/.claude/helm-gcal-client.json, then run
the --auth bootstrap once. See README "Calendar agenda feed".

Google's official client libraries do the OAuth + REST — install once into the
same interpreter the runner spawns (the other feeds' /usr/local/bin/python3):
    python3 -m pip install google-auth google-auth-oauthlib google-api-python-client
They are imported lazily so the pure transform below stays importable (and this
file's tests stay dependency-free).
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from _metrics import load_home_env

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
REAUTH_CMD = "python3 feeds/calendar-agenda.py --auth"


# --- typed failures: each message IS the ok:false reason string ---------------
class AuthError(Exception):
    """OAuth grant missing / expired / not refreshable — needs --auth."""


class DepsError(Exception):
    """Google client libraries not installed."""


class TransportError(Exception):
    """Calendar API unreachable or returned an error."""


# --- pure transform (no network, no google deps; exercised by the test) -------

def _hhmm(iso: str, zone: ZoneInfo) -> str | None:
    """An RFC3339 dateTime -> "HH:MM" in `zone`, or None if unparseable.
    A naive timestamp (no offset) is assumed to already be in `zone`."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=zone)
    return dt.astimezone(zone).strftime("%H:%M")


def to_events(items, tz: str) -> list[dict]:
    """Calendar API event resources -> the HUD's event list.

    All-day events (start has `date`) become time:"all-day", end:"", allDay:true
    and sort first; timed events (start has `dateTime`) render their start/end in
    `tz` and sort by start. Malformed entries — no parseable start — are skipped
    rather than fatal, so one bad payload can't blank the whole agenda.
    """
    zone = ZoneInfo(tz)
    out: list[dict] = []
    for ev in items:
        if not isinstance(ev, dict):
            continue
        start = ev.get("start") or {}
        end = ev.get("end") or {}
        title = str(ev.get("summary") or "").strip() or "(no title)"
        loc = str(ev.get("location") or "").strip()
        if isinstance(start, dict) and start.get("dateTime"):
            t = _hhmm(start["dateTime"], zone)
            if t is None:
                continue  # unparseable start → skip
            out.append({
                "time": t,
                "end": _hhmm(end.get("dateTime", "") if isinstance(end, dict) else "", zone) or "",
                "item": title,
                "allDay": False,
                "location": loc,
            })
        elif isinstance(start, dict) and start.get("date"):
            out.append({"time": "all-day", "end": "", "item": title, "allDay": True, "location": loc})
        # else: no usable start → skip
    out.sort(key=lambda e: (0, "") if e["allDay"] else (1, e["time"]))
    return out


def agenda_payload(items, date_str: str, tz: str, now_iso: str) -> dict:
    return {"ok": True, "last_sync_ts": now_iso, "date": date_str, "tz": tz,
            "events": to_events(items, tz)}


def failure_payload(reason: str, date_str: str, tz: str, now_iso: str) -> dict:
    return {"ok": False, "reason": reason, "last_sync_ts": now_iso, "date": date_str,
            "tz": tz, "events": []}


def day_bounds(date_str: str, tz: str) -> tuple[str, str]:
    """RFC3339 [start, end) spanning the given day in `tz` — the API window."""
    zone = ZoneInfo(tz)
    start = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=zone)
    return start.isoformat(), (start + timedelta(days=1)).isoformat()


# --- cache I/O ----------------------------------------------------------------

def write_agenda(path: Path, payload: dict) -> None:
    """Atomic tmp+rename, indent-2 + trailing newline — matches the runner's
    writeJson byte-for-byte so the HUD never reads a torn file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)


def has_valid_same_day_cache(path: Path, date_str: str) -> bool:
    """True if a well-formed ok:true agenda for `date_str` already exists — we
    must not clobber it with a failure record on a transient error."""
    try:
        data = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    return bool(data.get("ok")) and data.get("date") == date_str and isinstance(data.get("events"), list)


# --- auth + fetch (lazy google imports) ---------------------------------------

def get_credentials(token_path: Path, client_path: Path):
    """Load stored creds, refreshing headless if needed. Raises AuthError when a
    browser consent is required (points at the re-auth command)."""
    try:
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
    except ImportError as e:
        raise DepsError(
            f"deps: google client not installed ({e}) — "
            "pip install google-auth google-auth-oauthlib google-api-python-client"
        ) from e

    if not token_path.exists():
        raise AuthError(f"auth: no stored token — run: {REAUTH_CMD}")
    try:
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    except ValueError as e:  # corrupt/torn token JSON → re-auth, not a raw parse error
        raise AuthError(f"auth: stored token unreadable ({e}) — run: {REAUTH_CMD}") from e
    if creds.valid:
        return creds
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError as e:
            raise AuthError(f"auth: token refresh failed ({e}) — run: {REAUTH_CMD}") from e
        _store_token(token_path, creds)
        return creds
    raise AuthError(f"auth: stored token invalid — run: {REAUTH_CMD}")


def fetch_events(creds, time_min: str, time_max: str, tz: str) -> list[dict]:
    """Today's primary-calendar events, recurrences expanded server-side."""
    try:
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
    except ImportError as e:
        raise DepsError(f"deps: googleapiclient not installed ({e})") from e
    try:
        service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        resp = (
            service.events()
            .list(calendarId="primary", timeMin=time_min, timeMax=time_max,
                  singleEvents=True, orderBy="startTime", timeZone=tz, maxResults=250)
            .execute()
        )
        return resp.get("items", [])
    except HttpError as e:
        raise TransportError(f"network: Calendar API HTTP {e.resp.status}") from e
    except OSError as e:  # DNS / connection / timeout
        raise TransportError(f"network: Calendar API unreachable ({e})") from e


def _store_token(token_path: Path, creds) -> None:
    """Atomic tmp+rename so a crash mid-refresh can't tear the token file — the
    previous valid token survives and the next run self-heals. tmp is created
    0o600 (mode arg is umask-masked, so chmod too) to keep the secret private."""
    token_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = token_path.with_name(token_path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(creds.to_json())
    try:
        os.chmod(tmp, 0o600)  # ponytail: best-effort; no-op on Windows
    except OSError:
        pass
    os.replace(tmp, token_path)


def bootstrap(token_path: Path, client_path: Path) -> int:
    """One-time interactive consent → persist a refresh token for headless runs."""
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError as e:
        print(f"google-auth-oauthlib not installed ({e}) — "
              "pip install google-auth google-auth-oauthlib google-api-python-client",
              file=sys.stderr)
        return 2
    if not client_path.exists():
        print(f"OAuth client secret not found at {client_path}. Create a Desktop-app "
              "OAuth client in Google Cloud Console (Calendar API enabled), download the "
              "JSON, and save it there.", file=sys.stderr)
        return 2
    flow = InstalledAppFlow.from_client_secrets_file(str(client_path), SCOPES)
    creds = flow.run_local_server(port=0)
    _store_token(token_path, creds)
    print(f"Saved Google Calendar refresh token to {token_path}. Headless syncs now "
          "run without a browser.")
    return 0


def _reason_for(exc: Exception) -> str:
    if isinstance(exc, (AuthError, DepsError, TransportError)):
        return str(exc)
    return f"error: {exc}"


def main(argv) -> int:
    load_home_env()
    home = Path.home() / ".claude"
    client_path = Path(os.environ.get("GCAL_CLIENT_SECRET", "").strip() or home / "helm-gcal-client.json")
    token_path = Path(os.environ.get("GCAL_TOKEN", "").strip() or home / "helm-gcal-token.json")

    if "--auth" in argv:
        return bootstrap(token_path, client_path)

    vault = os.environ.get("VAULT_ROOT", "").strip()
    if not vault:
        print("VAULT_ROOT not set", file=sys.stderr)
        return 2
    tz = os.environ.get("HUD_TZ", "").strip() or "America/New_York"

    agenda_path = Path(vault) / "system" / "agenda.json"
    date_str = datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d")
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    try:
        creds = get_credentials(token_path, client_path)
        time_min, time_max = day_bounds(date_str, tz)
        items = fetch_events(creds, time_min, time_max, tz)
    except Exception as e:  # noqa: BLE001 — classify into a typed reason, never crash-loop
        reason = _reason_for(e)
        if has_valid_same_day_cache(agenda_path, date_str):
            print(f"agenda sync failed: {reason} (kept last good cache)", file=sys.stderr)
        else:
            write_agenda(agenda_path, failure_payload(reason, date_str, tz, now_iso))
            print(f"agenda sync failed: {reason} (wrote ok:false)", file=sys.stderr)
        return 1

    write_agenda(agenda_path, agenda_payload(items, date_str, tz, now_iso))
    print(f"agenda sync ok: {len(items)} event(s) for {date_str} ({tz})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
