"""The two questions the dashboard asks the machine it runs on, and nothing else.

`launchctl_list` reads launchd's view of this user's jobs, and `tailscale_status` reads the
tailnet's. Both are module functions so the tests replace them, the way they replace
`routes.service_installed`: a test must never depend on what the machine running it has
installed. Everything that turns their answers into records lives in `background.py` and
`devices.py`, as functions of what these return.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

TAILSCALE_APP = Path("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
TAILSCALE_TIMEOUT_S = 3
TAILSCALE_CACHE_S = 30


@dataclass(frozen=True)
class LaunchdJob:
    label: str
    pid: int | None
    last_exit: int | None


def launchctl_list() -> dict[str, LaunchdJob]:
    """Every job launchd holds for this user, by label. Empty when launchctl is missing,
    which is every machine that is not a Mac."""
    try:
        out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    return parse_launchctl(out)


def parse_launchctl(text: str) -> dict[str, LaunchdJob]:
    jobs = {}
    for line in text.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pid, status, label = parts
        jobs[label] = LaunchdJob(label, int(pid) if pid.lstrip("-").isdigit() else None,
                                 int(status) if status.lstrip("-").isdigit() else None)
    return jobs


@dataclass(frozen=True)
class Tailnet:
    """`tailscale status --json`, or why there is none."""
    status: dict | None
    error: str | None


_cache: tuple[float, Tailnet] | None = None
_lock = threading.Lock()


def tailscale_binary() -> str | None:
    found = shutil.which("tailscale")
    if found:
        return found
    return str(TAILSCALE_APP) if TAILSCALE_APP.exists() else None


def _ask_tailscale() -> Tailnet:
    binary = tailscale_binary()
    if binary is None:
        return Tailnet(None, "tailscale is not installed on this machine")
    try:
        r = subprocess.run([binary, "status", "--json"], capture_output=True, text=True,
                           timeout=TAILSCALE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return Tailnet(None, f"tailscale status took over {TAILSCALE_TIMEOUT_S}s")
    except OSError as e:
        return Tailnet(None, f"tailscale not runnable ({e})")
    if r.returncode != 0:
        return Tailnet(None, f"tailscale status: {r.stderr.strip() or f'exit {r.returncode}'}")
    try:
        parsed = json.loads(r.stdout)
    except ValueError:
        return Tailnet(None, "tailscale status answered something that is not JSON")
    return Tailnet(parsed if isinstance(parsed, dict) else None,
                   None if isinstance(parsed, dict) else "tailscale status answered no object")


def tailscale_status() -> Tailnet:
    """The tailnet as of at most 30 seconds ago, so a page that polls cannot queue processes."""
    global _cache
    with _lock:
        if _cache is not None and time.monotonic() - _cache[0] < TAILSCALE_CACHE_S:
            return _cache[1]
        answer = _ask_tailscale()
        _cache = (time.monotonic(), answer)
        return answer
