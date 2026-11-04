"""The last hour of this Mac's CPU and memory, for the graphs on its device card.

A daemon thread started by `serve.py` samples every 10 seconds and keeps 360 points in
memory, so the graph covers an hour once the server has run that long; a restart starts it
empty. A point's `cpu` is the share busy since the sample before it, and either value is
None when its probe failed, which the page draws as a gap.
"""
from __future__ import annotations

import threading
import time
from collections import deque

import machine

INTERVAL_S = 10
POINTS = 3600 // INTERVAL_S

_points: deque[dict] = deque(maxlen=POINTS)
_lock = threading.Lock()
_started = False


def stamp(at: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(at))


def sample(before: tuple[int, ...] | None, at: float) -> tuple[dict, tuple[int, ...] | None]:
    """One point, and the ticks the next sample measures from."""
    after = machine.cpu_ticks()
    cpu = machine.busy_share(before, after) if before is not None and after is not None else None
    return {"at": stamp(at), "cpu": None if cpu is None else round(cpu, 4), "memory": machine.memory_now()}, after


def record(point: dict) -> None:
    with _lock:
        _points.append(point)


def points() -> list[dict]:
    with _lock:
        return list(_points)


def _loop() -> None:
    ticks = machine.cpu_ticks()
    while True:
        time.sleep(INTERVAL_S)
        try:
            point, ticks = sample(ticks, time.time())
        except Exception:  # noqa: BLE001  one bad sample is a gap, never a dead sampler
            point, ticks = {"at": stamp(time.time()), "cpu": None, "memory": None}, machine.cpu_ticks()
        record(point)


def start() -> None:
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, name="usage-history", daemon=True).start()
