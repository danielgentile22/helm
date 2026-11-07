#!/usr/bin/env python3
"""Fix sessions (ADR 0041): a failing job starts a Claude session that diagnoses and fixes it.

    python3 runner/triage.py --brief routine:<name>    print the brief a session would get

After every evaluation pushes, `alerts.start_pending` hands the visible `routine:`, `quiet:`
and `service:` alerts to `plan`, which decides from the day's ledger what to start. Nothing
happens unless `~/.helm/triage/enabled` exists, so a test run or a temporary state folder
never starts a session.

The ledger is `~/.helm/triage/<local day>/`: per session the brief that was sent
(`<key>.md`), a claim (`<key>.json`, shape in docs/data-shapes.md) and, for a headless run,
its output (`<key>.log`). It is the only record of what started, so it sets both limits:
one session per key per day, and three a day in all. The claim is written before the
session starts and removed if the start fails, so a crash can only ever cost a session,
never start a second one.

A session starts as a T3 thread when T3 answers, and as a detached `claude -p` otherwise.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterable, Literal
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE / "producers"), str(HERE.parent / "dashboard" / "server")]

import background  # noqa: E402
import common  # noqa: E402
from launchd import PREFIX  # noqa: E402

if TYPE_CHECKING:
    from alerts import Alert, World

PREFIXES = ("routine:", "quiet:", "service:")
DAILY_CAP = 3
# A service or a schedule can blip: a restart, a reinstall, a Mac waking. Those alerts start a
# session only once they have held this long, which on capture's beat is the next evaluation.
SETTLE = {"quiet:": timedelta(minutes=5), "service:": timedelta(minutes=5)}
LOG_LINES = 80
LOG_READ_BYTES = 128 * 1024
T3_TIMEOUT_S = 60
GIT_TIMEOUT_S = 10
SLUGS = {"opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5", "fable": "claude-fable-5-1"}

Via = Literal["t3", "claude"]
Kind = Literal["routine", "service"]


# --- The decision ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Entry:
    """One ledger claim. `via` and `session` stay null while the session is starting."""
    key: str
    fingerprint: str
    started: str
    via: Via | None = None
    session: str | None = None


@dataclass(frozen=True)
class Plan:
    attach: dict[str, str]
    start: tuple[str, ...]
    capped: tuple[str, ...]


def plan(alerts: Iterable[Alert], ledger: dict[str, Entry], now: datetime, cap: int = DAILY_CAP) -> Plan:
    """What to do with each alert that has no session yet. An alert whose key already has a
    session today gets that one back: a changed fingerprint opens a fresh alert, and it is
    still the same broken job. A quiet or service alert younger than its settle time waits.
    Pure."""
    attach: dict[str, str] = {}
    start: list[str] = []
    capped: list[str] = []
    used = len(ledger)
    for a in sorted(alerts, key=lambda a: (a.opened, a.key)):
        if not a.visible or a.session is not None or not a.key.startswith(PREFIXES):
            continue
        settle = SETTLE.get(a.key.split(":", 1)[0] + ":")
        if settle and now - datetime.fromisoformat(a.opened.replace("Z", "+00:00")) < settle:
            continue
        entry = ledger.get(a.key)
        if entry is not None:
            if entry.session is not None:
                attach[a.key] = entry.session
        elif used >= cap:
            capped.append(a.key)
        else:
            start.append(a.key)
            used += 1
    return Plan(attach, tuple(start), tuple(capped))


# --- The ledger -----------------------------------------------------------------------------

def home() -> Path:
    return common.STATE / "triage"


def enabled() -> bool:
    return (home() / "enabled").is_file()


def ledger_dir(now: datetime) -> Path:
    """`now` is the evaluation's local time, so the day turns at local midnight."""
    return home() / now.date().isoformat()


def read_ledger(day: Path) -> dict[str, Entry]:
    found = {}
    for path in sorted(day.glob("*.json")) if day.is_dir() else ():
        try:
            entry = Entry(**(common.read_json(path) or {}))
        except TypeError:
            sys.stderr.write(f"triage: {path.name} is not a ledger entry, left alone\n")
            continue
        found[entry.key] = entry
    return found


