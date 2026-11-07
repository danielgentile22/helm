#!/usr/bin/env python3
"""Alerts (ADR 0039): evaluate every condition the engine watches, and keep one file per alert.

    python3 runner/alerts.py          what every routine runs after writing its status

An alert is a condition, not a message. Each source below reads State or the vault and says
which conditions hold right now under its key prefix. `reconcile` turns that into files at
`~/.helm/alerts/<key>.json` (shape in docs/data-shapes.md): a new condition opens an alert, a
changed fingerprint reopens one, a cleared condition closes it, and a closed alert older than
a week is deleted. The same world evaluated twice writes nothing the second time.

| Source | Prefix | Tab |
|---|---|---|
| a routine's status result is not a pass | `routine:` | background |
| a routine has not run in twice its cadence | `quiet:` | background |
| a service is not loaded, not running, or (the dashboard) not answering | `service:` | background |
| the latest CI run on one of the owner's own pull requests failed | `ci:` | projects |
| an open idea's due date is today or past | `idea:` | ideas |

A paused routine never alerts. A source that raises leaves every alert under its prefix as
it was, so one broken source cannot close or open anything it did not see. An open alert
that is not dismissed and has never been pushed is pushed once; the due ideas of one
evaluation share one notification. A push that fails is logged and tried again next time.
Last, a failing job's alert starts a Claude session that fixes it, if turned on (ADR 0041).

No idea text reaches an alert: an idea's key is a hash of its id and its title is fixed.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import re
import sys
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator, Literal
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE / "producers"), str(HERE.parent / "dashboard" / "server")]

import background  # noqa: E402
import common  # noqa: E402
import idea_edit  # noqa: E402
import launchd  # noqa: E402
import machine  # noqa: E402
import push  # noqa: E402
import triage  # noqa: E402
from schedule import cadence_seconds, parse_schedule  # noqa: E402

Tab = Literal["projects", "ideas", "background", "devices"]
TABS: tuple[Tab, ...] = ("projects", "ideas", "background", "devices")
KEY = re.compile(r"^(routine|quiet|service|ci|idea):[A-Za-z0-9._#-]{1,120}$")
KEEP_CLOSED = timedelta(days=7)


def stamp(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_stamp(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


@dataclass(frozen=True)
class Alert:
    key: str
    tab: Tab
    title: str
    opened: str
    fingerprint: str
    pushed: str | None = None
    dismissed: str | None = None
    closed: str | None = None
    session: str | None = None

    @property
    def visible(self) -> bool:
        return self.closed is None and self.dismissed is None


@dataclass(frozen=True)
class Condition:
    key: str
    tab: Tab
    title: str
    fingerprint: str


@dataclass(frozen=True)
class Reading:
    """What one source saw. `held` keys are conditions it could not judge this time (a pull
    request whose CI is still running), left exactly as they are. `failed` holds them all."""
    prefix: str
    conditions: tuple[Condition, ...] = ()
    held: frozenset[str] = frozenset()
    failed: bool = False

    def owns(self, key: str) -> bool:
        return key.startswith(self.prefix)


def reconcile(existing: dict[str, Alert], readings: list[Reading], now: datetime) -> dict[str, Alert | None]:
    """The alerts that change, by key, and None for one to delete. Pure."""
    at = stamp(now)
    changes: dict[str, Alert | None] = {}
    for reading in readings:
        if reading.failed:
            continue
        seen = {c.key: c for c in reading.conditions}
        for key, c in seen.items():
            old = existing.get(key)
            if old is None or old.closed is not None or old.fingerprint != c.fingerprint:
                changes[key] = Alert(key, c.tab, c.title, at, c.fingerprint)
            elif (old.title, old.tab) != (c.title, c.tab):
                changes[key] = replace(old, title=c.title, tab=c.tab)
        for key, old in existing.items():
            if reading.owns(key) and key not in seen and key not in reading.held and old.closed is None:
                changes[key] = replace(old, closed=at)
    for key, old in existing.items():
        if key not in changes and old.closed is not None and now - parse_stamp(old.closed) > KEEP_CLOSED:
            changes[key] = None
    return changes


# --- The world the sources read -------------------------------------------------------------

@dataclass(frozen=True)
class World:
    registry: dict
    jobs: dict[str, machine.LaunchdJob]
    state: Path
    vault: Path
    now: datetime
    dashboard_up: Callable[[], bool]


def dashboard_up() -> bool:
    """The dashboard's own health route on loopback, the probe the integrity check uses."""
    sys.path.insert(0, str(common.ENGINE / "dashboard"))
    import serve
    return serve.is_otto("127.0.0.1", serve.DEFAULT_PORT)


