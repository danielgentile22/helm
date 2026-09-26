"""One spoken sentence, from the transcript to the todo helm wrote, as a record on disk.

The dashboard owns nothing (ADR 0008), so a turn is a file under `~/.helm/voice/turns/`,
written atomically, and every route here reads or replaces that file. The file is the whole
state: a client that reloads mid run polls the id and picks the turn back up.

The phases are a table, not a set of flags. A turn goes heard to working, and working to
done, failed or cancelled. Nothing else, and never backwards, so a late thread cannot walk a
cancelled turn into failed.

The run itself is `claude -p` headless, the same shape as `runner/routines/integrity-check.sh`,
with the skill doing the thinking and this module doing the orchestration. The run is
restricted in its argv, not in prose: the permission mode is named so the user's global
bypassPermissions default does not apply, the allowed tools are the reads and the two todo
scripts, and the editing tools and any other shell are denied by name. One run at a time:
helm has one microphone, one pair of speakers and one vault to write into, so a second
sentence while the first is still working is refused rather than queued.
"""
from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
RUNNER = HERE.parents[1] / "runner"
sys.path[:0] = [str(HERE), str(RUNNER), str(RUNNER / "producers")]

import common  # noqa: E402
import launchd  # noqa: E402

TURNS_DIR = common.STATE / "voice" / "turns"

ID_PATTERN = r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{4}"

ACK = "On it"
NOT_HEARD = "I did not catch that"
TOO_LONG = "That took too long"
UNREADABLE = "I could not read what helm did"
CANCELLED = "Cancelled"

# The one injectable name for the run, the way `voice.VOICE_URL` is the one injectable name
# for the speech process.
CLAUDE_BIN = os.environ.get("HELM_CLAUDE_BIN", "claude")

# `default` rather than inheriting: Daniel runs Claude Code with bypassPermissions in his
# global settings, and a headless run under that mode may write, edit and run any shell. In
# `default` mode a headless run has nobody to ask, so a tool outside the allowlist is denied.
PERMISSION_MODE = "default"

ALLOWED_TOOLS = ("Read,Grep,Glob,"
                 "Bash(python3 runner/producers/todo_edit.py:*),"
                 "Bash(python3 runner/producers/capture.py:*)")

# Denied by name as well, so the restriction is visible in the argv a test can assert on.
# A denial wins over an allow, and `Bash(git:*)` keeps the run from committing to the vault
# by any route but the todo editor.
DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Bash(git:*)"

TIMEOUT_S = 90

SKILL = "voice-todo"

Phase = str

TRANSITIONS: dict[Phase, frozenset[Phase]] = {
    "heard": frozenset({"working"}),
    "working": frozenset({"done", "failed", "cancelled"}),
    "done": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}


class TurnError(Exception):
    """A turn asked for a phase the table does not allow from the one it is in."""


class Busy(TurnError):
    """A run asked for while another is in flight."""


@dataclass
class Turn:
    id: str
    transcript: str
    phase: Phase = "heard"
    ack: str = ACK
    confirmation: str | None = None
    actions: list[dict] = field(default_factory=list)
    model: str | None = None
    ms: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    def to(self, phase: Phase) -> None:
        if phase not in TRANSITIONS.get(self.phase, frozenset()):
            raise TurnError(f"a turn does not go from {self.phase} to {phase}")
        self.phase = phase

    def record(self) -> dict:
        return asdict(self)


def local_now() -> datetime:
    return datetime.now(common.local_tz(common.load_env()))


def path_for(turn_id: str) -> Path:
    return TURNS_DIR / f"{turn_id}.json"


def new_turn(transcript: str, stt_ms: int | None = None, phase: Phase = "heard") -> Turn:
    """A turn on disk before anything runs, so a client that asks for it a moment later finds
    it. `phase` is a birth phase and not a transition: a clip with nothing in it is born done
    and never runs."""
    now = local_now()
    turn = Turn(
        id=now.strftime("%Y-%m-%dT%H-%M-%S") + "-" + secrets.token_hex(2),
        transcript=transcript,
        phase=phase,
        ms={"stt": int(stt_ms)} if stt_ms is not None else {},
    )
    save(turn)
    return turn


def load(turn_id: str) -> Turn | None:
    payload = common.read_json(path_for(turn_id))
    if not isinstance(payload, dict):
        return None
    known = {f: payload[f] for f in Turn.__dataclass_fields__ if f in payload}
    try:
        return Turn(**known)
    except TypeError:
        return None


def save(turn: Turn) -> None:
    common.write_json(path_for(turn.id), turn.record())