@dataclass(frozen=True)
class Request:
    """What a starter gets. The brief is already on disk at `file('.md')` when it is called."""
    key: str
    title: str
    brief: str
    project: Path
    ledger: Path

    def file(self, suffix: str) -> Path:
        return self.ledger / f"{quote(self.key, safe='')}{suffix}"


@dataclass(frozen=True)
class Started:
    via: Via
    session: str


Start = Callable[[Request], Started]


def launch(request: Request, fingerprint: str, at: str, start: Start) -> Started | None:
    """Claim, start, record. A start that raises takes its claim back, so the next
    evaluation tries again; it never raises itself."""
    request.ledger.mkdir(parents=True, exist_ok=True)
    claim = Entry(request.key, fingerprint, at)
    request.file(".md").write_text(request.brief)
    common.write_json(request.file(".json"), asdict(claim))
    try:
        started = start(request)
    except Exception as e:  # noqa: BLE001  a start that fails never fails the evaluation
        for suffix in (".md", ".json", ".log"):
            request.file(suffix).unlink(missing_ok=True)
        sys.stderr.write(f"triage: no fix session for {request.key}: {e}\n")
        return None
    common.write_json(request.file(".json"), asdict(replace(claim, via=started.via, session=started.session)))
    return started


# --- The job behind an alert ----------------------------------------------------------------

@dataclass(frozen=True)
class Job:
    name: str
    kind: Kind
    spec: dict

    @property
    def label(self) -> str:
        return PREFIX + self.name

    @property
    def command(self) -> str | None:
        if self.kind == "routine":
            return f"runner/routines/{self.name}.sh"
        return " ".join(str(t) for t in self.spec.get("command") or []) or None


def job_of(registry: dict, key: str) -> Job:
    """`routine:` and `quiet:` name a routine, `service:` a service. A loaded service that
    models.json does not list has an empty spec."""
    prefix, name = key.split(":", 1)
    kind: Kind = "service" if prefix == "service" else "routine"
    return Job(name, kind, dict((registry.get(f"{kind}s") or {}).get(name) or {}))


def project_root(project: str | None, env: dict[str, str] | None = None) -> Path:
    """The checkout of the project that owns a job: `helm` is the engine, any other project
    is `<NAME>_ROOT` or `~/Projects/<name>`, and the engine when that folder is missing."""
    if not project or project == "helm":
        return common.ENGINE
    env = os.environ if env is None else env
    given = env.get(f"{project.upper().replace('-', '_')}_ROOT")
    path = Path(given).expanduser() if given else common.PROJECTS_DIR / project
    return path if path.is_dir() else common.ENGINE


# --- The brief ------------------------------------------------------------------------------

INSTRUCTIONS = """\
## What to do

Find the root cause. A guard that hides the failure is not a fix.

Follow the CLAUDE.md of each repo you change for how it tests and how it commits. Run the
tests it names before you commit.

Rerun the job to prove the fix: `launchctl kickstart -k gui/$(id -u)/{label}`, or run
`{command}` from the helm checkout. Then confirm that `{status}` reads a pass and that the
alert at `{alert}` has a `closed` time. `python3 runner/alerts.py` in the helm checkout
evaluates the alerts again.

{kind_note}

If the cause is outside software, such as a drive that is unplugged, a site that blocks
requests or a network that is down, do not hack around it. Say what the owner has to do.

Stop and wait for the owner before you delete any data, rewrite vault history, or touch a
credential. Do not start other fix sessions.

End with a short summary: what broke, why, what you changed (with commit hashes), and what
is left for the owner.
"""

KIND_NOTES = {
    "routine:": "The routine ran and reported a failure. Its status and logs above say how.",
    "quiet:": ("This routine has stopped running on its schedule. Find out why it stopped "
               "firing: whether launchd still holds it, whether it was paused, and whether "
               "its last run hung or exited before writing its status."),
    "service:": ("This service is down. Find out why: whether launchd holds it, why it "
                 "exited, and what its logs say about the last start."),
}


def short(path: Path) -> str:
    text, root = str(path), str(Path.home())
    return "~" + text[len(root):] if text == root or text.startswith(root + os.sep) else text


