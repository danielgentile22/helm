#!/usr/bin/env python3
"""Report a service when the thing it keeps alive is not answering.

Two ways it is broken and one way it is fine. The agent is loaded and the port answers, so
there is nothing to say. The agent is loaded and nothing answers, which is a process that is
crash looping or wedged, and its log says why. Or `models.json` names the service and no
agent is loaded, which is a machine that was never installed or an `--uninstall` that took
it away.

Every line says what is wrong in words. Nothing here is carried by colour.

This only reports. `runner/install-routines.sh` is what installs it.
"""
from __future__ import annotations

import http.client
import json
import sys
from pathlib import Path
from typing import Callable

ENGINE = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ENGINE / "runner"), str(ENGINE / "dashboard")]

import launchd  # noqa: E402
import serve  # noqa: E402  the dashboard's port and probe, both named in exactly one place

HOST = "127.0.0.1"
VOICE_PORT = 3108
PROBE_S = 3


def voice_answering() -> bool:
    """Whether the voice process reports its whole pipeline hot. Its `/health` is 200 only
    once both models are loaded and warmed, so a process still starting reads as down."""
    try:
        connection = http.client.HTTPConnection(HOST, VOICE_PORT, timeout=PROBE_S)
        connection.request("GET", "/health")
        payload = json.loads(connection.getresponse().read(4096))
        connection.close()
    except (OSError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("ok") is True


# One row per service that has something to ask: the address a person would open, and the
# probe. A service with no row here is checked for its agent and nothing else.
Probe = Callable[[], bool]
PROBES: dict[str, tuple[str, Probe]] = {
    "dashboard": (f"http://{HOST}:{serve.DEFAULT_PORT}/api/health", lambda: serve.is_otto(HOST, serve.DEFAULT_PORT)),
    "voice": (f"http://{HOST}:{VOICE_PORT}/health", voice_answering),
}


def problems(registry: dict, loaded: Callable[[str], bool], reachable: Callable[[str], bool]) -> list[str]:
    """`reachable` takes the service name and answers whether its probe passes."""
    found: list[str] = []
    for name in registry.get("services") or {}:
        label = launchd.PREFIX + name
        if not loaded(label):
            found.append(f"FAIL  {label} is named in models.json but no launchd agent is loaded; "
                         f"run runner/install-routines.sh")
        elif name in PROBES and not reachable(name):
            found.append(f"FAIL  {label} is loaded but nothing answers on {PROBES[name][0]}; "
                         f"read ~/.helm/logs/{label}.err")
    return found


def probe(name: str) -> bool:
    return PROBES[name][1]()


def main() -> int:
    registry = launchd.read_registry(ENGINE)
    lines = problems(registry, launchd.is_loaded, probe)
    for line in lines:
        print(line)
    counted = len(registry.get("services") or {})
    status = "PASS" if not lines else "FAIL"
    print(f"{status}  {counted} services checked, {len(lines)} down")
    return 1 if lines else 0


if __name__ == "__main__":
    sys.exit(main())
