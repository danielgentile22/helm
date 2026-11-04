"""Every route the dashboard answers, one row each, with the handler beside it.

The health read, the four tabs' reads, the writes ADR 0038 allows, the page itself, and
the passkey rows from `auth.py`. Projects come from the file capture writes, so a page
load never calls GitHub (ADR 0037); ideas and devices are read from the vault per request;
background asks launchd through `machine.py`. An idea write goes through `idea_edit` and
ends in a vault commit whose subject carries no idea text; a routine write goes through
`control.py`. Alerts are read and dismissed through `runner/alerts.py`, and push
subscriptions kept through `runner/push.py` (ADR 0039). The JSON each returns is documented in `dashboard/README.md`.
"""
from __future__ import annotations

import contextlib
import dataclasses
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator
from urllib.parse import parse_qs

HERE = Path(__file__).resolve().parent
RUNNER = HERE.parents[1] / "runner"
sys.path[:0] = [str(HERE), str(RUNNER), str(RUNNER / "producers")]

import alerts  # noqa: E402
import common  # noqa: E402
import launchd  # noqa: E402
import auth  # noqa: E402
import background  # noqa: E402
import control  # noqa: E402
import devices  # noqa: E402
import idea_edit  # noqa: E402
import machine  # noqa: E402
import push  # noqa: E402
import refresh  # noqa: E402
from app import ApiError, Request, Response, Route, json_response, text_response  # noqa: E402

DIST = common.ENGINE / "dashboard" / "dist"

# The allowlist as well as the lookup. A suffix with no row here is not served, so the
# build stamp, a source map and anything else that lands in dist/ without being asked for
# by the page are all 404. A new kind of asset adds its row and nothing else.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webmanifest": "application/manifest+json",
    ".woff2": "font/woff2",
}

NO_BUILD = ("the dashboard build is missing.\n"
            "run: python3 dashboard/serve.py\n")

SERVICE_LABEL = launchd.PREFIX + "dashboard"


def service_installed() -> bool:
    """Whether the launchd agent is loaded, so the interface can tell a dashboard someone
    started by hand from one the service is keeping up. Replaced in the tests, which must
    not ask the machine they happen to run on."""
    return launchd.is_loaded(SERVICE_LABEL)


def health(request: Request, m: "re.Match[str]") -> Response:
    built = DIST / ".built"
    return json_response({
        "ok": True,
        "now": common.iso(common.utc_now()),
        "reach": request.via,
        "dist_built": common.iso(datetime.fromtimestamp(built.stat().st_mtime, timezone.utc))
        if built.exists() else None,
        "service": {"label": SERVICE_LABEL, "installed": service_installed()},
    })


def static(request: Request, m: "re.Match[str]") -> Response:
    """`dist/`, with `index.html` for any path without a dot so a reload on a client route works.

    Only the suffixes in `CONTENT_TYPES` are served. `dist/` also holds the `.built` stamp,
    and a future build may drop a source map in there, neither of which the page asks for."""
    if not DIST.is_dir():
        return text_response(NO_BUILD, 503)
    rel = request.path.lstrip("/")
    if any(ch < " " or ch == "\x7f" for ch in rel):
        raise ApiError(400, "bad_request", "that path carries a control character")
    if not rel or "." not in rel.rsplit("/", 1)[-1]:
        rel = "index.html"
    root = DIST.resolve()
    target = (root / rel).resolve()
    if not target.is_relative_to(root):
        raise ApiError(403, "forbidden", "that path leaves the build directory")
    content_type = CONTENT_TYPES.get(target.suffix)
    if content_type is None:
        raise ApiError(404, "not_found", f"{rel} is not a kind of file this server hands out; "
                                         "add its suffix to CONTENT_TYPES if the page needs it")
    if not target.is_file():
        if rel == "index.html":
            return text_response(NO_BUILD, 503)
        raise ApiError(404, "not_found", f"no file at {rel}")
    return Response(200, target.read_bytes(), {"Content-Type": content_type, "Cache-Control": "no-cache"})


