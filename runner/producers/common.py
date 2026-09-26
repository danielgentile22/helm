"""Shared by every capture source: paths, env, the envelope, atomic writes, departments.

A source is a function `(env, now) -> list[dict]`. `run_source` wraps it: on success the
rows are written to `~/.helm/status/sources/<name>.json`; on failure the cached rows are
kept and the failure is recorded beside them. The merged files copy each source's
envelope verbatim, so a reader learns staleness from the artifact it already holds and
never from a summary written by something else (ADR 0008).
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sys
import threading
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, Literal, TypedDict
from zoneinfo import ZoneInfo

ENGINE = Path(__file__).resolve().parents[2]
# Everything helm writes for its own use lives outside the repo and outside the vault
# (ADR 0023): status files, logs, metrics, voice turns, credentials.
STATE = Path(os.environ.get("HELM_STATE") or Path.home() / ".helm")
STATUS = STATE / "status"
SOURCES_DIR = STATUS / "sources"
SESSIONS_DIR = STATUS / "sessions"
# The vault lives outside every repo, at HELM_VAULT_ROOT or ~/Vault. HELM_VAULT_ROOT (absolute)
# overrides both and points every producer at a copy; the voice fixture runner sets it so a
# headless run writes into a throwaway copy.
VAULT = Path(os.environ.get("HELM_VAULT_ROOT") or Path.home() / "Vault")
PROJECTS_DIR = Path.home() / "Projects"

Department = Literal["Work", "Projects", "Chess", "Life"]
DEPARTMENTS: tuple[Department, ...] = ("Work", "Projects", "Chess", "Life")

Reason = Literal["auth", "network", "deps", "timeout", "parse", "crash"]


class SourceError(Exception):
    """A source failing for a reason it recognised. Anything else is `crash`."""

    def __init__(self, reason: Reason, detail: str) -> None:
        super().__init__(f"{reason}: {detail}")
        self.reason: Reason = reason
        self.detail = detail


class SourceMeta(TypedDict):
    """`produced` is the last successful collect and the time the rows were true.
    `attempted` is the last try. They differ exactly when the source is failing."""
    produced: str | None
    attempted: str
    ok: bool
    reason: str | None
    count: int
    cadence_s: int


Collector = Callable[[dict[str, str], datetime], list[dict]]


@dataclass
class SourceRun:
    name: str
    meta: SourceMeta
    items: list[dict]


def load_env() -> dict[str, str]:
    """`.env` at the helm root, overridden by the real environment. Values are never
    logged. Secrets are referenced by name (global rule)."""
    env: dict[str, str] = {}
    dotenv = ENGINE / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    env.update(os.environ)
    return env


def local_tz(env: dict[str, str]) -> ZoneInfo:
    return ZoneInfo(env.get("HELM_TZ", "America/New_York"))


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def write_json(path: Path, payload: object) -> None:
    """Temp file beside the target, then os.replace. A reader never sees a half file.

    The temp name carries the writer's pid and thread: the dashboard re-merges after a
    toggle while the half-hourly capture may be writing the same file, and two dashboard
    threads may re-merge at once, so one shared temp name would let them interleave into it
    or replace a temp file the other had already moved."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, path)


@contextmanager
def vault_write_lock() -> Iterator[None]:
    """One flock around every write to the vault and every read the todos source makes of it.

    The vault's git index is one shared writer between the todo editor's command line and
    the dashboard server, so a note write and its commit run under this. The todos source
    holds it too, from before it reads the notes until after its cache file is replaced:
    a scheduled collect that started before a board click could otherwise write pre-click
    rows over the click's own cache, and a ticked box would come back open. The lock file
    lives under ~/.helm/status/, never in a tree the project scan measures, and is found at
    call time so a test that redirects STATUS gets its own."""
    lock_path = STATUS / ".vault-write.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def content_id(*parts: str) -> str:
    """Identity for a row with no natural id (a todo line). sha1 of the parts, 12 hex."""
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()[:12]


def dept_for_note(note: Path) -> Department:
    """A note's department is the Atlas folder it lives in."""
    try:
        rel = note.resolve().relative_to((VAULT / "Atlas").resolve())
    except ValueError:
        return "Life"
    top = rel.parts[0] if rel.parts else ""
    return top if top in DEPARTMENTS else "Life"  # type: ignore[return-value]


def cached(name: str) -> dict | None:
    return read_json(SOURCES_DIR / f"{name}.json")


def cached_run(name: str, cadence_s: int) -> SourceRun:
    """A source's last run, from its cache, for a merge that reruns only one source. A source
    with no cache yet reads as never produced, which is what it is."""
    prior = cached(name)
    if prior and isinstance(prior.get("meta"), dict):
        meta = dict(prior["meta"])
        meta.setdefault("cadence_s", cadence_s)
        return SourceRun(name, meta, list(prior.get("items", [])))  # type: ignore[arg-type]
    meta: SourceMeta = {"produced": None, "attempted": iso(utc_now()), "ok": False,
                        "reason": "crash: no cache for this source yet", "count": 0, "cadence_s": cadence_s}
    return SourceRun(name, meta, [])


def run_source(name: str, collect: Collector, env: dict[str, str], now: datetime, cadence_s: int) -> SourceRun:
    """Run one collector as its own failure domain. Success overwrites the cache; failure
    keeps the cached rows, keeps their `produced`, and records why. Two runs with the same
    inputs write the same file."""
    attempted = iso(now)
    prior = cached(name)
    try:
        items = collect(env, now)
        meta: SourceMeta = {"produced": attempted, "attempted": attempted, "ok": True,
                            "reason": None, "count": len(items), "cadence_s": cadence_s}
        write_json(SOURCES_DIR / f"{name}.json", {"meta": meta, "items": items})
        return SourceRun(name, meta, items)
    except SourceError as e:
        reason = f"{e.reason}: {e.detail}"
    except Exception as e:  # noqa: BLE001  a crash is reported, never a crash-loop
        reason = f"crash: {type(e).__name__}: {e}"
        traceback.print_exc(file=sys.stderr)
    items = list(prior.get("items", [])) if prior else []
    produced = (prior or {}).get("meta", {}).get("produced")
    meta = {"produced": produced, "attempted": attempted, "ok": False,
            "reason": reason, "count": len(items), "cadence_s": cadence_s}
    write_json(SOURCES_DIR / f"{name}.json", {"meta": meta, "items": items})
    return SourceRun(name, meta, items)
