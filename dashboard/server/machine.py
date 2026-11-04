"""Everything the dashboard asks of, or tells, the machine it runs on.

`launchctl_list` reads launchd's view of this user's jobs, `tailscale_status` reads the
tailnet's, and `usage` reads how hard this Mac is working. `launchctl` is the one way a routine is started, booted out or bootstrapped, and
`LAUNCH_AGENTS` is the folder launchd loads plists from. All are module attributes so the
tests replace them, the way they replace `routes.service_installed`: a test must never
depend on, or change, what the machine running it has installed. Everything that turns
their answers into records lives in `background.py`, `control.py` and `devices.py`.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

LAUNCH_AGENTS = Path.home() / "Library" / "LaunchAgents"
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


def gui_domain() -> str:
    return f"gui/{os.getuid()}"


def launchctl(*args: str) -> tuple[int, str]:
    """One launchctl call, and its exit code and what it printed, stdout then stderr. Every
    argument is built by `control.py` from a label and a path, never from request text. A
    launchctl that could not be run or timed out is exit 1, never a code launchctl uses to
    mean "no such job"."""
    try:
        r = subprocess.run(["launchctl", *args], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 1, type(e).__name__
    return r.returncode, r.stdout + r.stderr


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
    # The app's own binary is the GUI unless TERM is set, and launchd sets none: it then
    # prints "The Tailscale GUI failed to start" and exits 0.
    env = {**os.environ, "TERM": os.environ.get("TERM") or "dumb"}
    try:
        r = subprocess.run([binary, "status", "--json"], capture_output=True, text=True,
                           timeout=TAILSCALE_TIMEOUT_S, env=env)
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


# What `kern.memorystatus_vm_pressure_level` holds: the level Activity Monitor colors its
# memory pressure graph by.
PRESSURE = {1: "normal", 2: "warn", 4: "critical"}
DATA_VOLUME = Path("/System/Volumes/Data")
# By full path: launchd starts the dashboard with a PATH that leaves out /usr/sbin.
SYSCTL = "/usr/sbin/sysctl"
VM_STAT = "/usr/bin/vm_stat"


def _run(*args: str) -> str | None:
    try:
        r = subprocess.run(list(args), capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def parse_vm_stat(text: str) -> dict[str, int]:
    """`vm_stat` as page counts by name, plus `page size` in bytes."""
    counts: dict[str, int] = {}
    size = re.search(r"page size of (\d+) bytes", text)
    if size:
        counts["page size"] = int(size.group(1))
    for line in text.splitlines()[1:]:
        name, _, value = line.rpartition(":")
        value = value.strip().rstrip(".")
        if value.isdigit():
            counts[name.strip().strip('"').lower()] = int(value)
    return counts


def memory_used(counts: dict[str, int]) -> int | None:
    """Bytes in use the way Activity Monitor counts "Memory Used": app memory (anonymous
    pages that are not purgeable), wired memory, and what the compressor occupies."""
    keys = ("page size", "anonymous pages", "pages purgeable", "pages wired down", "pages occupied by compressor")
    if not all(k in counts for k in keys):
        return None
    pages = (counts["anonymous pages"] - counts["pages purgeable"] + counts["pages wired down"]
             + counts["pages occupied by compressor"])
    return max(pages, 0) * counts["page size"]


def parse_boottime(text: str) -> int | None:
    found = re.search(r"sec = (\d+)", text)
    return int(found.group(1)) if found else None


def memory_now() -> int | None:
    """Bytes of memory in use right now, or None when vm_stat will not say."""
    vm = _run(VM_STAT)
    return memory_used(parse_vm_stat(vm)) if vm is not None else None


# HOST_CPU_LOAD_INFO: ticks every core has spent in each state since boot, in the order
# user, system, idle, nice. The share busy between two readings is CPU usage over that span.
HOST_CPU_LOAD_INFO = 3
_host: tuple[ctypes.CDLL, int] | None = None


def cpu_ticks() -> tuple[int, int, int, int] | None:
    """(user, system, idle, nice) ticks since boot, or None off macOS or on any failure."""
    global _host
    try:
        if _host is None:
            libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
            libc.mach_host_self.restype = ctypes.c_uint32
            # One port for the life of the process: each call to mach_host_self takes a new right.
            _host = (libc, libc.mach_host_self())
        libc, host = _host
        info = (ctypes.c_uint32 * 4)()
        count = ctypes.c_uint32(4)
        if libc.host_statistics(host, HOST_CPU_LOAD_INFO, info, ctypes.byref(count)) != 0:
            return None
    except (OSError, AttributeError):
        return None
    return info[0], info[1], info[2], info[3]


def busy_share(before: tuple[int, ...], after: tuple[int, ...]) -> float | None:
    """The share of ticks between two readings that were not idle, from 0 to 1."""
    spent = [b - a for a, b in zip(before, after)]
    total = sum(spent)
    if total <= 0 or any(n < 0 for n in spent):
        return None
    return (total - spent[2]) / total


def usage() -> dict:
    """How hard the machine the dashboard runs on is working, read fresh. Each part is
    None when its probe fails, so a Mac that refuses one question still answers the rest."""
    memory = None
    total = _run(SYSCTL, "-n", "hw.memsize")
    used = memory_now()
    if total is not None and total.strip().isdigit() and used is not None:
        level = _run(SYSCTL, "-n", "kern.memorystatus_vm_pressure_level")
        memory = {"used": used, "total": int(total.strip()),
                  "pressure": PRESSURE.get(int(level.strip())) if level and level.strip().isdigit() else None}
    disk = None
    try:
        # On macOS the Data volume holds everything the owner writes; "/" is the sealed system.
        d = shutil.disk_usage(DATA_VOLUME if DATA_VOLUME.exists() else "/")
        disk = {"used": d.total - d.free, "total": d.total}
    except OSError:
        pass
    try:
        load = {"one": round(os.getloadavg()[0], 2), "cpus": os.cpu_count()}
    except OSError:
        load = None
    boot = _run(SYSCTL, "-n", "kern.boottime")
    booted = parse_boottime(boot) if boot is not None else None
    return {"memory": memory, "disk": disk, "load": load,
            "booted": None if booted is None else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(booted))}
