"""T3 Code's threads, read and never changed, for the desk (ADR 0042).

T3's server answers MCP at `<origin>/mcp`; the origin is in its runtime file, read on every
connection because it changes when T3 restarts. The session is a read-only MCP client one,
issued by T3's own CLI and kept in this process's memory only, so the token is never on
disk, in a log or in the repo. Only `t3_thread_list`, `t3_project_list` and a one item
`t3_thread_read` of a running thread are ever called.

`issue_session`, `post` and `RUNTIME` are module attributes so the tests replace them, the
way they replace `machine.usage`: a test never asks the T3 on the machine running it.

Thread titles are personal. They go into the answer and nowhere else: every log line and
every `detail` here names a state or an error's type, never a title.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

HOME = Path(os.environ.get("T3CODE_HOME") or Path.home() / ".t3")
RUNTIME = HOME / "userdata" / "server-runtime.json"
CLI = Path(os.environ.get("HELM_T3_CLI") or HOME / "bin" / "t3")
PROTOCOL = "2025-06-18"
SESSION_TTL = "1h"
SESSION_REUSE_S = 50 * 60
CACHE_S = 4.0
TIMEOUT_S = 6
PROJECTS_S = 300.0
FINISHED_SHOWN = 8
ACTIVE_LIMIT = 50

RUNNING = ("preparing", "queued", "starting", "running")
WAITING = ("waiting",)
FINISHED = ("completed", "failed", "interrupted", "cancelled")
OUTCOME = {"completed": "done", "failed": "failed", "interrupted": "stopped", "cancelled": "stopped"}


class T3Error(Exception):
    """Why T3 could not be read, in words with no thread in them. `state` is what the
    answer's `state` says: not_running, unreachable or error."""

    def __init__(self, state: str, detail: str) -> None:
        super().__init__(detail)
        self.state = state
        self.detail = detail


class Unauthorized(T3Error):
    def __init__(self) -> None:
        super().__init__("error", "T3 refused the session")


@dataclass(frozen=True)
class Session:
    id: str
    token: str
    issued: float


def origin() -> str:
    """The running server's origin, or T3Error when the runtime file says none is running."""
    try:
        runtime = json.loads(RUNTIME.read_text())
    except FileNotFoundError:
        raise T3Error("not_running", "T3 Code is not running") from None
    except (OSError, ValueError) as e:
        raise T3Error("error", f"T3's runtime file could not be read ({type(e).__name__})") from None
    found = runtime.get("origin") if isinstance(runtime, dict) else None
    pid = runtime.get("pid") if isinstance(runtime, dict) else None
    if not isinstance(found, str) or not found.startswith("http"):
        raise T3Error("error", "T3's runtime file names no server origin")
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            raise T3Error("not_running", "T3 Code is not running") from None
        except PermissionError:
            pass
    return found.rstrip("/")