NO_CAPTURE = "capture has not written projects.json yet; run python3 runner/producers/capture.py"
OLD_CAPTURE = "projects.json has no projects list; it predates this server, so run capture again"
IDEA_STATUSES = (*idea_edit.STATUSES, "all")


def projects_doc() -> tuple[dict, list[dict], str | None]:
    """projects.json, its entries, and what is wrong with it if anything: a source that is
    failing names itself and why, and its last good rows are still served beside it."""
    doc = common.read_json(common.STATUS / "projects.json")
    if doc is None:
        return {}, [], NO_CAPTURE
    entries = doc.get("projects")
    if not isinstance(entries, list):
        return doc, [], OLD_CAPTURE
    failing = [f"{name}: {meta.get('reason') or 'failing'}"
               for name, meta in sorted((doc.get("sources") or {}).items()) if not meta.get("ok")]
    return doc, entries, "; ".join(failing) or None


def summary(entry: dict) -> dict:
    return {k: v for k, v in entry.items() if k != "issues_list"}


def projects_list(request: Request, m: "re.Match[str]") -> Response:
    doc, entries, error = projects_doc()
    return json_response({"produced": doc.get("produced"), "error": error, "refreshing": refresh.running(),
                          "projects": [summary(e) for e in entries]})


def projects_refresh(request: Request, m: "re.Match[str]") -> Response:
    """Rerun every project source now, in the background. A fixed action with no input."""
    refresh.start(refresh.PROJECT_SOURCES)
    return json_response({"refreshing": True}, 202)


def open_ideas(project: str) -> list[dict]:
    ideas, _ = idea_edit.scan(common.VAULT)
    return [i.to_row() for i in sort_ideas(ideas) if i.status == "open" and i.project == project]


def project_detail(request: Request, m: "re.Match[str]") -> Response:
    """One project with its issue list and its open ideas. The ideas are read from the
    vault now rather than from capture, so one thrown in a second ago is already here."""
    doc, entries, error = projects_doc()
    entry = next((e for e in entries if e.get("slug") == m["slug"]), None)
    if entry is None:
        raise ApiError(404, "not_found", error or f"no project with the slug {m['slug']!r}")
    ideas = open_ideas(entry["title"])
    return json_response({"produced": doc.get("produced"), "error": error, "refreshing": refresh.running(),
                          **entry, "ideas_open": len(ideas), "ideas": ideas})


def sort_ideas(ideas: list[idea_edit.Idea]) -> list[idea_edit.Idea]:
    """Soonest due first, undated after, and newest first within each."""
    newest = sorted(ideas, key=lambda i: (i.created, i.id), reverse=True)
    return sorted(newest, key=lambda i: (i.due is None, i.due or ""))


def ideas_list(request: Request, m: "re.Match[str]") -> Response:
    want = (parse_qs(request.query).get("status") or ["open"])[-1]
    if want not in IDEA_STATUSES:
        raise ApiError(400, "bad_request", f"status {want!r} is not one of {', '.join(IDEA_STATUSES)}")
    ideas, errors = idea_edit.scan(common.VAULT)
    picked = [i for i in ideas if want == "all" or i.status == want]
    return json_response({"ideas": [i.to_row() for i in sort_ideas(picked)], "errors": [str(e) for e in errors]})


def registry() -> dict:
    return json.loads((common.ENGINE / "models.json").read_text())


def local_now() -> datetime:
    return datetime.now(common.local_tz(common.load_env()))


def background_tab(request: Request, m: "re.Match[str]") -> Response:
    return json_response(background.assemble(registry(), machine.launchctl_list(), common.STATE, local_now()))


TITLE_MAX = 200
NOTES_MAX = 4000
EDIT_FIELDS = ("title", "notes", "project")
IDEA_FIELDS = ("title", "project", "department", "due")
EDITABLE = ("open", "done", "dropped")