def world() -> World:
    return World(json.loads((common.ENGINE / "models.json").read_text()), machine.launchctl_list(),
                 common.STATE, common.VAULT, datetime.now(common.local_tz(common.load_env())), dashboard_up)


def routine_status(w: World, name: str) -> tuple[bool, dict]:
    paused = (w.state / "disabled" / f"{launchd.PREFIX}{name}.plist").is_file()
    return paused, common.read_json(w.state / "status" / f"{name}.json") or {}


def safe_detail(text: str) -> str | None:
    """A status result short and plain enough for a notification title. A path or a second
    line would be a log line, which a push never carries."""
    text = re.sub(r"^failed:\s*", "", text.strip())
    return text if text and len(text) <= 60 and not re.search(r"[/\\\n~]", text) else None


def routine_failures(w: World) -> Reading:
    found = []
    for name in w.registry.get("routines") or {}:
        paused, status = routine_status(w, name)
        raw = status.get("result") if isinstance(status.get("result"), str) else None
        if background.result_of(raw, paused) != "fail":
            continue
        failures = status.get("failures")
        detail = (f"{failures} problem{'' if failures == 1 else 's'}"
                  if raw.strip().lower() == "fail" and isinstance(failures, int) and failures > 0
                  else None if raw.strip().lower() == "fail" else safe_detail(raw))
        fingerprint = detail or raw.strip()
        title = f"{name} failed" + (f": {detail}" if detail else "")
        found.append(Condition(f"routine:{name}", "background", title, fingerprint))
    return Reading("routine:", tuple(found))


def routines_quiet(w: World) -> Reading:
    """No run in twice the cadence. A routine that has never written a status is not judged:
    nothing says when it was installed."""
    found = []
    for name, spec in (w.registry.get("routines") or {}).items():
        paused, status = routine_status(w, name)
        last = background.stamp(status.get("last_run") or status.get("ran"))
        if paused or last is None:
            continue
        cadence = cadence_seconds(parse_schedule(str(spec.get("schedule") or "")))
        if w.now - datetime.fromisoformat(last) > timedelta(seconds=2 * cadence):
            found.append(Condition(f"quiet:{name}", "background", f"{name} has gone quiet", "quiet"))
    return Reading("quiet:", tuple(found))


def services_down(w: World) -> Reading:
    """Every service models.json names, and any other loaded `com.helm.*` job that is not a
    routine, the same set the Background tab lists."""
    routines = w.registry.get("routines") or {}
    listed = set(w.registry.get("services") or {})
    names = listed | {label[len(launchd.PREFIX):] for label in w.jobs
                      if label.startswith(launchd.PREFIX) and label[len(launchd.PREFIX):] not in routines}
    found = []
    for name in sorted(names):
        job = w.jobs.get(launchd.PREFIX + name)
        if job is None:
            what = "not loaded"
        elif job.pid is None:
            what = "not running"
        elif name == "dashboard" and not w.dashboard_up():
            what = "not answering"
        else:
            continue
        found.append(Condition(f"service:{name}", "background", f"{name} is down: {what}", what))
    return Reading("service:", tuple(found))