def issue_session() -> Session:
    """A new read-only MCP client session from T3's CLI. Its stdout carries the token, so
    it is parsed here and never printed; stderr is dropped for the same reason."""
    if not CLI.exists():
        raise T3Error("error", "T3's command line tool is missing; open T3 Code once to install it")
    try:
        r = subprocess.run([str(CLI), "auth", "session", "issue", "--subject", "mcp-client",
                            "--scope", "orchestration:read", "--ttl", SESSION_TTL,
                            "--label", "helm desk", "--json"],
                           capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise T3Error("error", f"T3 could not issue a session ({type(e).__name__})") from None
    if r.returncode != 0:
        raise T3Error("error", f"T3 could not issue a session (exit {r.returncode})")
    try:
        issued = json.loads(r.stdout)
        return Session(str(issued["sessionId"]), str(issued["token"]), time.monotonic())
    except (ValueError, KeyError, TypeError):
        raise T3Error("error", "T3 issued a session in a shape this server does not read") from None


def post(url: str, token: str, body: dict, session_id: str | None) -> tuple[dict, str | None]:
    """One JSON-RPC message to `/mcp`, its parsed answer and the MCP session id it set. A
    401 is `Unauthorized`; a refused connection means T3 is not answering."""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL}
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    req = urllib.request.Request(url, json.dumps(body).encode(), headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            kind = r.headers.get("Content-Type", "")
            raw = r.read().decode("utf-8", "replace")
            sid = r.headers.get("Mcp-Session-Id") or session_id
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Unauthorized() from None
        raise T3Error("error", f"T3 answered HTTP {e.code}") from None
    except (urllib.error.URLError, OSError) as e:
        raise T3Error("unreachable", f"T3 Code is not answering ({type(getattr(e, 'reason', e)).__name__})") from None
    if "event-stream" in kind:
        raw = "\n".join(line[5:].strip() for line in raw.splitlines() if line.startswith("data:"))
    try:
        return json.loads(raw), sid
    except ValueError:
        raise T3Error("error", "T3 answered something that is not JSON") from None


class Client:
    """One MCP conversation with T3, reissuing its session when it ages or is refused."""

    def __init__(self) -> None:
        self.session: Session | None = None
        self.mcp_id: str | None = None
        self.next_id = 0

    def _token(self) -> str:
        if self.session is None or time.monotonic() - self.session.issued > SESSION_REUSE_S:
            self.session = issue_session()
            self.mcp_id = None
        return self.session.token

    def _rpc(self, url: str, method: str, params: dict) -> dict:
        self.next_id += 1
        answer, self.mcp_id = post(url, self._token(), {"jsonrpc": "2.0", "id": self.next_id,
                                                       "method": method, "params": params}, self.mcp_id)
        if "error" in answer:
            raise T3Error("error", f"T3 refused {method} (code {(answer.get('error') or {}).get('code')})")
        return answer.get("result") or {}

    def _open(self, url: str) -> None:
        if self.mcp_id is None:
            self._rpc(url, "initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                          "clientInfo": {"name": "helm-desk", "version": "1"}})

    def tool(self, name: str, arguments: dict) -> dict:
        """A tool's structured result. A refused session is reissued once and the call retried."""
        url = origin() + "/mcp"
        for attempt in (1, 2):
            try:
                self._open(url)
                result = self._rpc(url, "tools/call", {"name": name, "arguments": arguments})
                break
            except Unauthorized:
                self.session = None
                if attempt == 2:
                    raise
        if result.get("isError"):
            raise T3Error("error", f"T3's {name} failed")
        content = result.get("structuredContent")
        if not isinstance(content, dict):
            raise T3Error("error", f"T3's {name} answered no structured result")
        return content


def epoch(text: object) -> float | None:
    """An ISO time as seconds since the epoch, or None when it is not one."""
    if not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def row(thread: dict, projects: dict[str, str]) -> dict:
    return {"id": thread.get("threadId"), "title": thread.get("title") or "Untitled thread",
            "project": projects.get(str(thread.get("projectId")), None),
            "status": thread.get("status"), "updated": thread.get("updatedAt"),
            "created": thread.get("createdAt")}


class Reader:
    """The desk's view of T3, cached for a few seconds. Holds the project names for five
    minutes and each run's start for as long as the process lives."""

    def __init__(self, client: Client | None = None) -> None:
        self.client = client or Client()
        self.lock = threading.Lock()
        self.cached: tuple[float, dict] | None = None
        self.projects: tuple[float, dict[str, str]] | None = None
        self.starts: dict[str, str | None] = {}

    def project_names(self) -> dict[str, str]:
        if self.projects is not None and time.monotonic() - self.projects[0] < PROJECTS_S:
            return self.projects[1]
        names: dict[str, str] = {}
        cursor: int | None = 0
        while cursor is not None and len(names) < 1000:
            page = self.client.tool("t3_project_list", {"cursor": cursor, "limit": 100})
            for p in page.get("projects") or []:
                if isinstance(p, dict) and p.get("id"):
                    names[str(p["id"])] = str(p.get("title") or "")
            cursor = page.get("nextCursor") if isinstance(page.get("nextCursor"), int) else None
        self.projects = (time.monotonic(), names)
        return names

    def started(self, thread: dict) -> str | None:
        """When the thread's current run started, read once per run id. Only ever asked of a
        running or waiting thread, which has no final result a read could mark delivered."""
        run = thread.get("latestRunId")
        if not isinstance(run, str):
            return None
        if run not in self.starts:
            try:
                found = self.client.tool("t3_thread_read", {"threadId": thread["threadId"], "limit": 1,
                                                            "runLimit": 1, "maxCharsPerItem": 1})
            except T3Error:
                return None
            runs = [r for r in found.get("recentRuns") or [] if isinstance(r, dict)]
            mine = next((r for r in runs if r.get("runId") == run), runs[0] if runs else {})
            self.starts[run] = mine.get("startedAt") or mine.get("requestedAt")
            if len(self.starts) > 500:
                self.starts.pop(next(iter(self.starts)))
        return self.starts[run]

    def fresh(self) -> dict:
        projects = self.project_names()
        active = self.client.tool("t3_thread_list", {"allProjects": True, "statuses": [*RUNNING, *WAITING],
                                                     "includeSubagents": False, "limit": ACTIVE_LIMIT})
        done = self.client.tool("t3_thread_list", {"allProjects": True, "statuses": list(FINISHED),
                                                   "includeSubagents": False, "limit": FINISHED_SHOWN})
        running, waiting = [], []
        for t in active.get("threads") or []:
            if not isinstance(t, dict) or not t.get("threadId"):
                continue
            entry = {**row(t, projects), "started": self.started(t)}
            (waiting if t.get("status") in WAITING else running).append(entry)
        # Longest running first, so the one that has run away stays at the top.
        running.sort(key=lambda e: epoch(e["started"]) or epoch(e["created"]) or 0)
        waiting.sort(key=lambda e: epoch(e["updated"]) or 0)
        finished = []
        for t in done.get("threads") or []:
            if isinstance(t, dict) and t.get("threadId"):
                entry = row(t, projects)
                finished.append({**entry, "outcome": OUTCOME.get(str(t.get("status")), "done"),
                                 "finished": entry["updated"]})
        finished.sort(key=lambda e: epoch(e["finished"]) or 0, reverse=True)
        return {"state": "ok", "detail": None, "running": running, "waiting": waiting,
                "finished": finished[:FINISHED_SHOWN]}

    def threads(self) -> dict:
        """The answer of `GET /api/t3/threads`. Never raises: a T3 that cannot be read is a
        `state` and a `detail`, with empty lists."""
        with self.lock:
            now = time.monotonic()
            if self.cached is not None and now - self.cached[0] < CACHE_S:
                return self.cached[1]
            try:
                answer = self.fresh()
            except T3Error as e:
                answer = {"state": e.state, "detail": e.detail, "running": [], "waiting": [], "finished": []}
            except Exception as e:  # noqa: BLE001  the type goes in the log, never the text
                sys.stderr.write(f"t3 threads read failed: {type(e).__name__}\n")
                answer = {"state": "error", "detail": f"reading T3 failed ({type(e).__name__})",
                          "running": [], "waiting": [], "finished": []}
            answer["checked"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            self.cached = (now, answer)
            return answer


READER = Reader()
