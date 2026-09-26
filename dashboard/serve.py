#!/usr/bin/env python3
"""Start the helm dashboard: build `dist/` if it is stale, then serve it and the API.

    python3 dashboard/serve.py                  build if needed, serve, open a browser
    python3 dashboard/serve.py --no-open        no browser
    python3 dashboard/serve.py --no-build       serve whatever is in dist/ already
    python3 dashboard/serve.py --port 8700      another port
    python3 dashboard/serve.py --enroll         print a one shot link that registers a passkey

This stays the documented way to open the dashboard after `com.helm.dashboard` exists. It
probes the port for helm's own `/api/health` before doing anything, so running it while the
service is up opens the browser and exits rather than colliding on the port, and the launchd
agent never fights a hand started server.

Reach: every socket is loopback only, always. With `HELM_HOSTNAME` set in `.env` a second
loopback listener opens on `HELM_TAILNET_LOCAL_PORT`, `tailscale serve` fronts that one on
the tailnet, and every request on it is a tailnet request that needs a passkey session
(ADR 0009, ADR 0018). Binding `--host` to anything but 127.0.0.1 gets a 403 per request.

Node is a build time tool only. Nothing here names one machine: every path comes from this
file and from `common.ENGINE`.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
from pathlib import Path

DASHBOARD = Path(__file__).resolve().parent
sys.path[:0] = [str(DASHBOARD / "server"), str(DASHBOARD.parent / "runner" / "producers")]

import auth  # noqa: E402
import common  # noqa: E402
import routes  # noqa: E402
from app import make_server  # noqa: E402

DIST = routes.DIST
BUILT = DIST / ".built"
INPUTS = ("src", "index.html", "public", "package.json", "vite.config.ts")
DEFAULT_PORT = int(os.environ.get("HELM_DASHBOARD_PORT") or 8642)
PROBE_S = 1.5


def newest_input() -> float:
    newest = 0.0
    for name in INPUTS:
        path = DASHBOARD / name
        if not path.exists():
            continue
        newest = max(newest, path.stat().st_mtime)
        if path.is_dir():
            for child in path.rglob("*"):
                newest = max(newest, child.stat().st_mtime)
    return newest


def stale() -> bool:
    return not BUILT.exists() or BUILT.stat().st_mtime < newest_input()


def npm(*args: str) -> int:
    return subprocess.run(["npm", *args], cwd=str(DASHBOARD)).returncode


def build() -> None:
    """Build when the sources are newer than the last build, so a fresh clone and a stale
    checkout converge on the same first command (ADR 0014)."""
    if not stale():
        return
    if shutil.which("npm") is None:
        if DIST.is_dir():
            print("warning: npm is not on PATH, serving the dist/ that is already here", file=sys.stderr)
            return
        sys.exit("dashboard: npm is not on PATH and dashboard/dist is empty, so there is nothing to serve")
    if not (DASHBOARD / "node_modules").is_dir() and npm("install") != 0:
        sys.exit("dashboard: npm install failed")
    print("building dashboard/dist ...", file=sys.stderr)
    if npm("run", "build") != 0:
        if DIST.is_dir():
            print("warning: the build failed, serving the dist/ that is already here", file=sys.stderr)
            return
        sys.exit("dashboard: npm run build failed and dashboard/dist is empty")
    BUILT.parent.mkdir(parents=True, exist_ok=True)
    BUILT.touch()


def is_otto(host: str, port: int) -> bool:
    """Whether the thing listening there answers `/api/health` the way this server does.

    The response carries no Server header (`app.write` sends the status line and the headers
    the route asked for, and nothing else), so the body is the identification."""
    try:
        connection = http.client.HTTPConnection(host, port, timeout=PROBE_S)
        connection.request("GET", "/api/health", headers={"Host": f"{host}:{port}"})
        payload = json.loads(connection.getresponse().read(4096))
        connection.close()
    except (OSError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("ok") is True and "reach" in payload


def already_serving(host: str, port: int) -> bool:
    """Whether helm itself is already answering there.

    Three outcomes, and the caller needs two of them. Nothing listening means the port is
    ours to bind. helm answering means the service, or another copy of this command, has it,
    and binding again would only produce an address in use traceback. Anything else on the
    port exits with that as the message rather than a traceback."""
    try:
        socket.create_connection((host, port), timeout=PROBE_S).close()
    except OSError:
        return False

    if is_otto(host, port):
        return True
    sys.exit(f"dashboard: {host}:{port} is busy with something that is not helm. "
             f"stop it, or pass --port")


def enroll(origin: auth.Origin | None) -> int:
    """Open the door for one passkey. The token goes in a file the running server reads, so
    this works whether the service or a hand started copy is answering, and it works before
    either is up. Ten minutes, one use."""
    if origin is None:
        sys.exit("dashboard: set HELM_HOSTNAME in .env first; there is no tailnet door to enroll for")
    token = auth.write_enroll_token()
    print(f"open this on the phone within ten minutes:\n\n  {origin.url}/enroll?token={token}\n")
    print("the page asks for Face ID and registers the passkey; the link is dead once it has")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--enroll", action="store_true")
    args = ap.parse_args(argv)

    origin = auth.origin_from_env(common.load_env())
    if args.enroll:
        return enroll(origin)

    url = f"http://{args.host}:{args.port}/"
    if already_serving(args.host, args.port):
        print(f"helm dashboard is already serving on {url}")
        print(f"that is the com.helm.dashboard service, or another copy of this command. "
              f"to pick up source changes: launchctl kickstart -k gui/{os.getuid()}/com.helm.dashboard")
        if not args.no_open and sys.platform == "darwin":
            subprocess.run(["open", url], check=False)
        return 0

    if not args.no_build:
        build()

    table = routes.table(origin)
    tailnet = auth.tailnet_for(origin) if origin is not None else None
    server = make_server(args.host, args.port, table, tailnet)
    tailnet_server = (make_server(args.host, origin.local_port, table, tailnet, door="tailnet")
                      if origin is not None else None)
    print(f"helm dashboard on {url}" + (f"  and {origin.url} behind a passkey, via {args.host}:{origin.local_port}"
                                        if origin else "  (loopback only)"))
    print(f"status files from {common.STATUS}")
    if not args.no_open and sys.platform == "darwin":
        subprocess.run(["open", url], check=False)
    if tailnet_server is not None:
        threading.Thread(target=tailnet_server.serve_forever, daemon=True, name="tailnet-door").start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\notto dashboard stopped")
    finally:
        server.server_close()
        if tailnet_server is not None:
            tailnet_server.shutdown()
            tailnet_server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