def tail(path: Path, lines: int = LOG_LINES) -> list[str] | None:
    if not path.is_file():
        return None
    with path.open("rb") as fh:
        size = fh.seek(0, 2)
        fh.seek(max(0, size - LOG_READ_BYTES))
        text = fh.read().decode("utf-8", errors="replace")
    found = text.splitlines()
    return (found[1:] if size > LOG_READ_BYTES else found)[-lines:]


def fenced(text: str, lang: str = "") -> str:
    fence = "````" if "```" in text else "```"
    return f"{fence}{lang}\n{text}\n{fence}"


def recent_commits(project: Path, since: str | None) -> list[str] | None:
    """Best effort: a checkout git cannot read leaves the section out."""
    argv = ["git", "-C", str(project), "log", "--oneline"]
    argv += [f"--since={since}", "-n", "20"] if since else ["-n", "10"]
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=GIT_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.splitlines() if r.returncode == 0 else None


def brief(w: World, alert: Alert, env: dict[str, str] | None = None) -> str:
    job = job_of(w.registry, alert.key)
    project = project_root(job.spec.get("project"), env)
    status_path = w.state / "status" / f"{job.name}.json"
    status_text = status_path.read_text().strip() if status_path.is_file() else None
    status = common.read_json(status_path) or {}
    launchd = w.jobs.get(job.label)
    alert_path = w.state / "alerts" / f"{quote(alert.key, safe='')}.json"

    out = [
        f"# Fix: {alert.title}",
        "",
        f"helm's alerts started this session automatically for the alert `{alert.key}`, "
        f"opened {alert.opened} with fingerprint `{alert.fingerprint}`. The owner is away. Work "
        "unattended and do not wait for answers, except where the steps below say to stop.",
        "",
        f"## What the {job.kind} normally does",
        "",
    ]
    facts = [("Does", job.spec.get("does")), ("Why", job.spec.get("why")), ("Writes", job.spec.get("writes"))]
    facts += [("Schedule", job.spec.get("schedule"))] if job.kind == "routine" else []
    facts += [
        ("Command" if job.kind == "service" else "Script", f"`{job.command}` in the helm checkout" if job.command else None),
        ("Owning project", f"{job.spec.get('project') or 'helm'}, checked out at `{short(project)}`"),
        ("helm checkout", f"`{short(common.ENGINE)}`"),
        ("launchd label", f"`{job.label}`"),
        ("launchctl", "not loaded" if launchd is None
         else f"pid {launchd.pid if launchd.pid is not None else 'none'}, "
              f"last exit {launchd.last_exit if launchd.last_exit is not None else 'none'}"),
    ]
    out += [f"- {name}: {value}" for name, value in facts if value]
    if not job.spec:
        out.append(f"- models.json does not list this {job.kind}; launchd holds it anyway.")

    out += ["", "## What happened", ""]
    if status_text is None:
        out.append(f"No status file at `{short(status_path)}`.")
    else:
        out += [f"The status file `{short(status_path)}`:", "", fenced(status_text, "json")]
        if status.get("report"):
            out += ["", f"It names a report. Read `{status['report']}` first."]

    out += ["", "## Logs", "",
            "Routines are silent on success, so these tails are the most recent failures. The "
            "files are append-only: check the times and do not chase what is already old."]
    for suffix in (".out", ".err"):
        path = w.state / "logs" / f"{job.label}{suffix}"
        lines = tail(path)
        out += ["", f"`{short(path)}`" + (", last lines:" if lines else (" is empty." if lines == [] else " does not exist."))]
        if lines:
            out += ["", fenced("\n".join(lines))]

    since = background.stamp(status.get("last_success"))
    commits = recent_commits(project, since)
    if commits is not None:
        where = f"`{short(project)}`"
        out += ["", "## Recent commits", ""]
        if not commits:
            out.append(f"No commits in {where} since the last success ({since})." if since
                       else f"{where} has no commits.")
        else:
            out += [f"In {where} since the last success ({since}):" if since
                    else f"The last commits in {where}; no success is on record:", "", fenced("\n".join(commits))]

    instructions = INSTRUCTIONS.format(
        label=job.label, command=job.command or job.label, status=short(status_path),
        alert=short(alert_path), kind_note=KIND_NOTES[alert.key.split(":", 1)[0] + ":"])
    # The template is wrapped for the source; each paragraph goes out as one line.
    out += ["", re.sub(r"(?<!\n)\n(?!\n)", " ", instructions.rstrip()), ""]
    return "\n".join(out)