def ci_failing(w: World) -> Reading:
    """The owner's own open pull requests from capture's GitHub rows. A pull request that is
    no longer listed merged or closed, so its alert closes; one still running is held. While
    the GitHub source is failing its rows are old, so nothing is judged."""
    doc = common.read_json(w.state / "status" / "sources" / "github.json")
    if not doc or not (doc.get("meta") or {}).get("ok"):
        return Reading("ci:", failed=True)
    found, held = [], set()
    for row in doc.get("items") or []:
        repo = str(row.get("repo") or "").rsplit("/", 1)[-1]
        for pr in row.get("pull_requests") or []:
            if pr.get("author") != row.get("viewer"):
                continue
            key = f"ci:{repo}#{pr.get('number')}"
            if pr.get("ci") == "fail":
                found.append(Condition(key, "projects", f"CI fails on {repo}#{pr.get('number')}", "fail"))
            elif pr.get("ci") != "pass":
                held.add(key)
    return Reading("ci:", tuple(found), frozenset(held))


def idea_key(idea_id: str) -> str:
    return "idea:" + hashlib.sha256(idea_id.encode()).hexdigest()[:12]


def ideas_due(w: World) -> Reading:
    """The fingerprint is the due date, so moving it to another past day is news again."""
    ideas, _ = idea_edit.scan(w.vault)
    today = w.now.date().isoformat()
    found = tuple(Condition(idea_key(i.id), "ideas", "An idea is due", i.due) for i in ideas
                  if i.status == "open" and i.due is not None and i.due <= today)
    return Reading("idea:", found)


Source = Callable[[World], Reading]
SOURCES: dict[str, Source] = {
    "routine:": routine_failures,
    "quiet:": routines_quiet,
    "service:": services_down,
    "ci:": ci_failing,
    "idea:": ideas_due,
}


def read(w: World, sources: dict[str, Source]) -> list[Reading]:
    readings = []
    for prefix, source in sources.items():
        try:
            readings.append(source(w))
        except Exception as e:  # noqa: BLE001  one source down leaves the others standing
            # The type alone: an idea's message names its note, and the note's name is its title.
            sys.stderr.write(f"alerts: the {prefix.rstrip(':')} source failed ({type(e).__name__})\n")
            readings.append(Reading(prefix, failed=True))
    return readings


# --- The files ------------------------------------------------------------------------------

def folder() -> Path:
    return common.STATE / "alerts"


def path_of(key: str) -> Path:
    return folder() / f"{quote(key, safe='')}.json"


@contextmanager
def locked(name: str) -> Iterator[None]:
    """`files` around every read-modify-write of the alert files, so a dismiss is never lost
    under an evaluation's write; `evaluate` around a whole evaluation, so two routines ending
    together cannot both push the same alert."""
    folder().mkdir(parents=True, exist_ok=True)
    with (folder() / f".{name}.lock").open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_all() -> dict[str, Alert]:
    found = {}
    for path in sorted(folder().glob("*.json")) if folder().is_dir() else ():
        doc = common.read_json(path)
        try:
            alert = Alert(**doc)  # type: ignore[arg-type]
        except TypeError:
            sys.stderr.write(f"alerts: {path.name} is not an alert, left alone\n")
            continue
        found[alert.key] = alert
    return found


def write(changes: dict[str, Alert | None]) -> None:
    for key, alert in changes.items():
        if alert is None:
            path_of(key).unlink(missing_ok=True)
        else:
            common.write_json(path_of(key), asdict(alert))


def visible() -> list[Alert]:
    return sorted((a for a in load_all().values() if a.visible), key=lambda a: a.opened, reverse=True)


def counts(alerts: list[Alert]) -> dict[str, int]:
    return {tab: sum(a.tab == tab for a in alerts) for tab in TABS}


