"""Web Push for the dashboard (ADR 0039): the subscriptions, the public key, and sending.

The Python standard library has no Web Push encryption, so `dashboard/scripts/push.mjs`
does the sending with the `web-push` package and this module calls it with a timeout. The
script only reads `~/.helm/push/dashboard.json`; every write to it happens here, under one
lock, so the dashboard enrolling a phone and an evaluation dropping a dead subscription
never race. The VAPID keys are made once by the script, in `~/.helm/push/vapid.json`.

A payload is `{title, tab, count}` and nothing else. Callers pass a title that carries no
idea text and no log line.
"""
from __future__ import annotations

import fcntl
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, TypedDict

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE / "producers")]

import common  # noqa: E402

SCRIPT = common.ENGINE / "dashboard" / "scripts" / "push.mjs"
TIMEOUT_S = 30
TABS = ("projects", "ideas", "background", "devices")


class PushError(Exception):
    pass


class Keys(TypedDict):
    p256dh: str
    auth: str


class Subscription(TypedDict):
    endpoint: str
    keys: Keys
    created: str


class Sent(TypedDict):
    sent: int
    removed: int
    failed: int


def folder() -> Path:
    return common.STATE / "push"


def subscriptions_file() -> Path:
    return folder() / "dashboard.json"


@contextmanager
def locked() -> Iterator[None]:
    folder().mkdir(parents=True, exist_ok=True, mode=0o700)
    with (folder() / ".dashboard.lock").open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def subscriptions() -> list[Subscription]:
    doc = common.read_json(subscriptions_file()) or {}
    subs = doc.get("subscriptions")
    return subs if isinstance(subs, list) else []


def _save(subs: list[Subscription]) -> None:
    common.write_json(subscriptions_file(), {"subscriptions": subs})
    os.chmod(subscriptions_file(), 0o600)


def subscribe(endpoint: str, keys: Keys, now: str) -> bool:
    """Idempotent on the endpoint: the same browser enrolling twice keeps one row, with the
    newest keys."""
    with locked():
        subs = subscriptions()
        old = next((s for s in subs if s["endpoint"] == endpoint), None)
        if old is not None and old["keys"] == keys:
            return False
        subs = [s for s in subs if s["endpoint"] != endpoint]
        subs.append({"endpoint": endpoint, "keys": keys, "created": old["created"] if old else now})
        _save(subs)
        return True


def unsubscribe(endpoints: list[str]) -> int:
    with locked():
        subs = subscriptions()
        kept = [s for s in subs if s["endpoint"] not in endpoints]
        if len(kept) != len(subs):
            _save(kept)
        return len(subs) - len(kept)


def node(command: str, stdin: str = "") -> str:
    """stdout of one `push.mjs` command. Raises PushError with a reason fit for a log line."""
    binary = shutil.which("node")
    if binary is None:
        raise PushError("node is not on PATH")
    env = {**common.load_env(), "HELM_STATE": str(common.STATE)}
    try:
        r = subprocess.run([binary, str(SCRIPT), command], input=stdin, capture_output=True, text=True,
                           timeout=TIMEOUT_S, env=env)
    except subprocess.TimeoutExpired:
        raise PushError(f"push.mjs {command} took over {TIMEOUT_S}s") from None
    except OSError as e:
        raise PushError(f"push.mjs {command} did not start ({type(e).__name__})") from None
    if r.returncode != 0:
        last = (r.stderr.strip().splitlines() or [f"exit {r.returncode}"])[-1]
        raise PushError(f"push.mjs {command}: {last[:200]}")
    return r.stdout


def public_key() -> str:
    """The VAPID public key, made on first use."""
    doc = common.read_json(folder() / "vapid.json") or {}
    key = doc.get("publicKey")
    return key if isinstance(key, str) and key else node("key").strip()


def send(title: str, tab: str, count: int) -> Sent:
    """One notification to every subscription. A subscription the push service calls gone
    (404 or 410) is removed. Raises PushError when nothing could be delivered."""
    if tab not in TABS:
        raise ValueError(f"tab {tab!r} is not one of {', '.join(TABS)}")
    out = node("send", json.dumps({"title": title, "tab": tab, "count": count}))
    try:
        answer = json.loads(out)
        gone = [str(e) for e in answer.get("gone") or []]
        sent, failed = int(answer.get("sent") or 0), int(answer.get("failed") or 0)
    except (ValueError, AttributeError, TypeError):
        raise PushError("push.mjs send answered something that is not its JSON summary") from None
    removed = unsubscribe(gone) if gone else 0
    return {"sent": sent, "removed": removed, "failed": failed}