def request(w: World, alert: Alert, ledger: Path) -> Request:
    project = project_root(job_of(w.registry, alert.key).spec.get("project"))
    return Request(alert.key, alert.title, brief(w, alert), project, ledger)


# --- The real starter -----------------------------------------------------------------------

def settings(registry: dict | None = None) -> tuple[str, str]:
    """Model and effort from `on_alert.triage` in models.json, held to its policy the way
    runner/jobs/claude.py holds a job's entry."""
    data = registry if registry is not None else json.loads((common.ENGINE / "models.json").read_text())
    entry, policy = data["on_alert"]["triage"], data.get("policy", {})
    model, effort = entry["model"], entry["effort"]
    if model in policy.get("forbidden_models", ()) or model not in SLUGS:
        raise ValueError(f"models.json: on_alert.triage names {model}, which the policy forbids")
    if effort in policy.get("forbidden_effort", ()):
        raise ValueError(f"models.json: on_alert.triage names effort {effort}, which the policy forbids")
    return model, effort


def thread_link(binary: str, project: Path, thread_id: object) -> str | None:
    """`thread start --json` answers with the id only; `thread list` carries the link."""
    if not isinstance(thread_id, str):
        return None
    try:
        r = subprocess.run([binary, "thread", "list", "--json", "--project", str(project)],
                           capture_output=True, text=True, timeout=T3_TIMEOUT_S)
        rows = json.loads(r.stdout) if r.returncode == 0 else []
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return next((t.get("link") for t in rows if isinstance(t, dict) and t.get("threadId") == thread_id), None)


def via_t3(request: Request, slug: str) -> Started | None:
    """A T3 thread in the owning project. None when T3 cannot take it. T3's command line has
    no effort flag, so a thread runs at the provider's default effort."""
    binary = os.environ.get("HELM_T3_BIN") or str(Path.home() / ".t3" / "bin" / "t3")
    argv = [binary, "thread", "start", "--json", "--provider", "claudeAgent", "--model", slug,
            "--title", f"Fix: {request.title}", str(request.project), "-"]
    try:
        r = subprocess.run(argv, input=request.brief, capture_output=True, text=True, timeout=T3_TIMEOUT_S)
        doc = json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError) as e:
        sys.stderr.write(f"triage: T3 is unavailable ({type(e).__name__})\n")
        return None
    session = (doc.get("link") or thread_link(binary, request.project, doc.get("threadId"))
               or doc.get("threadId")) if isinstance(doc, dict) else None
    if not isinstance(session, str) or not session:
        sys.stderr.write(f"triage: T3 is unavailable (exit {r.returncode})\n")
        return None
    return Started("t3", session)


def via_claude(request: Request, model: str, effort: str) -> Started:
    """A detached headless run, never waited on. Raises when it cannot spawn."""
    binary = os.environ.get("HELM_CLAUDE_BIN", "claude")
    log = request.file(".log")
    with request.file(".md").open("rb") as stdin, log.open("wb") as out:
        subprocess.Popen([binary, "-p", "--model", model, "--effort", effort, "--dangerously-skip-permissions"],
                         cwd=str(request.project), stdin=stdin, stdout=out, stderr=subprocess.STDOUT,
                         start_new_session=True, env=dict(os.environ, HELM_NO_SESSION_NOTE="1"))
    return Started("claude", short(log))


def start(request: Request) -> Started:
    model, effort = settings()
    return via_t3(request, SLUGS[model]) or via_claude(request, model, effort)


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "--brief" or not argv[1].startswith(PREFIXES):
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    import alerts
    w = alerts.world()
    key = argv[1]
    alert = alerts.load_all().get(key) or alerts.Alert(key, "background", f"{key.split(':', 1)[1]} failed",
                                                       alerts.stamp(w.now), "debug")
    sys.stdout.write(brief(w, alert))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