def registry_entry() -> tuple[str, str]:
    """The model and effort for the skill, off `models.json` at the real helm root.

    `common.ENGINE` is redirected at a temp tree by the tests and by the fixture check, and the
    registry is a repo file rather than something either of them copies."""
    registry = launchd.read_registry(launchd.ENGINE)
    entry = (registry.get("skills") or {}).get(SKILL) or registry["defaults"]
    return entry["model"], entry["effort"]


def command(transcript: str, now: datetime) -> list[str]:
    """The headless argv. The skill reads the vault for itself; the prompt carries only the
    sentence and the clock, because a spoken "tomorrow" has no meaning without one."""
    model, effort = registry_entry()
    zone = getattr(now.tzinfo, "key", None) or now.tzname() or ""
    prompt = (f"/{SKILL}\n"
              f"now: {now.strftime('%Y-%m-%d %H:%M %A')} ({zone})\n"
              f"transcript: {transcript}")
    return [CLAUDE_BIN, "-p", prompt, "--model", model, "--effort", effort,
            "--permission-mode", PERMISSION_MODE,
            "--allowedTools", ALLOWED_TOOLS, "--disallowedTools", DISALLOWED_TOOLS]


@dataclass(frozen=True)
class Outcome:
    stdout: str
    stderr: str
    returncode: int
    ms: int
    timed_out: bool

    def tail(self, limit: int = 600) -> str:
        return (self.stdout + self.stderr).strip()[-limit:]


@dataclass(frozen=True)
class Result:
    confirmation: str
    actions: list[dict]


