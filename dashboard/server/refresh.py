"""Rerun capture's project sources now, off the request, so a write or a tap shows within
seconds instead of at the next half-hour capture.

One worker at a time. A request while it runs adds its sources to the next round, so taps
in a burst cost one more round, not one each. `running()` is what the projects answers
report as `refreshing`, so the page polls fast until the round it caused is merged.
"""
from __future__ import annotations

import sys
import threading
from typing import Callable, Iterable

import capture  # noqa: E402

PROJECT_SOURCES: tuple[str, ...] = capture.PROJECT_SOURCES

_lock = threading.Lock()
_wanted: set[str] = set()
_busy = False
# Replaced in tests, so a round runs without git or GitHub.
run_source: Callable[[str], object] = capture.refresh


def running() -> bool:
    with _lock:
        return _busy or bool(_wanted)


def start(sources: Iterable[str]) -> None:
    """Queue these sources and make sure a worker is draining the queue."""
    global _busy
    names = set(sources)
    unknown = names - set(PROJECT_SOURCES)
    if unknown:
        raise ValueError(f"not project sources: {', '.join(sorted(unknown))}")
    with _lock:
        _wanted.update(names)
        if _busy:
            return
        _busy = True
    threading.Thread(target=_drain, name="refresh-projects", daemon=True).start()


def _drain() -> None:
    global _busy
    while True:
        with _lock:
            if not _wanted:
                _busy = False
                return
            # Local sources first: they take a second, GitHub takes several.
            batch = sorted(_wanted, key=PROJECT_SOURCES.index)
            _wanted.clear()
        for name in batch:
            try:
                run_source(name)
            except Exception as e:  # a failed round must not leave `refreshing` stuck on
                sys.stderr.write(f"refresh of {name} failed: {type(e).__name__}\n")
