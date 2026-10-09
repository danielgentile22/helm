"""One headless `claude -p` run, the same shape as the integrity check and the talk route.

Model and effort come from models.json, never from a caller. A run is restricted in its argv
when it only needs to read: in `default` permission mode a headless run has nobody to ask,
so a tool outside the allowlist is denied. The tailoring run inherits the owner's own mode,
since it writes files and compiles LaTeX under a skill the owner already trusts.

The prompt travels on stdin: a rank prompt carrying sixty full postings is longer than an
argument may be. Every run asks for JSON output so its token counts and cost come back
with the answer.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from model import Usage

ENGINE = Path(__file__).resolve().parents[2]
CLAUDE_BIN = os.environ.get("HELM_CLAUDE_BIN", "claude")

READ_ONLY = ["--permission-mode", "default", "--allowedTools", "Read,Grep,Glob",
             "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Bash"]


def _models() -> dict:
    return json.loads((ENGINE / "models.json").read_text())


def _checked(entry: dict, name: str, policy: dict) -> tuple[str, str]:
    model, effort = entry["model"], entry["effort"]
    if model in policy.get("forbidden_models", ()):
        raise ValueError(f"models.json: {name} names {model}, which the policy forbids")
    if effort in policy.get("forbidden_effort", ()):
        raise ValueError(f"models.json: {name} names effort {effort}, which the policy forbids")
    return model, effort


def registry(kind: str, name: str) -> tuple[str, str]:
    data = _models()
    return _checked(data[kind][name], f"{kind}.{name}", data.get("policy", {}))


def pass_registry(routine: str, pass_name: str) -> tuple[str, str]:
    data = _models()
    entry = data["routines"][routine]["passes"][pass_name]
    return _checked(entry, f"routines.{routine}.passes.{pass_name}", data.get("policy", {}))


def parse_usage(d: dict) -> Usage:
    u = d.get("usage") or {}
    return Usage(int(u.get("input_tokens", 0)), int(u.get("output_tokens", 0)),
                 int(u.get("cache_read_input_tokens", 0)), int(u.get("cache_creation_input_tokens", 0)),
                 float(d.get("total_cost_usd", 0.0)))


def _result_event(lines: str) -> dict | None:
    for line in reversed(lines.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            return event
    return None


@dataclass(frozen=True)
class Outcome:
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool
    raw: str = ""
    usage: Usage = field(default_factory=Usage)

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    def tail(self, limit: int = 800) -> str:
        return (self.stdout + self.stderr).strip()[-limit:]


def run(prompt: str, model: str, effort: str, cwd: Path, timeout_s: int,
        read_only: bool = False, stream: bool = False) -> Outcome:
    """`stream` asks for one JSON line per event instead of the final text alone, so a run
    that is killed at the timeout still leaves what it was doing in its stdout. Without it,
    `stdout` is the model's final text and `raw` the JSON object it came in."""
    argv = [CLAUDE_BIN, "-p", "--model", model, "--effort", effort]
    if read_only:
        argv += READ_ONLY
    argv += ["--verbose", "--output-format", "stream-json"] if stream else ["--output-format", "json"]
    env = dict(os.environ, HELM_NO_SESSION_NOTE="1")
    try:
        r = subprocess.run(argv, cwd=str(cwd), env=env, input=prompt,
                           capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        return Outcome(stdout, stderr, -1, True)
    event = _result_event(r.stdout)
    if event is None:
        return Outcome(r.stdout, r.stderr, r.returncode, False)
    usage = parse_usage(event)
    if stream:
        return Outcome(r.stdout, r.stderr, r.returncode, False, r.stdout, usage)
    text = str(event.get("result", ""))
    return Outcome(text, r.stderr, r.returncode, False, r.stdout, usage)
