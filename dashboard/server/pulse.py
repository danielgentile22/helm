"""The last five minutes of this Mac's CPU, GPU and memory, sampled every two seconds, for
the desk (`GET /api/machine/usage`).

`history.py` keeps an hour at ten seconds for the Devices tab and always runs. This one is
finer and runs only while someone is looking: the first request starts the sampler, and it
stops itself after a minute and a half with no request, so a desk that is closed costs the
Mac nothing. Points live in memory only; a restart or a stop starts the graph empty.

A point's `cpu` and `gpu` are shares busy from 0 to 1, and `memory` is the share of memory
in use the way Activity Monitor counts it. Any of them is None when its probe failed.
"""
from __future__ import annotations

import threading
import time
from collections import deque

import machine

INTERVAL_S = 2.0
POINTS = int(300 / INTERVAL_S)
IDLE_S = 90.0

_points: deque[dict] = deque(maxlen=POINTS)
_lock = threading.Lock()
_running = False
_asked = 0.0
_total: int | None = None


def stamp(at: float) -> str:
    """Milliseconds, so two points never share a stamp and `since` can compare strings."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(at)) + f".{int(at * 1000) % 1000:03d}Z"


def memory_total() -> int | None:
    global _total
    if _total is None:
        raw = machine._run(machine.SYSCTL, "-n", "hw.memsize")
        _total = int(raw.strip()) if raw is not None and raw.strip().isdigit() else None
    return _total


def sample(before: tuple[int, ...] | None, at: float) -> tuple[dict, tuple[int, ...] | None]:
    after = machine.cpu_ticks()
    cpu = machine.busy_share(before, after) if before is not None and after is not None else None
    gpu = machine.gpu_now()
    used, total = machine.memory_now(), memory_total()
    memory = used / total if used is not None and total else None
    return {"at": stamp(at), "cpu": None if cpu is None else round(cpu, 4),
            "gpu": None if gpu is None else round(gpu, 4),
            "memory": None if memory is None else round(min(memory, 1.0), 4)}, after


def _loop() -> None:
    global _running
    ticks = machine.cpu_ticks()
    while True:
        time.sleep(INTERVAL_S)
        with _lock:
            if time.monotonic() - _asked > IDLE_S:
                _running = False
                _points.clear()
                return
        try:
            point, ticks = sample(ticks, time.time())
        except Exception:  # noqa: BLE001  one bad sample is a gap, never a dead sampler
            point, ticks = {"at": stamp(time.time()), "cpu": None, "gpu": None, "memory": None}, machine.cpu_ticks()
        with _lock:
            _points.append(point)


def asked() -> None:
    """A request came in: keep the sampler going, and start it if it had stopped."""
    global _running, _asked
    with _lock:
        _asked = time.monotonic()
        if _running:
            return
        _running = True
    threading.Thread(target=_loop, name="desk-pulse", daemon=True).start()


def points(since: str | None = None) -> list[dict]:
    with _lock:
        return [p for p in _points if since is None or p["at"] > since]


def answer(since: str | None) -> dict:
    """The answer of `GET /api/machine/usage`: every point newer than `since`, oldest first."""
    asked()
    return {"interval_s": INTERVAL_S, "window_s": POINTS * INTERVAL_S, "memory_total": memory_total(),
            "points": points(since)}
