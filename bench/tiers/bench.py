#!/usr/bin/env python3
"""Measure a three tier request ladder on this machine: Kev decides, a local model runs tier 2.

Every sentence in `fixture.json` goes to Kev's System One endpoint with two questions, which
tier should handle it and which menu action answers it. The tier 2 sentences also go through
the same headless `claude -p` run talk uses (its permission mode, allowed and denied tools come
from `dashboard/server/turns.py`, never copied), pointed at a local model through Ollama, against
a copy of `demo-vault/` made into its own git repo and reset between cases. Memory is sampled
every two seconds the whole time, with the speech server resident.

    python3 bench/tiers/bench.py                         the full grid, both Kev sizes by both local models
    python3 bench/tiers/bench.py --only 7                one case, 1-based, still the grid
    python3 bench/tiers/bench.py --kev 4b --local qwen   one cell
    python3 bench/tiers/bench.py --keep                  leave the vault copy on disk
    python3 bench/tiers/bench.py --skip-tier2            decisions and memory only
    python3 bench/tiers/bench.py --report <results.json> render the report again, no servers

The harness starts and stops the Kev and Ollama servers itself, in process groups of their
own, and never installs a launchd job. Results land in `<HELM_STATE>/bench/tiers/results/`.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, NamedTuple, Sequence, get_args

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parents[1]
FIXTURE = HERE / "fixture.json"
STATE = Path(os.environ.get("HELM_STATE") or Path.home() / ".helm") / "bench" / "tiers"

Tier = int
KEV = {"4b": "jaredpalmer/kev-4b", "9b": "jaredpalmer/kev-9b"}
LOCAL = {"qwen": "qwen3.6:35b-a3b", "gemma": "gemma4:26b"}

KEV_URL = "http://127.0.0.1:8009"
OLLAMA_URL = "http://127.0.0.1:11435"
VOICE_HEALTH = "http://127.0.0.1:3108/health"
KEV_READY_S = 900
OLLAMA_READY_S = 60
TIMEOUT_S = 180
SAMPLE_S = 2.0
MAX_TURNS = "12"
SANDBOX_TOOLS = frozenset({"Read", "Grep", "Glob", "Bash", "Skill"})
ESCALATE = {0: 2, 1: 2, 2: 3, 3: 3}
THRESHOLDS = tuple(round(i * 0.05, 2) for i in range(21))
READY_PROMPT = "Reply with the single word ready."
LIGHTHOUSE = "Write four sentences about a lighthouse."

TIERS: dict[str, tuple[Tier, dict[str, Any]]] = {
    "none": (0, {
        "what": "not a request at all: thanks, filler, a half sentence, nonsense, noise the microphone caught",
        "not_for": "anything that asks for a fact, an action or a change, however short",
        "examples": ["ok thanks", "um", "and then the"],
    }),
    "instant": (1, {
        "what": "one ready action from the menu: today's agenda, whether capture ran, when the backup ran, "
                "the newest routine report, or opening one named note",
        "not_for": "a question about what a note says, any change to a todo, anything that needs reading and answering",
        "examples": ["what is on my agenda", "open the Keel note", "did the backup run"],
    }),
    "local": (2, {
        "what": "read the notes vault to answer one question, or make one small todo change: "
                "add, tick, reschedule, reword, or a note on one todo",
        "not_for": "planning, drafting, research, several changes at once, anything outside the vault or needing a shell",
        "examples": ["what did I say about the aisle seat", "I finished the training module", "push the flights to Friday"],
    }),
    "cloud": (3, {
        "what": "planning, drafting, research, multi step work, several edits, anything outside the vault or needing a shell",
        "not_for": "a single fact from the vault or a single todo change",
        "examples": ["plan my week", "write a cover note for the launch", "find out why the importer is slow"],
    }),
}
TIER_KEY = {n: key for key, (n, _) in TIERS.items()}
TIER_INSTRUCTIONS = "Which tier should handle this spoken request? When two fit, pick the higher one."
ACTION_INSTRUCTIONS = "Which menu action answers this request by itself? none when no single action does."

MENU_FIXED = {
    "agenda": "show today's agenda: the todos and events due today",
    "capture_health": "say whether the capture sources ran and whether any failed",
    "backup_status": "say when the backup last ran",
    "latest_report": "open the newest routine report in the inbox",
}
MENU_NONE = "not one of these actions"

Failure = Literal["malformed_tool", "invented_tool", "wrong_edit", "wrong_answer",
                  "wrote_when_read", "timeout", "gave_up"]
Grade = Literal["pass"] | Failure
FAILURES: tuple[Failure, ...] = get_args(Failure)


@dataclass(frozen=True)
class Case:
    n: int
    say: str
    tier: Tier
    action: str | None
    ambiguous: bool
    answer_has: tuple[str, ...]
    diff_has: tuple[str, ...]
    dept: str | None


@dataclass(frozen=True)
class Decision:
    tier: str
    tier_probs: dict[str, float]
    tier_confidence: float
    action: str
    action_probs: dict[str, float]
    action_confidence: float
    ms: int


@dataclass(frozen=True)
class Run:
    ms: int
    said: str
    tools: tuple[str, ...]
    denied: int
    timed_out: bool
    subtype: str
    commits: int
    changed: tuple[str, ...]


@dataclass(frozen=True)
class Sample:
    t: float
    mem_mb: dict[str, int]
    free_pct: int
    swap_mb: int


@dataclass(frozen=True)
class Latency:
    cold_ms: int
    load_ms: int
    warm_ms: int
    tok_s: float


@dataclass
class Cell:
    kev: str
    local: str
    decisions: dict[int, Decision] = field(default_factory=dict)
    runs: dict[int, Run] = field(default_factory=dict)
    grades: dict[int, Grade] = field(default_factory=dict)
    samples: list[Sample] = field(default_factory=list)
    latency: Latency | None = None
    tier2_blocked: str | None = None
    stderr_tail: str = ""


class Point(NamedTuple):
    n: int
    label: Tier
    decided: Tier
    confidence: float


def load_cases(path: Path = FIXTURE) -> list[Case]:
    """The fixture as cases, refusing one that breaks the contract at its top."""
    cases = []
    for n, raw in enumerate(json.loads(path.read_text())["cases"], 1):
        case = Case(n=n, say=raw["say"], tier=raw["tier"], action=raw.get("action"),
                    ambiguous=bool(raw.get("ambiguous", False)),
                    answer_has=tuple(raw.get("answer_has", ())), diff_has=tuple(raw.get("diff_has", ())),
                    dept=raw.get("dept"))
        if case.tier not in TIER_KEY:
            raise ValueError(f"case {n}: tier {case.tier} is not 0 to 3")
        if (case.tier == 1) != (case.action is not None):
            raise ValueError(f"case {n}: an action belongs on tier 1 cases and only there")
        if (case.tier == 2) != (bool(case.answer_has) + bool(case.diff_has) == 1):
            raise ValueError(f"case {n}: tier 2 cases take answer_has or diff_has, one of them, and no other tier does")
        if bool(case.diff_has) != (case.dept is not None):
            raise ValueError(f"case {n}: dept goes with diff_has and only with it")
        if any(s != s.lower() for s in case.answer_has + case.diff_has):
            raise ValueError(f"case {n}: answer_has and diff_has are lowercase")
        cases.append(case)
    return cases


def build_menu(vault: Path) -> dict[str, str]:
    """The tier 1 allowlist. Code could perform every entry; Kev only names one."""
    notes = sorted(p.stem for p in (vault / "Atlas").rglob("*.md"))
    return {**MENU_FIXED, **{f"note:{t}": f"open the note titled {t}" for t in notes}, "none": MENU_NONE}


def effective(decided: Tier, confidence: float, threshold: float) -> Tier:
    """A doubtful decision climbs the ladder. Instant is the one tier that acts without reading,
    so it is reached only by a confident decision: a doubtful none climbs past it to local."""
    return decided if confidence >= threshold else ESCALATE[decided]


def unsafe(label: Tier, effective: Tier) -> bool:
    return effective == 1 if label == 0 else effective < label


def unsafe_at(points: Sequence[Point], threshold: float) -> list[int]:
    return [p.n for p in points if unsafe(p.label, effective(p.decided, p.confidence, threshold))]


def pick_threshold(points: Sequence[Point]) -> float | None:
    """The lowest candidate at which no case lands below its label, or None if even 1.00 leaves one."""
    return next((t for t in THRESHOLDS if not unsafe_at(points, t)), None)


def ladder(points: Sequence[Point], threshold: float) -> dict[str, Any]:
    eff = {p.n: effective(p.decided, p.confidence, threshold) for p in points}
    confusion = {f"{label}>{e}": sum(1 for p in points if p.label == label and eff[p.n] == e)
                 for label in TIER_KEY for e in TIER_KEY}
    per_tier = {}
    for label in TIER_KEY:
        mine = [p for p in points if p.label == label]
        per_tier[TIER_KEY[label]] = round(sum(eff[p.n] == label for p in mine) / len(mine), 3) if mine else None
    return {
        "threshold": threshold,
        "accuracy": round(sum(eff[p.n] == p.label for p in points) / len(points), 3) if points else 0.0,
        "per_tier": per_tier,
        "confusion": confusion,
        "cloud_share": round(sum(e == 3 for e in eff.values()) / len(points), 3) if points else 0.0,
        "unsafe": unsafe_at(points, threshold),
    }


def decided_tier(d: Decision) -> Tier:
    """An unknown tier key is treated as cloud, the one reading that can never be unsafe. An
    instant decision with no menu action has nothing for code to perform, so it is local."""
    if d.tier not in TIERS:
        return 3
    tier = TIERS[d.tier][0]
    if tier == 1 and d.action in ("", "none"):
        return 2
    return tier


def ask_kev(base_url: str, state: str, questions: dict) -> dict:
    body = json.dumps({"state": state, "model": "kev-latest", "questions": questions}).encode()
    req = urllib.request.Request(f"{base_url}/v1/systemone", data=body,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def kev_questions(menu: dict[str, str]) -> dict:
    return {
        "tier": {"type": "choice", "instructions": TIER_INSTRUCTIONS,
                 "criteria": {key: criteria for key, (_, criteria) in TIERS.items()}},
        "action": {"type": "choice", "instructions": ACTION_INSTRUCTIONS, "criteria": menu},
    }


def decide(say: str, menu: dict[str, str], base_url: str = KEV_URL) -> Decision:
    """One Kev call answering both questions. A key outside the table or the menu comes back
    as "", so a model error can never become an action."""
    started = time.monotonic()
    body = ask_kev(base_url, f"Spoken to a personal assistant: {say}", kev_questions(menu))
    ms = round((time.monotonic() - started) * 1000)
    answers = body.get("answers") or {}
    tier, action = answers.get("tier") or {}, answers.get("action") or {}
    return Decision(
        tier=tier.get("choice") if tier.get("choice") in TIERS else "",
        tier_probs=dict(tier.get("probabilities") or {}),
        tier_confidence=float(tier.get("confidence") or 0.0),
        action=action.get("choice") if action.get("choice") in menu else "",
        action_probs=dict(action.get("probabilities") or {}),
        action_confidence=float(action.get("confidence") or 0.0),
        ms=ms,
    )


def tier2_prompt(say: str, vault: Path, now: datetime) -> str:
    zone = getattr(now.tzinfo, "key", None) or now.tzname() or ""
    return (f"You are helm, a personal assistant with a notes vault at {vault}.\n"
            f"now: {now.strftime('%Y-%m-%d %H:%M %A')} ({zone})\n"
            "Answer from the vault, or make exactly one todo change. Todos and their ids:\n"
            "python3 runner/producers/capture.py --only todos --print. Todo changes:\n"
            "python3 runner/producers/todo_edit.py add|tick|edit|note (see --help). Read only what you\n"
            "need. Never edit files directly. Reply in one or two sentences a speaker can read aloud.\n"
            f"request: {say}")


def tier2_argv(turns: Any, prompt: str, local: str) -> list[str]:
    """Talk's sandbox, off `turns` itself so the two cannot drift. No `--effort`: a local
    backend has none."""
    return [turns.CLAUDE_BIN, "-p", prompt, "--model", LOCAL[local],
            "--permission-mode", turns.PERMISSION_MODE,
            "--allowedTools", turns.ALLOWED_TOOLS, "--disallowedTools", turns.DISALLOWED_TOOLS,
            "--output-format", "stream-json", "--verbose", "--max-turns", MAX_TURNS]


def tier2_env(local: str, state: Path) -> dict[str, str]:
    """The process environment with the Anthropic endpoint swapped for Ollama. `HELM_STATE`
    goes to a scratch folder too, because the todo editor re-merges the agenda after a write
    and the demo vault's todos must never land in the owner's dashboard."""
    model = LOCAL[local]
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    env.update(ANTHROPIC_BASE_URL=OLLAMA_URL, ANTHROPIC_AUTH_TOKEN="ollama",
               CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",
               ANTHROPIC_DEFAULT_HAIKU_MODEL=model, ANTHROPIC_DEFAULT_SONNET_MODEL=model,
               ANTHROPIC_DEFAULT_OPUS_MODEL=model, HELM_NO_SESSION_NOTE="1", HELM_STATE=str(state))
    return env


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(_text(c.get("text", "")) for c in content if isinstance(c, dict))
    return ""


def parse_stream(stdout: str, *, ms: int, timed_out: bool, commits: int = 0,
                 changed: tuple[str, ...] = ()) -> Run:
    """A stream-json transcript as a Run. A line that is not a JSON object is skipped."""
    tools: list[str] = []
    denied = 0
    said, subtype = "", ""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "result":
            said, subtype = str(event.get("result") or ""), str(event.get("subtype") or "")
            continue
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if kind == "assistant" and block.get("type") == "tool_use":
                tools.append(str(block.get("name", "")))
            elif kind == "user" and block.get("type") == "tool_result" and block.get("is_error"):
                text = _text(block.get("content")).lower()
                denied += "permission" in text or "not allowed" in text
    return Run(ms=ms, said=said, tools=tuple(tools), denied=denied, timed_out=timed_out,
               subtype=subtype, commits=commits, changed=changed)


def dept_note(dept: str) -> str:
    return f"Atlas/{dept}/{dept}.md"


def added_lines(diff: str) -> str:
    return "\n".join(line[1:] for line in diff.splitlines()
                     if line.startswith("+") and not line.startswith("+++"))


def grade(case: Case, run: Run, diff: str) -> Grade:
    """First match wins, in the order the failures are worth knowing about. `diff_has` is
    matched against the added lines only, so a context line cannot pass an edit."""
    if case.diff_has:
        added = added_lines(diff).lower()
        met = (run.commits == 1 and run.changed == (dept_note(case.dept or ""),)
               and all(s in added for s in case.diff_has))
    else:
        met = run.commits == 0 and all(s in run.said.lower() for s in case.answer_has)
    if run.timed_out:
        return "timeout"
    if any(t not in SANDBOX_TOOLS for t in run.tools):
        return "invented_tool"
    if run.denied > 0 and not met:
        return "malformed_tool"
    if met:
        return "pass"
    if not case.diff_has:
        if run.commits > 0:
            return "wrote_when_read"
        if not run.said.strip() or run.subtype != "success":
            return "gave_up"
        return "wrong_answer"
    return "gave_up" if run.commits == 0 else "wrong_edit"


def ensure_temporary(path: Path) -> None:
    if not Path(path).resolve().is_relative_to(Path(tempfile.gettempdir()).resolve()):
        raise SystemExit(f"refusing to run: {path} is not a temporary copy")


def git(vault: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(vault), *argv], check=True, capture_output=True, text=True).stdout


def copy_vault() -> tuple[Path, Path, str]:
    root = Path(tempfile.mkdtemp(prefix="tier-bench-"))
    vault = root / "Vault"
    shutil.copytree(ENGINE / "demo-vault", vault, symlinks=True)
    git(vault, "init", "-q", "-b", "main")
    git(vault, "add", "-A")
    git(vault, "-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "-qm", "demo vault")
    return root, vault, git(vault, "rev-parse", "HEAD").strip()


def restore(vault: Path, base: str) -> None:
    git(vault, "reset", "-q", "--hard", base)
    git(vault, "clean", "-fdq")


def vault_facts(vault: Path, base: str) -> tuple[int, tuple[str, ...], str]:
    commits = int(git(vault, "rev-list", "--count", f"{base}..HEAD").strip() or 0)
    changed = tuple(line for line in git(vault, "diff", "--name-only", base, "HEAD").splitlines() if line)
    return commits, changed, git(vault, "diff", base, "HEAD")


def http_json(url: str, payload: dict | None = None, timeout: float = 5) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def answers(url: str) -> bool:
    try:
        http_json(url, timeout=2)
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def launch(name: str, argv: list[str], cwd: Path, env: dict[str, str], probe: str, deadline_s: float) -> subprocess.Popen:
    """Start a server in its own session and wait for its probe. Refuses when something
    already answers there, since the numbers would then belong to a process the harness
    did not start."""
    if answers(probe):
        raise SystemExit(f"something already answers {probe}; stop it before benchmarking")
    log = STATE / "logs" / f"{name}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("ab") as out:
        proc = subprocess.Popen(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=out,
                                stderr=subprocess.STDOUT, start_new_session=True)
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        if proc.poll() is not None:
            raise SystemExit(f"{name} exited {proc.returncode} before it was ready; see {log}")
        if answers(probe):
            return proc
        time.sleep(2)
    stop(proc)
    raise SystemExit(f"{name} was not ready after {deadline_s:.0f}s; see {log}")


def stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    except ProcessLookupError:
        pass


def start_kev(size: str) -> subprocess.Popen:
    env = dict(os.environ, HF_HOME=str(STATE / "hf"))
    argv = ["uv", "run", "--extra", "serve", "python", "-m", "kev.serve", "--run", KEV[size], "--port", "8009"]
    return launch(f"kev-{size}", argv, STATE / "kev", env, f"{KEV_URL}/v1/models", KEV_READY_S)


def start_ollama() -> subprocess.Popen:
    env = dict(os.environ, OLLAMA_HOST="127.0.0.1:11435", OLLAMA_MODELS=str(STATE / "ollama"),
               OLLAMA_CONTEXT_LENGTH="32768")
    return launch("ollama", ["ollama", "serve"], STATE, env, f"{OLLAMA_URL}/api/version", OLLAMA_READY_S)


def measure_latency(model: str) -> Latency:
    """Cold, then warm, straight against Ollama. The model is left resident for the cell."""
    gen = f"{OLLAMA_URL}/api/generate"
    http_json(gen, {"model": model, "keep_alive": 0, "prompt": "hi", "stream": False}, timeout=600)
    cold = http_json(gen, {"model": model, "keep_alive": "2h", "prompt": LIGHTHOUSE, "stream": False}, timeout=600)
    warm = http_json(gen, {"model": model, "keep_alive": "2h", "prompt": LIGHTHOUSE, "stream": False}, timeout=600)
    return Latency(cold_ms=round(cold["total_duration"] / 1e6), load_ms=round(cold["load_duration"] / 1e6),
                   warm_ms=round(warm["total_duration"] / 1e6),
                   tok_s=round(warm["eval_count"] / (warm["eval_duration"] / 1e9), 1))


class Proc(NamedTuple):
    pid: int
    ppid: int
    rss_mb: int
    command: str


def ps_rows() -> list[Proc]:
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) >= 3 and all(p.isdigit() for p in parts[:3]):
            rows.append(Proc(int(parts[0]), int(parts[1]), int(parts[2]) // 1024, parts[3] if len(parts) > 3 else ""))
    return rows


def tree(rows: Sequence[Proc], roots: set[int]) -> set[int]:
    """The roots and every descendant: `uv` and the Kev python under it, `ollama serve` and
    the llama-server that holds the model."""
    children: dict[int, list[int]] = {}
    for proc in rows:
        children.setdefault(proc.ppid, []).append(proc.pid)
    seen: set[int] = set()
    todo = list(roots)
    while todo:
        pid = todo.pop()
        if pid not in seen:
            seen.add(pid)
            todo.extend(children.get(pid, ()))
    return seen


FOOTPRINT = re.compile(r"Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)")
UNIT_MB = {"B": 1 / 2**20, "KB": 1 / 1024, "MB": 1, "GB": 1024}


def parse_footprint(text: str) -> int:
    m = FOOTPRINT.search(text)
    return round(float(m.group(1)) * UNIT_MB[m.group(2)]) if m else 0


def footprint_mb(pid: int) -> int:
    try:
        out = subprocess.run(["/usr/bin/footprint", "-p", str(pid)], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return 0
    return parse_footprint(out.stdout)


def swap_used_mb(text: str) -> int:
    m = re.search(r"used\s*=\s*([\d.]+)([MG])", text)
    if not m:
        return 0
    return round(float(m.group(1)) * (1024 if m.group(2) == "G" else 1))


def sysctl(name: str) -> str:
    return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True).stdout.strip()


def process_mb(proc: Proc) -> int:
    """The larger of RSS and `footprint`, because each misses one kind of model memory. RSS
    leaves out the Metal buffers MLX holds Kev's weights in (a 9B read as a third of its size),
    and footprint leaves out the clean file pages llama-server maps Ollama's weights from (a
    22 GB model read as 2 GB)."""
    return max(proc.rss_mb, footprint_mb(proc.pid))


def take_sample(leaders: dict[str, int]) -> Sample:
    rows = ps_rows()
    by_pid = {proc.pid: proc for proc in rows}
    roots = {name: {pid} for name, pid in leaders.items()}
    roots["voice"] = {proc.pid for proc in rows if "voice/server.py" in proc.command}
    level = sysctl("kern.memorystatus_level")
    return Sample(t=time.time(),
                  mem_mb={name: sum(process_mb(by_pid[pid]) for pid in tree(rows, pids) if pid in by_pid)
                          for name, pids in roots.items()},
                  free_pct=int(level) if level.isdigit() else -1, swap_mb=swap_used_mb(sysctl("vm.swapusage")))


class Sampler:
    """Every two seconds on a daemon thread until stopped, into `samples`. Two, not one,
    because `footprint` takes a moment per process."""

    def __init__(self, leaders: dict[str, int]) -> None:
        self.leaders = leaders
        self.samples: list[Sample] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="memory-sampler")
        self._thread.start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.samples.append(take_sample(self.leaders))
            except (OSError, ValueError):
                pass
            self._stop.wait(SAMPLE_S)

    def stop(self) -> list[Sample]:
        self._stop.set()
        self._thread.join(timeout=5)
        return self.samples


def memory(samples: Sequence[Sample]) -> dict[str, int | None]:
    if not samples:
        return {"kev": None, "ollama": None, "voice": None, "sum": None, "min_free_pct": None, "swap_mb": None}
    peak = {name: max(s.mem_mb.get(name, 0) for s in samples) for name in ("kev", "ollama", "voice")}
    return {**peak, "sum": max(sum(s.mem_mb.values()) for s in samples),
            "min_free_pct": min(s.free_pct for s in samples), "swap_mb": max(s.swap_mb for s in samples)}


def percentile(values: Sequence[int], p: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p * len(ordered)) - 1)]


def summarize(cell: Cell, cases: Sequence[Case]) -> dict[str, Any]:
    points = [Point(c.n, c.tier, decided_tier(cell.decisions[c.n]), cell.decisions[c.n].tier_confidence)
              for c in cases if c.n in cell.decisions]
    chosen = pick_threshold(points)
    ms = [d.ms for d in cell.decisions.values()]
    tier1 = [c for c in cases if c.tier == 1 and c.n in cell.decisions]
    return {
        "kev": cell.kev, "local": cell.local, "threshold": chosen,
        "raw": ladder(points, 0.0), "at": ladder(points, 1.0 if chosen is None else chosen),
        "rejected": sum(1 for d in cell.decisions.values() if d.action == ""),
        "action_accuracy": round(sum(cell.decisions[c.n].action == c.action for c in tier1) / len(tier1), 3) if tier1 else None,
        "p50_ms": percentile(ms, 0.5), "p90_ms": percentile(ms, 0.9),
        "tier2_pass": sum(g == "pass" for g in cell.grades.values()), "tier2_total": len(cell.grades),
        "failures": {kind: sum(g == kind for g in cell.grades.values()) for kind in FAILURES},
        "memory": memory(cell.samples), "latency": asdict(cell.latency) if cell.latency else None,
        "tier2_blocked": cell.tier2_blocked,
    }


def recommend(summaries: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """A Kev with a safe threshold in every cell beats one without. Among those, the smaller
    when its cloud share is within five points of the larger. Then the local model with more
    tier 2 passes, ties to the faster warm run."""
    if not summaries:
        return None
    by_kev: dict[str, list[dict]] = {}
    for s in summaries:
        by_kev.setdefault(s["kev"], []).append(s)
    worst = {k: (max(len(s["at"]["unsafe"]) for s in ss), max(s["at"]["cloud_share"] for s in ss))
             for k, ss in by_kev.items()}
    sizes = [k for k in KEV if k in by_kev]
    pool = [k for k in sizes if worst[k][0] == 0] or sizes
    kev = pool[-1]
    if len(pool) > 1 and worst[pool[0]][1] - worst[pool[-1]][1] <= 0.05:
        kev = pool[0]

    def local_key(local: str) -> tuple[int, float]:
        mine = [s for s in summaries if s["local"] == local]
        warm = [s["latency"]["warm_ms"] for s in mine if s["latency"]]
        return (-sum(s["tier2_pass"] for s in mine), min(warm) if warm else math.inf)

    local = min({s["local"] for s in summaries}, key=local_key)
    return next(s for s in summaries if s["kev"] == kev and s["local"] == local)


def gb(mb: int | None) -> str:
    return "?" if mb is None else f"{mb / 1024:.1f}"


def fmt_threshold(s: dict) -> str:
    return "none" if s["threshold"] is None else f"{s['threshold']:.2f}"


def table(summaries: Sequence[dict[str, Any]]) -> list[str]:
    lines = ["| kev | local | peak memory kev/ollama/voice (GB) | sum | min free % | swap | tier acc | unsafe@t | t "
             "| cloud % | p50/p90 decision ms | tier2 pass | cold/warm s | tok/s |",
             "|" + "---|" * 14]
    for s in summaries:
        m, lat = s["memory"], s["latency"]
        tier2 = "blocked" if s["tier2_blocked"] else f"{s['tier2_pass']}/{s['tier2_total']}"
        speed = f"{lat['cold_ms'] / 1000:.1f}/{lat['warm_ms'] / 1000:.1f} | {lat['tok_s']}" if lat else "? | ?"
        lines.append(
            f"| {s['kev']} | {s['local']} | {gb(m['kev'])}/{gb(m['ollama'])}/{gb(m['voice'])} | {gb(m['sum'])} "
            f"| {m['min_free_pct']} | {gb(m['swap_mb'])} GB | {s['at']['accuracy']:.0%} | {len(s['at']['unsafe'])} "
            f"| {fmt_threshold(s)} | {s['at']['cloud_share']:.0%} | {s['p50_ms']}/{s['p90_ms']} | {tier2} "
            f"| {speed} |")
    return lines


def render_md(meta: dict, cases: Sequence[Case], cells: Sequence[Cell], summaries: Sequence[dict]) -> str:
    best = recommend(summaries)
    out = [f"# Tier ladder benchmark, {meta['date']}", ""]
    if best is None:
        out.append("Recommendation: none, no cell ran.")
    else:
        t = best["threshold"]
        m = best["memory"]
        tail = "" if t is not None else f" No threshold is safe; unsafe at 1.00: cases {', '.join(map(str, best['at']['unsafe']))}."
        out += [f"Recommendation: Kev {best['kev']} ({KEV[best['kev']]}) with {LOCAL[best['local']]}, "
                f"threshold {fmt_threshold(best)}.{tail}",
                f"Cloud share at that threshold {best['at']['cloud_share']:.0%}. With everything loaded the machine "
                f"kept at least {m['min_free_pct']}% of memory free and swap peaked at {gb(m['swap_mb'])} GB."]
    out += ["", *table(summaries), ""]
    names = [TIER_KEY[n] for n in TIER_KEY]
    for cell, s in zip(cells, summaries):
        at = s["at"]
        out += [f"## Confusion (kev {cell.kev}, {cell.local} @ {fmt_threshold(s)})", "",
                "| label \\ effective | " + " | ".join(names) + " |", "|" + "---|" * (len(names) + 1)]
        out += [f"| {TIER_KEY[label]} | " + " | ".join(str(at["confusion"][f"{label}>{e}"]) for e in TIER_KEY) + " |"
                for label in TIER_KEY]
        per_tier = ", ".join(f"{k} {'-' if v is None else f'{v:.0%}'}" for k, v in at["per_tier"].items())
        action = "-" if s["action_accuracy"] is None else f"{s['action_accuracy']:.0%}"
        out += ["", f"Accuracy per tier: {per_tier}. Raw accuracy at 0.00 {s['raw']['accuracy']:.0%}. "
                f"Rejected menu keys {s['rejected']}. Tier 1 action accuracy {action}.", ""]
    out += ["## Tier 2 failures by kind", ""]
    for cell, s in zip(cells, summaries):
        if cell.tier2_blocked:
            out += [f"kev {cell.kev}, {cell.local}: tier 2 blocked, {cell.tier2_blocked}", "", "```",
                    cell.stderr_tail, "```", ""]
        else:
            kinds = ", ".join(f"{k} {v}" for k, v in s["failures"].items() if v) or "none"
            out += [f"kev {cell.kev}, {cell.local}: {kinds}", ""]
    out += ["## Cases", ""]
    for cell in cells:
        out += [f"### kev {cell.kev}, {cell.local}", ""]
        for c in cases:
            d = cell.decisions.get(c.n)
            if d is None:
                continue
            out.append(f"- {c.n}. label {TIER_KEY[c.tier]}, decided {d.tier or 'unknown'} {d.tier_confidence:.2f}, "
                       f"action {d.action or 'rejected'}, tier2 {cell.grades.get(c.n, '-')}, {d.ms} ms")
        out.append("")
    out.append(f"Machine: {meta['hw_model']}, {meta['memsize_gb']} GB, macOS {meta['macos']}, "
               f"claude {meta['claude']}, ollama {meta['ollama']}, kev {meta['kev_commit']}.")
    return "\n".join(out) + "\n"


def machine(turns: Any) -> dict[str, Any]:
    def run(argv: list[str], cwd: Path | None = None) -> str:
        try:
            return subprocess.run(argv, capture_output=True, text=True, cwd=cwd, timeout=30).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            return "?"
    mem = sysctl("hw.memsize")
    return {"date": datetime.now().strftime("%Y-%m-%d %H:%M"), "hw_model": sysctl("hw.model"),
            "memsize_gb": int(mem) // 2**30 if mem.isdigit() else "?",
            "macos": run(["sw_vers", "-productVersion"]) or platform.mac_ver()[0],
            "claude": run([turns.CLAUDE_BIN, "--version"]), "ollama": run(["ollama", "--version"]).removeprefix("ollama version is "),
            "kev_commit": run(["git", "rev-parse", "--short", "HEAD"], STATE / "kev"),
            "kev_models": KEV, "local_models": LOCAL}


def run_cell(cell: Cell, cases: Sequence[Case], menu: dict[str, str], turns: Any, vault: Path,
             base: str, scratch_state: Path, skip_tier2: bool) -> None:
    kev = ollama = sampler = None
    try:
        kev = start_kev(cell.kev)
        ollama = start_ollama()
        sampler = Sampler({"kev": kev.pid, "ollama": ollama.pid})
        cell.latency = measure_latency(LOCAL[cell.local])
        env = tier2_env(cell.local, scratch_state)
        if not skip_tier2:
            outcome = turns.run_command(tier2_argv(turns, READY_PROMPT, cell.local), TIMEOUT_S, env=env)
            ready = parse_stream(outcome.stdout, ms=outcome.ms, timed_out=outcome.timed_out)
            if ready.timed_out:
                cell.tier2_blocked = f"the preflight timed out after {TIMEOUT_S}s"
            elif not ready.subtype:
                cell.tier2_blocked = f"no result event, exit {outcome.returncode}"
            elif "ready" not in ready.said.lower():
                cell.tier2_blocked = f"the preflight said {ready.said[:200]!r}"
            if cell.tier2_blocked:
                cell.stderr_tail = "\n".join(outcome.stderr.splitlines()[-40:])
        now = turns.local_now()
        for case in cases:
            d = decide(case.say, menu)
            cell.decisions[case.n] = d
            line = f"decided   {d.tier or 'unknown'} {d.tier_confidence:.2f}, action {d.action or 'rejected'}, {d.ms} ms"
            if case.tier == 2 and not skip_tier2 and not cell.tier2_blocked:
                restore(vault, base)
                outcome = turns.run_command(tier2_argv(turns, tier2_prompt(case.say, vault, now), cell.local),
                                            TIMEOUT_S, env=env)
                commits, changed, diff = vault_facts(vault, base)
                run = parse_stream(outcome.stdout, ms=outcome.ms, timed_out=outcome.timed_out,
                                   commits=commits, changed=changed)
                cell.runs[case.n], cell.grades[case.n] = run, grade(case, run, diff)
            ok = decided_tier(d) == case.tier
            print(f"[{'ok' if ok else 'MISS'}] {cell.kev} {cell.local} {case.n}. {case.say}")
            print(f"        label     {TIER_KEY[case.tier]}{', ' + case.action if case.action else ''}")
            print(f"        {line}")
            if case.n in cell.runs:
                r = cell.runs[case.n]
                print(f"        tier2     {cell.grades[case.n]}, {r.ms / 1000:.1f}s, said {r.said[:120]!r}")
    finally:
        if sampler is not None:
            cell.samples = sampler.stop()
        stop(ollama)
        stop(kev)


def load_cells(payload: dict) -> tuple[list[Case], list[Cell]]:
    """Cases and cells back out of a results file, decisions and grades only. Samples are not
    kept, so the memory figures come from the stored summaries."""
    cases = [Case(**{**raw, "answer_has": tuple(raw["answer_has"]), "diff_has": tuple(raw["diff_has"])})
             for raw in payload["cases"]]
    cells = []
    for raw in payload["cells"]:
        cell = Cell(raw["kev"], raw["local"], tier2_blocked=raw.get("tier2_blocked"), stderr_tail=raw.get("stderr_tail", ""))
        cell.decisions = {int(n): Decision(**d) for n, d in raw["decisions"].items()}
        cell.grades = {int(n): g for n, g in raw["grades"].items()}
        cells.append(cell)
    return cases, cells


def rerender(path: Path) -> Path:
    payload = json.loads(path.read_text())
    cases, cells = load_cells(payload)
    md = path.with_suffix(".md")
    md.write_text(render_md(payload["meta"], cases, cells, payload["summaries"]))
    return md


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", type=Path, metavar="RESULTS_JSON",
                    help="render the Markdown report again from a results file, no servers")
    ap.add_argument("--only", type=int, help="run one case, 1-based")
    ap.add_argument("--kev", choices=sorted(KEV), help="one Kev size, default both")
    ap.add_argument("--local", choices=sorted(LOCAL), help="one local model, default both")
    ap.add_argument("--keep", action="store_true", help="leave the vault copy on disk")
    ap.add_argument("--skip-tier2", action="store_true", help="decisions and memory only")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)
    if a.report:
        print(rerender(a.report))
        return 0

    cases = load_cases()
    if a.only is not None:
        if not 1 <= a.only <= len(cases):
            raise SystemExit(f"--only takes 1 to {len(cases)}")
        cases = [cases[a.only - 1]]
    if not answers(VOICE_HEALTH):
        raise SystemExit(f"refusing to run: the speech server is not answering {VOICE_HEALTH}")

    root, vault, base = copy_vault()
    ensure_temporary(vault)
    scratch_state = root / "state"
    # `common.VAULT` is read at import time, so the copy has to be in place before turns is imported.
    os.environ["HELM_VAULT_ROOT"] = str(vault)
    sys.path[:0] = [str(ENGINE / "dashboard" / "server"), str(ENGINE / "runner"),
                    str(ENGINE / "runner" / "producers")]
    import turns  # noqa: E402

    menu = build_menu(vault)
    meta = machine(turns)
    cells = [Cell(k, l) for k in KEV if a.kev in (None, k) for l in LOCAL if a.local in (None, l)]
    try:
        for cell in cells:
            run_cell(cell, cases, menu, turns, vault, base, scratch_state, a.skip_tier2)
    finally:
        done = [c for c in cells if c.decisions]
        summaries = [summarize(c, cases) for c in done]
        stamp = datetime.now().strftime("%Y-%m-%d-%H%M")
        results = STATE / "results"
        results.mkdir(parents=True, exist_ok=True)
        md, js = results / f"{stamp}.md", results / f"{stamp}.json"
        md.write_text(render_md(meta, cases, done, summaries))
        js.write_text(json.dumps({"meta": meta, "thresholds": THRESHOLDS, "cases": [asdict(c) for c in cases],
                                  "menu": menu, "tiers": {k: v for k, (_, v) in TIERS.items()},
                                  "cells": [{**asdict(c), "samples": None} for c in done],
                                  "summaries": summaries}, indent=2, default=str))
        print("\n" + "\n".join(table(summaries)))
        print(f"\n{md}\n{js}")
        if a.keep:
            print(f"vault copy kept at {vault}")
        else:
            shutil.rmtree(root, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