def dismiss(key: str, now: datetime) -> tuple[Alert, bool] | None:
    """Hide one alert until its fingerprint changes. None for a key with no file."""
    if not KEY.match(key):
        return None
    with locked("files"):
        alert = load_all().get(key)
        if alert is None:
            return None
        if alert.dismissed is not None or alert.closed is not None:
            return alert, False
        alert = replace(alert, dismissed=stamp(now))
        write({key: alert})
        return alert, True


# --- Pushing --------------------------------------------------------------------------------

Send = Callable[[str, str, int], object]


def notifications(alerts: list[Alert]) -> list[tuple[str, Tab, list[str]]]:
    """(title, tab, keys) per push: one per alert, and one for every due idea together."""
    due = [a.key for a in alerts if a.key.startswith("idea:")]
    out: list[tuple[str, Tab, list[str]]] = [(a.title, a.tab, [a.key]) for a in alerts
                                             if not a.key.startswith("idea:")]
    if due:
        out.append(("An idea is due" if len(due) == 1 else f"{len(due)} ideas are due", "ideas", due))
    return out


def push_pending(now: datetime, send: Send) -> list[str]:
    """Push every visible alert not pushed yet, then stamp the ones that went out. The send
    happens outside the files lock, so a dismiss is never kept waiting on the network."""
    with locked("files"):
        alerts = load_all()
    shown = [a for a in alerts.values() if a.visible]
    pushed: list[str] = []
    for title, tab, keys in notifications([a for a in shown if a.pushed is None]):
        try:
            send(title, tab, len(shown))
        except Exception as e:  # noqa: BLE001  a push that fails never fails the evaluation
            sys.stderr.write(f"alerts: push for {keys[0]} failed: {e}\n")
            continue
        pushed += keys
    with locked("files"):
        current = load_all()
        write({k: replace(current[k], pushed=stamp(now)) for k in pushed
               if k in current and current[k].fingerprint == alerts[k].fingerprint and current[k].pushed is None})
    return pushed


# --- Fix sessions ---------------------------------------------------------------------------

def start_pending(w: World, start: triage.Start) -> list[str]:
    """Give every failing job's alert a fix session (ADR 0041): reattach today's session for
    its key, or start one under the daily cap. Like a push, a start happens outside the files
    lock and one that fails never fails the evaluation. Returns the keys started."""
    if not triage.enabled():
        return []
    with locked("files"):
        alerts = load_all()
    day = triage.ledger_dir(w.now)
    decided = triage.plan(alerts.values(), triage.read_ledger(day))
    if decided.capped:
        sys.stderr.write(f"triage: {triage.DAILY_CAP} fix sessions a day is the cap, "
                         f"{len(decided.capped)} alert(s) wait for tomorrow\n")
    sessions = dict(decided.attach)
    for key in decided.start:
        alert = alerts[key]
        try:
            started = triage.launch(triage.request(w, alert, day), alert.fingerprint, stamp(w.now), start)
        except Exception as e:  # noqa: BLE001  a brief or a ledger that fails costs only this session
            sys.stderr.write(f"triage: no fix session for {key} ({type(e).__name__})\n")
            continue
        if started is not None:
            sessions[key] = started.session
    with locked("files"):
        current = load_all()
        write({k: replace(current[k], session=s) for k, s in sessions.items()
               if k in current and current[k].fingerprint == alerts[k].fingerprint and current[k].session is None})
    return [k for k in decided.start if k in sessions]


def evaluate(w: World, sources: dict[str, Source] = SOURCES, send: Send = push.send,
             start: triage.Start = triage.start) -> list[str]:
    """One full pass. Returns the keys pushed."""
    readings = read(w, sources)
    with locked("evaluate"):
        with locked("files"):
            write(reconcile(load_all(), readings, w.now))
        pushed = push_pending(w.now, send)
        start_pending(w, start)
        return pushed


def main() -> int:
    evaluate(world())
    return 0


if __name__ == "__main__":
    sys.exit(main())
