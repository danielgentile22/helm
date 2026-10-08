"""One headless `claude -p` run, the same shape as the integrity check and the talk route.

Model and effort come from models.json, never from a caller. A run is restricted in its argv
when it only needs to read: in `default` permission mode a headless run has nobody to ask,
so a tool outside the allowlist is denied. The tailoring run inherits the owner's own mode,
since it writes files and compiles LaTeX under a skill the owner already trusts.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
CLAUDE_BIN = os.environ.get("HELM_CLAUDE_BIN", "claude")

READ_ONLY = ["--permission-mode", "default", "--allowedTools", "Read,Grep,Glob",
             "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Bash"]


def registry(kind: str, name: str) -> tuple[str, str]:
    entry = json.loads((ENGINE / "models.json").read_text())[kind][name]
    return entry["model"], entry["effort"]


@dataclass(frozen=True)
class Outcome:
    stdout: str
    stderr: str
    returncode: int
    timed_out: bool

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out

    def tail(self, limit: int = 800) -> str:
        return (self.stdout + self.stderr).strip()[-limit:]


def run(prompt: str, model: str, effort: str, cwd: Path, timeout_s: int,
        read_only: bool = False, stream: bool = False) -> Outcome:
    """`stream` asks for one JSON line per event instead of the final text alone, so a run
    that is killed at the timeout still leaves what it was doing in its stdout."""
    argv = [CLAUDE_BIN, "-p", prompt, "--model", model, "--effort", effort]
    if read_only:
        argv += READ_ONLY
    if stream:
        argv += ["--verbose", "--output-format", "stream-json"]
    env = dict(os.environ, HELM_NO_SESSION_NOTE="1")
    try:
        r = subprocess.run(argv, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        return Outcome(e.stdout or "", e.stderr or "", -1, True)
    return Outcome(r.stdout, r.stderr, r.returncode, False)
