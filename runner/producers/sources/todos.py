"""Todos: open checkboxes on the four department notes, with their kind, their
directive, their notes and their subtasks.

The syntax, on `Vault/Atlas/<D>/<D>.md` under `## Todos`:

    ## Todos

    ### Job search                              <- a directive: the todos below belong to it
    - [ ] tailor resume for the Acme posting (due: 2026-09-18)
      Two pages. Lead with the route rebuild.   <- an indented line is a note
      - [ ] read the PDF once                   <- an indented box is a subtask
      - [x] run resume-tailor
    - [ ] apply to one role (daily) (done: 2026-09-22)
    - [ ] coaching session (at: 2026-09-24 19:00)
    - [ ] merge the feature branch done-when: pr merged example/repo#14

    ### Day job ★2                               <- a starred directive, ranked 1 to 3
    ### unfiled todos sit before the first ### heading, or under any other ## heading

Three kinds. A plain box is a `todo`, due at 17:00 on its `(due:)` day or undated.
`(daily)` is a `daily`: it is never ticked, `(done: YYYY-MM-DD)` says the last day it
was done, and it is done today when that is today. `(at: YYYY-MM-DD HH:MM)` is an
`event`, at that moment. Markers may sit anywhere in the text. `done-when:` must be
the tail. Age needs no date: the vault is a git repo, so the oldest commit whose diff
carries the line says when it appeared (`git log -S<line>`), falling back to the note's
mtime for an uncommitted line.

Row contract:

    {"kind": "todo" | "daily" | "event", "source": "todos", "id": content_id(note path, text),
     "dept": Department, "project": str | None (the ### heading above it under ## Todos),
     "star": 1 | 2 | 3 | None (that heading's rank, which is not part of its name),
     "text": str (line minus checkbox and every marker),
     "due": "YYYY-MM-DD" | None, "at": ISO | None (due at 17:00 local, or the event moment),
     "done_on": "YYYY-MM-DD" | None (daily only), "done_today": bool (daily only, else false),
     "notes": str (the indented note lines, joined by newlines),
     "subs": [{"text": str, "done": bool}],
     "since": ISO of the adding commit or the file mtime,
     "path": "Vault/Atlas/<D>/<D>.md", "line": int (1-based),
     "done_when": {"predicate": str, "ok": bool | None, "checked": ISO, "detail": str} | None}

A starred directive is also reported on its own, whether or not any todo sits under it, so
a first priority with nothing queued is still on the map (ADR 0020). One row per starred
`###` heading under `## Todos`, in the same list as the todos; capture lifts these out of
`items` into agenda.json's top-level `directives`:

    {"kind": "directive", "source": "todos", "dept": Department,
     "name": str (the heading minus its star), "star": 1 | 2 | 3,
     "path": "Vault/Atlas/<D>/<D>.md", "line": int (1-based, the heading's line)}

It has no `id` and no `text`: it is not a todo, and nothing may tick or edit it.

Predicates are a table of (regex, checker). A checker that cannot run (gh down, path
missing) returns ok None, and the row then keeps the prior result from the cached
source file so a known true never flips to unknown. The producer never writes into
the vault; a true predicate is reported, not ticked (ADR 0007).

    pr merged <owner/repo>#<n>      gh pr view --json state; MERGED
    tree clean <path>               git status --porcelain empty
    metric <name> >= <value>        last row for <name> in ~/.helm/metrics/metrics.csv
    file exists <path>              Path(expanduser).exists()
"""
from __future__ import annotations

import csv
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable

import common

TODO_LINE = re.compile(r"^(?P<indent>\s*)- \[ \] (?P<body>.+?)\s*$")
SUB_LINE = re.compile(r"^\s+- \[(?P<state>[ x])\] (?P<body>.+?)\s*$")
HEADING = re.compile(r"^(?P<level>#{2,3}) (?P<title>.+?)\s*$")
DUE = re.compile(r"\s*\(due:\s*(?P<date>\d{4}-\d{2}-\d{2})\)")
AT = re.compile(r"\s*\(at:\s*(?P<stamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)")
DAILY = re.compile(r"\s*\(daily\)")
DONE_ON = re.compile(r"\s*\(done:\s*(?P<date>\d{4}-\d{2}-\d{2})\)")
DONE_WHEN = re.compile(r"\s+done-when:\s*(?P<pred>.+)$")
TODOS_HEADING = "Todos"
STAR = re.compile(r"\s+★(?P<rank>[123])$")

Checker = Callable[[re.Match[str], dict[str, str]], tuple[bool | None, str]]

DUE_HOUR = 17
SUBPROCESS_TIMEOUT_S = 20