def refresh_capture() -> None:
    """Capture's ideas source, rerun so each project's count of open ideas agrees with the
    write. Best effort: the write is already committed, and the next scheduled capture
    catches up. The log line names the error's type only, since its text could quote a note."""
    try:
        idea_edit.refresh_capture()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"capture refresh after an idea write failed: {type(e).__name__}\n")


def text_field(payload: dict, key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ApiError(400, "bad_request", f"{key} must be a string or null")
    return value.strip() or None


def idea_title(payload: dict) -> str:
    raw = payload.get("title")
    if not isinstance(raw, str):
        raise ApiError(400, "bad_request", "the body needs a title string")
    if any(ch < " " or ch == "\x7f" for ch in raw):
        raise ApiError(400, "bad_request", "a title is one line, with no line breaks or control characters")
    title = " ".join(raw.split())
    if not 1 <= len(title) <= TITLE_MAX:
        raise ApiError(400, "bad_request", f"a title is 1 to {TITLE_MAX} characters, and this one is {len(title)}")
    return title


@contextlib.contextmanager
def vault_write() -> Iterator[None]:
    """The vault write lock, with any OSError answered as a 500 that names its type alone.
    Its message would carry the note's path, which is made from the idea's title, and an
    unanswered exception has its traceback logged."""
    with common.vault_write_lock():
        try:
            yield
        except OSError as e:
            raise ApiError(500, "vault_io", f"the idea note could not be read or written ({type(e).__name__})") from None


def committed(idea: idea_edit.Idea, subject: str, before: str | None) -> None:
    try:
        idea_edit.commit_or_restore(common.VAULT, idea.path, subject, before)
    except idea_edit.IdeaError:
        raise ApiError(500, "vault_commit", "the vault commit failed, so the note was put back as it was")


def idea_add(request: Request, m: "re.Match[str]") -> Response:
    payload = auth.body_of(request)
    unknown = sorted(set(payload) - set(IDEA_FIELDS))
    if unknown:
        raise ApiError(400, "bad_request", f"unknown fields {', '.join(unknown)}; an idea takes {', '.join(IDEA_FIELDS)}")
    title = idea_title(payload)
    project, department, due = (text_field(payload, k) for k in ("project", "department", "due"))
    with vault_write():
        try:
            idea = idea_edit.add(common.VAULT, title, project, department, due)
        except idea_edit.IdeaError as e:
            raise ApiError(400, "bad_request", str(e))
        committed(idea, idea_edit.ADD_SUBJECT, None)
    refresh_capture()
    return json_response({"idea": idea.to_row(), "changed": True}, 201)


def idea_edit_route(idea_id: str, change: "Callable[[Path], tuple[idea_edit.Idea, bool]]",
                    subject: "Callable[[idea_edit.Idea], str]") -> Response:
    """One field of one idea, committed when it changed. The same value twice writes nothing
    and answers 200 with `changed: false`."""
    with vault_write():
        try:
            note = idea_edit.resolve(common.VAULT, idea_id)
        except idea_edit.UnknownIdea:
            raise ApiError(404, "not_found", "no idea note has that id")
        except idea_edit.IdeaError as e:
            raise ApiError(400, "bad_request", str(e))
        before = note.read_text()
        try:
            idea, changed = change(note)
        except idea_edit.IdeaError as e:
            raise ApiError(400, "bad_request", str(e))
        if changed:
            committed(idea, subject(idea), before)
    if changed:
        refresh_capture()
    return json_response({"idea": idea.to_row(), "changed": changed})


def idea_status(request: Request, m: "re.Match[str]") -> Response:
    status = auth.body_of(request).get("status")
    if status not in EDITABLE:
        raise ApiError(400, "bad_request", f"status must be one of {', '.join(EDITABLE)}")

    def change(note: Path) -> tuple[idea_edit.Idea, bool]:
        if idea_edit.load(common.VAULT, note).status == "promoted":
            raise ApiError(409, "conflict", "a promoted idea lives on in its issue; change the issue instead")
        return idea_edit.set_status(common.VAULT, note, status)

    return idea_edit_route(m["id"], change, lambda idea: idea_edit.STATUS_SUBJECTS[idea.status])


def idea_due(request: Request, m: "re.Match[str]") -> Response:
    payload = auth.body_of(request)
    if "due" not in payload:
        raise ApiError(400, "bad_request", 'the body needs "due": a date like 2026-11-15, or null to clear it')
    due = text_field(payload, "due")
    return idea_edit_route(m["id"], lambda note: idea_edit.set_due(common.VAULT, note, due),
                           lambda idea: idea_edit.DUE_SUBJECT)


def idea_notes(payload: dict) -> str:
    """Notes are free text over several lines; null or empty clears them."""
    raw = payload.get("notes")
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise ApiError(400, "bad_request", "notes must be a string or null")
    if any((ch < " " and ch not in "\n\t") or ch == "\x7f" for ch in raw.replace("\r\n", "\n")):
        raise ApiError(400, "bad_request", "notes hold text and line breaks, no other control characters")
    notes = raw.replace("\r\n", "\n").strip()
    if len(notes) > NOTES_MAX:
        raise ApiError(400, "bad_request", f"notes are at most {NOTES_MAX} characters, and these are {len(notes)}")
    return notes


def idea_change(request: Request, m: "re.Match[str]") -> Response:
    """Rewrite what an idea says: any of its title, notes and project. A field left out
    stays as it is; null clears the notes or the project."""
    payload = auth.body_of(request)
    unknown = sorted(set(payload) - set(EDIT_FIELDS))
    if unknown or not payload:
        raise ApiError(400, "bad_request", f"an edit takes any of {', '.join(EDIT_FIELDS)}"
                       + (f", not {', '.join(unknown)}" if unknown else ""))
    title = idea_title(payload) if "title" in payload else None
    notes = idea_notes(payload) if "notes" in payload else None
    project = (text_field(payload, "project") or "") if "project" in payload else None

    def change(note: Path) -> tuple[idea_edit.Idea, bool]:
        if idea_edit.load(common.VAULT, note).status == "promoted":
            raise ApiError(409, "conflict", "a promoted idea lives on in its issue; change the issue instead")
        return idea_edit.edit(common.VAULT, note, title, notes, project)

    return idea_edit_route(m["id"], change, lambda idea: idea_edit.EDIT_SUBJECT)


PROMOTE_FIELDS = ("repo", "confirm")
_login: str | None = None


def github_login() -> str:
    """The GitHub user `gh` is signed in as, asked once per server process."""
    global _login
    if _login is None:
        _login = idea_edit.gh("api", "user", "-q", ".login").strip()
    return _login


class NeedsConfirm(Exception):
    def __init__(self, repo: str) -> None:
        self.repo = repo


def idea_promote(request: Request, m: "re.Match[str]") -> Response:
    """File the idea as an issue in its project's tracker (ADR 0037). An issue on a GitHub repo
    someone else owns is read by other people, so it waits for `confirm: true` (ADR 0038) and
    answers 409 with `needs_confirm` until then. A promoted idea answers its issue again."""
    payload = auth.body_of(request)
    unknown = sorted(set(payload) - set(PROMOTE_FIELDS))
    if unknown:
        raise ApiError(400, "bad_request", f"unknown fields {', '.join(unknown)}; promotion takes repo and confirm")
    confirm = payload.get("confirm", False)
    if not isinstance(confirm, bool):
        raise ApiError(400, "bad_request", "confirm must be true or false")
    repo = text_field(payload, "repo")

    def approve(to: idea_edit.Target) -> None:
        if isinstance(to, idea_edit.GitHubTarget) and not confirm \
                and to.owner.lower() != github_login().lower():
            raise NeedsConfirm(to.repo)

    with vault_write():
        try:
            note = idea_edit.resolve(common.VAULT, m["id"])
        except idea_edit.UnknownIdea:
            raise ApiError(404, "not_found", "no idea note has that id")
        except idea_edit.IdeaError as e:
            raise ApiError(400, "bad_request", str(e))
        try:
            done = idea_edit.promote(common.VAULT, note, repo, approve=approve)
        except NeedsConfirm as e:
            return json_response({"needs_confirm": True, "repo": e.repo, "error": {
                "code": "needs_confirm", "detail": f"{e.repo} is not yours, so other people will read this issue"}}, 409)
        except idea_edit.Unrecorded as e:
            return json_response({"issue": e.issue, "error": {"code": "unrecorded", "detail": str(e)}}, 500)
        except idea_edit.Refused as e:
            raise ApiError(409, "conflict", str(e))
        except idea_edit.TrackerFailed as e:
            raise ApiError(502, "tracker_failed", str(e))
        except idea_edit.IdeaError as e:
            raise ApiError(400, "bad_request", str(e))
    if done.changed:
        refresh_capture()
        # The new issue is in the tracker now; reread that tracker so the project shows it.
        refresh.start(["github"] if done.issue.startswith(("http://", "https://")) else ["projects"])
    return json_response({"idea": done.idea.to_row(), "issue": done.issue, "changed": done.changed})


ROUTINE_ACTIONS = {"run": control.run, "pause": control.pause, "resume": control.resume}


def routine_action(request: Request, m: "re.Match[str]") -> Response:
    """Run now, pause or resume one routine. The name must be a routine in models.json, so
    no text from the request reaches launchctl; a service has no write routes at all."""
    reg = registry()
    name = m["name"]
    spec = (reg.get("routines") or {}).get(name)
    if spec is None:
        what = ("a service, and services are not run or paused from here" if name in (reg.get("services") or {})
                else "not a routine in models.json")
        raise ApiError(404, "not_found", f"{name} is {what}")
    changed = ROUTINE_ACTIONS[m["action"]](launchd.PREFIX + name)
    record = background.routine(name, spec, machine.launchctl_list(), common.STATE, local_now())
    return json_response({"routine": record, "changed": changed})


def alerts_list(request: Request, m: "re.Match[str]") -> Response:
    shown = alerts.visible()
    found = alerts.counts(shown)
    return json_response({"alerts": [dataclasses.asdict(a) for a in shown], "counts": found,
                          "total": sum(found.values())})


def alert_dismiss(request: Request, m: "re.Match[str]") -> Response:
    done = alerts.dismiss(m["key"], common.utc_now())
    if done is None:
        raise ApiError(404, "not_found", "no alert has that key")
    alert, changed = done
    return json_response({"alert": dataclasses.asdict(alert), "changed": changed})


def push_key(request: Request, m: "re.Match[str]") -> Response:
    try:
        return json_response({"key": push.public_key()})
    except push.PushError as e:
        raise ApiError(503, "push_unavailable", str(e))


PUSH_ENDPOINT = re.compile(r"^https://[^\s/]+/\S+$")


def endpoint_of(payload: dict) -> str:
    endpoint = payload.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 1024 or not PUSH_ENDPOINT.match(endpoint):
        raise ApiError(400, "bad_request", "the body needs the subscription's https endpoint")
    return endpoint


def push_subscribe(request: Request, m: "re.Match[str]") -> Response:
    """The browser's `PushSubscription.toJSON()`: an endpoint and its two keys."""
    payload = auth.body_of(request)
    endpoint = endpoint_of(payload)
    keys = payload.get("keys")
    if not (isinstance(keys, dict) and all(isinstance(keys.get(k), str) and 0 < len(keys[k]) <= 256
                                           for k in ("p256dh", "auth"))):
        raise ApiError(400, "bad_request", "the body needs keys.p256dh and keys.auth")
    changed = push.subscribe(endpoint, {"p256dh": keys["p256dh"], "auth": keys["auth"]},
                             alerts.stamp(common.utc_now()))
    return json_response({"changed": changed})


def push_unsubscribe(request: Request, m: "re.Match[str]") -> Response:
    return json_response({"changed": push.unsubscribe([endpoint_of(auth.body_of(request))]) > 0})


def push_test(request: Request, m: "re.Match[str]") -> Response:
    """Loopback only: a way to check the phone's enrollment from the Mac."""
    try:
        sent = push.send("Test notification from helm", "background", len(alerts.visible()))
    except push.PushError as e:
        raise ApiError(502, "push_failed", str(e))
    return json_response(sent)


def devices_tab(request: Request, m: "re.Match[str]") -> Response:
    return json_response(devices.assemble(common.VAULT, machine.tailscale_status(), machine.usage))


ROUTES: tuple[Route, ...] = (
    Route("GET", re.compile(r"^/api/health$"), "tailnet", health),
    Route("GET", re.compile(r"^/api/projects$"), "tailnet", projects_list),
    Route("GET", re.compile(r"^/api/projects/(?P<slug>[a-z0-9-]+)$"), "tailnet", project_detail),
    Route("POST", re.compile(r"^/api/projects/refresh$"), "tailnet", projects_refresh),
    Route("GET", re.compile(r"^/api/ideas$"), "tailnet", ideas_list),
    Route("GET", re.compile(r"^/api/background$"), "tailnet", background_tab),
    Route("GET", re.compile(r"^/api/devices$"), "tailnet", devices_tab),
    Route("POST", re.compile(r"^/api/ideas$"), "tailnet", idea_add),
    Route("POST", re.compile(r"^/api/ideas/(?P<id>\d{4}-\d\d-\d\d-[a-z0-9-]+)/status$"), "tailnet", idea_status),
    Route("POST", re.compile(r"^/api/ideas/(?P<id>\d{4}-\d\d-\d\d-[a-z0-9-]+)/due$"), "tailnet", idea_due),
    Route("POST", re.compile(r"^/api/ideas/(?P<id>\d{4}-\d\d-\d\d-[a-z0-9-]+)/promote$"), "tailnet", idea_promote),
    Route("POST", re.compile(r"^/api/ideas/(?P<id>\d{4}-\d\d-\d\d-[a-z0-9-]+)/edit$"), "tailnet", idea_change),
    Route("POST", re.compile(r"^/api/routines/(?P<name>[a-z0-9-]+)/(?P<action>run|pause|resume)$"), "tailnet",
          routine_action),
    Route("GET", re.compile(r"^/api/alerts$"), "tailnet", alerts_list),
    Route("POST", re.compile(r"^/api/alerts/(?P<key>[^/]+)/dismiss$"), "tailnet", alert_dismiss),
    Route("GET", re.compile(r"^/api/push/key$"), "tailnet", push_key),
    Route("POST", re.compile(r"^/api/push/subscribe$"), "tailnet", push_subscribe),
    Route("POST", re.compile(r"^/api/push/unsubscribe$"), "tailnet", push_unsubscribe),
    Route("POST", re.compile(r"^/api/push/test$"), "loopback", push_test),
    # The page and its assets are open: a phone with no session yet has to load the shell to
    # sign in. Everything the page then reads sits behind the gate.
    Route("GET", re.compile(r"^/(?!api/|auth/).*$"), "open", static),
)


def table(origin: "auth.Origin | None") -> tuple[Route, ...]:
    """The full table: the rows above plus the passkey rows when a tailnet name is configured.
    With no name there is no door, so the ceremony has no reason to exist and no origin to
    verify against. The page still asks `/auth/me` before it draws anything, so that one
    row stays and says what is true without a door: every visitor is on loopback, and in."""
    if origin is None:
        return ROUTES + (Route("GET", re.compile(r"^/auth/me$"), "open", loopback_me),)
    return ROUTES + auth.routes(origin)


def loopback_me(request: Request, m: "re.Match[str]") -> Response:
    return json_response({"via": "loopback", "authenticated": True, "enrolled": False})