def kill_group(proc: subprocess.Popen) -> None:
    """End the run and everything it started. The process is its own session leader, so the
    group is the whole tree: `claude`, the todo editor it shelled out to, and the git commit
    inside that. Killing only the leader used to leave a commit in flight to land after the
    turn had already been reported cancelled."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass


def run_command(argv: list[str], timeout_s: float,
                register: Callable[[subprocess.Popen], None] | None = None) -> Outcome:
    """One headless run, to completion or to the timeout, whichever comes first.

    `register` is handed the process the moment it exists, which is how the in flight slot
    gets something to kill. Exported without it for `skills/voice-todo/check_fixture.py`,
    which runs the same command against a copy of the vault and has nothing to cancel.
    """
    env = dict(os.environ, HELM_NO_SESSION_NOTE="1")
    started = time.monotonic()
    proc = subprocess.Popen(argv, cwd=str(common.ENGINE), env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            start_new_session=True)
    if register is not None:
        register(proc)
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        kill_group(proc)
        stdout, stderr = proc.communicate()
    return Outcome(stdout, stderr, proc.returncode, round((time.monotonic() - started) * 1000), timed_out)


def parse_result(stdout: str) -> Result | None:
    """The JSON object on the last non-empty line, or None if it is not there or not the
    shape the skill promised. Everything above that line is the run thinking out loud."""
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        return None
    try:
        payload = json.loads(lines[-1])
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    confirmation = payload.get("confirmation")
    actions = payload.get("actions")
    if not isinstance(confirmation, str) or not isinstance(actions, list):
        return None
    for action in actions:
        if not isinstance(action, dict):
            return None
        if not all(isinstance(action.get(key), str) for key in ("op", "id", "dept", "row")):
            return None
    return Result(confirmation, actions)


@dataclass
class InFlight:
    turn_id: str
    # The vault's head when the run began, so a cancel can say which writes had already
    # landed: the killed process never printed its JSON, but the vault's log is the truth.
    vault_head: str | None = None
    started: float = 0.0
    proc: subprocess.Popen | None = None
    cancelled: bool = False


def vault_head() -> str | None:
    r = subprocess.run(["git", "-C", str(common.VAULT), "rev-parse", "HEAD"], capture_output=True, text=True)
    return r.stdout.strip() or None


def writes_since(head: str | None) -> list[str]:
    """The subjects of the vault commits made since `head`, oldest first. The todo editor
    names the todo in every subject, so this is what a cancel can report as written."""
    if head is None:
        return []
    r = subprocess.run(["git", "-C", str(common.VAULT), "log", "--reverse", "--format=%s", f"{head}..HEAD"],
                       capture_output=True, text=True)
    return [line for line in r.stdout.splitlines() if line.strip()]


_LOCK = threading.Lock()
_RUNNING: InFlight | None = None


def current() -> str | None:
    with _LOCK:
        return _RUNNING.turn_id if _RUNNING is not None else None


def busy() -> bool:
    return current() is not None


def cancel(turn_id: str) -> Turn | None:
    """Stop that turn if it is the one running, and hand back the record either way.

    A turn that already landed is answered as it is, so a second Escape, a retry and a lost
    response all converge. The running thread never writes after this claims the turn, so the
    cancelled record is the last word even when the process was mid sentence.
    """
    with _LOCK:
        inflight = _RUNNING
        mine = inflight is not None and inflight.turn_id == turn_id and not inflight.cancelled
        if mine and inflight is not None:
            inflight.cancelled = True
            proc = inflight.proc
    if not mine:
        return load(turn_id)
    if proc is not None:
        kill_group(proc)
        # Drained before the vault is read, so `writes_since` sees every commit the run
        # produced and the cancelled record agrees with the vault's history.
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
    turn = load(turn_id)
    if turn is None:
        return None
    if turn.phase == "working":
        turn.to("cancelled")
        turn.ms["run"] = round((time.monotonic() - inflight.started) * 1000)
        written = writes_since(inflight.vault_head)
        if written:
            # Never rolled back: the vault committed them, so the confirmation says so instead.
            count = f"{len(written)} write{'s' if len(written) > 1 else ''}"
            turn.confirmation = f"Cancelled, but {count} had already landed"
            turn.error = "; ".join(written)
            _refresh_todos()
        else:
            turn.confirmation = CANCELLED
        save(turn)
    return turn


def start(turn: Turn) -> None:
    """Move the turn to working, claim the one slot, and run it on a thread of its own."""
    global _RUNNING
    with _LOCK:
        if _RUNNING is not None:
            raise Busy(f"turn {_RUNNING.turn_id} is still working")
        turn.to("working")
        inflight = InFlight(turn.id, vault_head(), time.monotonic())
        _RUNNING = inflight
    save(turn)
    threading.Thread(target=_run, args=(turn, inflight), daemon=True, name=f"turn-{turn.id}").start()


def _register(inflight: InFlight, proc: subprocess.Popen) -> None:
    with _LOCK:
        inflight.proc = proc
        already = inflight.cancelled
    if already:
        # Cancel arrived between claiming the slot and spawning, so it had nothing to kill.
        kill_group(proc)


def _land(turn: Turn, outcome: Outcome, result: Result | None) -> None:
    turn.ms["run"] = outcome.ms
    if outcome.timed_out:
        turn.to("failed")
        turn.confirmation = TOO_LONG
        turn.error = f"killed after {outcome.ms} ms; {outcome.tail()}"
    elif outcome.returncode != 0:
        turn.to("failed")
        turn.confirmation = UNREADABLE
        turn.error = f"the run exited {outcome.returncode}; {outcome.tail()}"
    elif result is None:
        turn.to("failed")
        turn.confirmation = UNREADABLE
        turn.error = f"the last line of the run was not the JSON the skill promised; {outcome.tail()}"
    else:
        turn.to("done")
        turn.confirmation = result.confirmation
        turn.actions = result.actions


def _run(turn: Turn, inflight: InFlight) -> None:
    """The whole run, off the request thread. It never raises: anything unhandled is the turn
    failing with the reason on the record, because a thread that dies leaves a turn stuck in
    working forever."""
    global _RUNNING
    try:
        argv = command(turn.transcript, local_now())
        # Off the argv rather than a second read of the registry, so the record names the
        # model the run actually used.
        turn.model = argv[argv.index("--model") + 1]
        outcome = run_command(argv, TIMEOUT_S, register=lambda proc: _register(inflight, proc))
        result = parse_result(outcome.stdout)
        if result is not None and result.actions:
            _refresh_todos()
        _land(turn, outcome, result)
    except BaseException as e:  # noqa: BLE001  a dead thread would strand the turn in working
        if turn.phase == "working":
            turn.to("failed")
        turn.confirmation = turn.confirmation or UNREADABLE
        turn.error = f"{type(e).__name__}: {e}"
    finally:
        with _LOCK:
            landed = not inflight.cancelled
            if _RUNNING is inflight:
                _RUNNING = None
            if landed:
                save(turn)


def _refresh_todos() -> None:
    """Rerun the todos source so `agenda.json` already agrees when the client polls the turn.

    Imported here rather than at the top: `routes` imports `voice` imports this module, and
    the late import is also what lets the tests replace the name."""
    import routes

    try:
        routes.refresh_todos()
    except Exception as e:  # noqa: BLE001  the vault holds the truth, the merged file catches up
        print(f"turns: the todos re-merge failed after a turn ({type(e).__name__}: {e})", file=sys.stderr)