def _run(argv: list[str]) -> tuple[int, str, str]:
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {SUBPROCESS_TIMEOUT_S}s"
    except OSError as e:
        return 127, "", str(e)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def _pr_merged(m: re.Match[str], env: dict[str, str]) -> tuple[bool | None, str]:
    repo, num = m.group("repo"), m.group("num")
    rc, out, err = _run(["gh", "pr", "view", num, "-R", repo, "--json", "state", "--jq", ".state"])
    if rc != 0 or not out:
        return None, f"gh pr view {repo}#{num}: {err or 'no state'}"
    return out.upper() == "MERGED", f"{repo}#{num} is {out.upper()}"


def _tree_clean(m: re.Match[str], env: dict[str, str]) -> tuple[bool | None, str]:
    path = Path(m.group("path")).expanduser()
    if not (path / ".git").exists():
        return None, f"{path} is not a git repo"
    rc, out, err = _run(["git", "-C", str(path), "status", "--porcelain"])
    if rc != 0:
        return None, f"git status {path}: {err or rc}"
    return not out, "clean" if not out else f"{len(out.splitlines())} changed paths"


def _metric_at_least(m: re.Match[str], env: dict[str, str]) -> tuple[bool | None, str]:
    name, want = m.group("name"), float(m.group("value"))
    csv_path = common.STATE / "metrics" / "metrics.csv"
    latest = None
    try:
        with csv_path.open(newline="") as f:
            for row in csv.DictReader(f):
                if row.get("metric") == name:
                    latest = row
    except OSError as e:
        return None, f"metrics.csv unreadable ({e})"
    if latest is None:
        return None, f"no reading for {name}"
    try:
        value = float(latest["value"])
    except (KeyError, TypeError, ValueError):
        return None, f"{name} has no numeric value"
    return value >= want, f"{name}={latest['value']} at {latest.get('timestamp', '?')}, want >= {m.group('value')}"


def _file_exists(m: re.Match[str], env: dict[str, str]) -> tuple[bool | None, str]:
    path = Path(m.group("path")).expanduser()
    return path.exists(), str(path)


PREDICATES: list[tuple[re.Pattern[str], Checker]] = [
    (re.compile(r"^pr merged (?P<repo>[\w.-]+/[\w.-]+)#(?P<num>\d+)$"), _pr_merged),
    (re.compile(r"^tree clean (?P<path>\S+)$"), _tree_clean),
    (re.compile(r"^metric (?P<name>\S+) >= (?P<value>-?\d+(?:\.\d+)?)$"), _metric_at_least),
    (re.compile(r"^file exists (?P<path>\S+)$"), _file_exists),
]


@dataclass(frozen=True)
class ParsedTodo:
    text: str
    kind: str
    due: str | None
    at: str | None
    done_on: str | None
    predicate: str | None


def _take(pattern: re.Pattern[str], body: str, group: str | None) -> tuple[str, str | None]:
    hit = pattern.search(body)
    if not hit:
        return body, None
    return body[:hit.start()] + body[hit.end():], (hit.group(group) if group else "")


def parse_todo_line(line: str) -> ParsedTodo | None:
    """Pure. None when the line is not an open checkbox. Markers come off in a fixed
    order and the text is what is left, so the same todo written with its markers in
    any order has one content id."""
    m = TODO_LINE.match(line)
    if not m:
        return None
    body = m.group("body")
    predicate = None
    tail = DONE_WHEN.search(body)
    if tail:
        predicate = tail.group("pred").strip()
        body = body[:tail.start()]
    body, due = _take(DUE, body, "date")
    body, at = _take(AT, body, "stamp")
    body, daily = _take(DAILY, body, None)
    body, done_on = _take(DONE_ON, body, "date")
    text = " ".join(body.split())
    if not text:
        return None
    kind = "event" if at else "daily" if daily is not None else "todo"
    return ParsedTodo(text=text, kind=kind, due=due if kind == "todo" else None,
                      at=at if kind == "event" else None,
                      done_on=done_on if kind == "daily" else None, predicate=predicate)


@dataclass(frozen=True)
class Block:
    """A todo line with what is indented under it: notes and subtasks."""
    number: int
    raw: str
    parsed: ParsedTodo
    project: str | None
    star: int | None
    notes: str
    subs: tuple[dict, ...]


def directive_heading(title: str) -> tuple[str, int | None]:
    """Pure. A ### title as its directive's name and star rank (ADR 0007, ADR 0020):
    `Job search ★1` is the directive Job search, starred first. Every lookup by name goes
    through here, so starring a heading never makes it a different directive."""
    m = STAR.search(title)
    return (title[:m.start()], int(m.group("rank"))) if m else (title, None)


def parse_note(text: str) -> list[Block]:
    """Pure. Every open box in the note, with its directive (the ### heading above it,
    only while inside ## Todos) and the indented lines beneath it."""
    lines = text.splitlines()
    blocks: list[Block] = []
    section: str | None = None
    project: str | None = None
    star: int | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        h = HEADING.match(line)
        if h:
            if h.group("level") == "##":
                section = h.group("title")
                project, star = None, None
            elif section == TODOS_HEADING:
                project, star = directive_heading(h.group("title"))
            i += 1
            continue
        parsed = parse_todo_line(line) if not line[:1].isspace() else None
        if parsed is None:
            i += 1
            continue
        number = i + 1
        notes: list[str] = []
        subs: list[dict] = []
        j = i + 1
        while j < len(lines) and lines[j][:1].isspace():
            sub = SUB_LINE.match(lines[j])
            if sub:
                subs.append({"text": " ".join(sub.group("body").split()), "done": sub.group("state") == "x"})
            elif lines[j].strip():
                notes.append(lines[j].strip())
            j += 1
        blocks.append(Block(number=number, raw=line, parsed=parsed, project=project,
                            star=star, notes="\n".join(notes), subs=tuple(subs)))
        i = j
    return blocks


@dataclass(frozen=True)
class Starred:
    """A starred ### heading under ## Todos: its name, its rank and its 1-based line."""
    name: str
    star: int
    line: int


def starred_headings(text: str) -> list[Starred]:
    """Pure. Every starred directive heading inside ## Todos, in note order, whether or not
    any todo sits under it. An unstarred heading is not reported: it only exists through
    its todos."""
    out: list[Starred] = []
    section: str | None = None
    for number, line in enumerate(text.splitlines(), start=1):
        h = HEADING.match(line)
        if not h:
            continue
        if h.group("level") == "##":
            section = h.group("title")
        elif section == TODOS_HEADING:
            name, star = directive_heading(h.group("title"))
            if star is not None:
                out.append(Starred(name=name, star=star, line=number))
    return out


def check_predicate(text: str, env: dict[str, str], now: datetime, prior: dict | None) -> dict:
    """First matching pattern runs. No match: ok None, detail 'unknown predicate'."""
    ok: bool | None = None
    detail = "unknown predicate"
    for pattern, checker in PREDICATES:
        m = pattern.match(text)
        if m:
            ok, detail = checker(m, env)
            break
    result = {"predicate": text, "ok": ok, "checked": common.iso(now), "detail": detail}
    if ok is None and prior and prior.get("ok") is not None:
        result["ok"] = prior["ok"]
        result["checked"] = prior.get("checked", result["checked"])
        result["detail"] = f"{detail}; kept the prior result"
    return result


def _since(note: Path, raw_line: str, now: datetime) -> str:
    """The commit that added this line: the oldest one whose diff of the note carries it.
    No diff filter, since `--diff-filter=A` would only ever match the commit that created
    the note, which never carries a line added later, and every todo then fell back to the
    note's mtime and read as new. Uncommitted lines still fall back to the mtime, so a todo
    written a minute ago has an age. The pathspec is relative to the vault, which is its
    own git repo."""
    rc, out, _ = _run(["git", "-C", str(common.VAULT), "log", "-S", raw_line.strip(),
                       "--format=%cI", "--", str(note.relative_to(common.VAULT))])
    stamps = out.split() if rc == 0 else []
    if stamps:
        try:
            return common.iso(datetime.fromisoformat(stamps[-1]).astimezone(now.tzinfo))
        except ValueError:
            pass
    return common.iso(datetime.fromtimestamp(note.stat().st_mtime, now.tzinfo))


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    prior_by_id = {r.get("id"): r.get("done_when")
                   for r in (common.cached("todos") or {}).get("items", [])}
    today = now.strftime("%Y-%m-%d")
    rows: list[dict] = []
    for dept in common.DEPARTMENTS:
        rel = f"Vault/Atlas/{dept}/{dept}.md"
        note = common.VAULT / "Atlas" / dept / f"{dept}.md"
        if not note.exists():
            continue
        text = note.read_text()
        for heading in starred_headings(text):
            rows.append({"kind": "directive", "source": "todos", "dept": dept, "name": heading.name,
                         "star": heading.star, "path": rel, "line": heading.line})
        for block in parse_note(text):
            parsed = block.parsed
            row_id = common.content_id(rel, parsed.text)
            at = None
            if parsed.due:
                day = datetime.strptime(parsed.due, "%Y-%m-%d")
                at = common.iso(day.replace(hour=DUE_HOUR, tzinfo=now.tzinfo))
            if parsed.at:
                at = common.iso(datetime.strptime(parsed.at, "%Y-%m-%d %H:%M").replace(tzinfo=now.tzinfo))
            rows.append({
                "kind": parsed.kind,
                "source": "todos",
                "id": row_id,
                "dept": dept,
                "project": block.project,
                "star": block.star,
                "text": parsed.text,
                "due": parsed.due,
                "at": at,
                "done_on": parsed.done_on,
                "done_today": parsed.kind == "daily" and parsed.done_on == today,
                "notes": block.notes,
                "subs": list(block.subs),
                "since": _since(note, block.raw, now),
                "path": rel,
                "line": block.number,
                "done_when": (check_predicate(parsed.predicate, env, now, prior_by_id.get(row_id))
                              if parsed.predicate else None),
            })
    return rows
