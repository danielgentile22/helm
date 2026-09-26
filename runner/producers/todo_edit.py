#!/usr/bin/env python3
"""Every write anything makes into a department note's todos: add a line, tick a box,
reword or reschedule or refile one, annotate one.

The `update-vault` skill, the `voice-todo` skill, and the dashboard's toggle endpoint
all come through here.
The vault is its own git repo, so every write ends in a commit there with explicit
paths, and `since` on the resulting row comes from that commit (sources/todos.py).

    todo_edit.py add <Dept> "<text>" [--project "<directive>"] [--due YYYY-MM-DD]
                                     [--daily | --at "YYYY-MM-DD HH:MM"] [--done-when "<predicate>"]
    todo_edit.py tick <id>            flip `[ ]` to `[x]` on the line with that content id;
                                      a daily is never ticked, it gets `(done: today)` instead
    todo_edit.py untick <id>          the reverse, for a misclick
    todo_edit.py edit <id> [--text "<new text>"] [--due YYYY-MM-DD | --daily | --at "<stamp>" | --undated]
                           [--project "<directive>" | --unfile]
                                      rewrite the named fields and leave the others as they are;
                                      --project moves the whole block, notes and subtasks with it
    todo_edit.py note <id> "<line>" [--sub]
                                      append an indented note under the todo, or a subtask box

Each prints the todo row as `capture.py --only todos --print` shows it (a ticked row
prints the line instead, since a ticked box is no longer a todo row) and re-merges
`~/.helm/status/agenda.json` so the dashboard agrees at once. A predicate is
validated against the four known shapes before anything is written. Nothing here
addresses a line by path from a caller: the id is the address, and the path is
whatever note the id resolves to (ADR 0015), which is also why `add` and `edit` refuse a
text that is already a box on that note. A todo's block is the line plus the lines
indented under it, delimited the way `sources/todos.parse_note` delimits them.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
from sources import todos  # noqa: E402

BOX = re.compile(r"^(?P<indent>\s*)- \[(?P<state>[ x])\] (?P<body>.+?)\s*$")
TODOS_HEADING = "## Todos"


class TodoEditError(Exception):
    pass


class UnknownTodo(TodoEditError):
    """No box on any department note has this content id. Its own type so the dashboard can
    answer 404 for it and 422 for a write the note refused."""


# The one flock this CLI, the dashboard server and the todos source all hold.
vault_write_lock = common.vault_write_lock


def write_note(note: Path, text: str) -> None:
    """Temp file beside the note, then os.replace, the way common.write_json does it. A killed
    toggle thread can otherwise leave a department note truncated, and the vault has no remote."""
    tmp = note.with_name(f"{note.name}.{os.getpid()}.tmp")
    tmp.write_text(text)
    os.replace(tmp, note)


def rel_for(note: Path) -> str:
    """The path a content id is hashed over. Always `Vault/Atlas/<D>/<D>.md`, spelled the way
    sources/todos spells it, so the ids hold when HELM_VAULT_ROOT points the vault at a copy."""
    return f"Vault/Atlas/{note.stem}/{note.name}"


def note_for(dept: str) -> Path:
    if dept not in common.DEPARTMENTS:
        raise TodoEditError(f"unknown department {dept!r}, want one of {', '.join(common.DEPARTMENTS)}")
    return common.VAULT / "Atlas" / dept / f"{dept}.md"


def stamp(value: str, shape: str) -> None:
    """A date or a moment that does not parse is the caller's mistake, raised as one."""
    try:
        datetime.strptime(value, shape)
    except ValueError:
        want = "a date like 2026-09-30" if shape == "%Y-%m-%d" else "a day and time like 2026-09-30 19:00"
        raise TodoEditError(f"{value} is not a real date; it needs {want}") from None


def format_line(text: str, due: str | None, predicate: str | None, daily: bool = False,
                at: str | None = None, done_on: str | None = None) -> str:
    line = f"- [ ] {' '.join(text.split())}"
    if sum([bool(due), daily, bool(at)]) > 1:
        raise TodoEditError("a todo is dated, daily, or an event, never two of those")
    if due:
        stamp(due, "%Y-%m-%d")
        line += f" (due: {due})"
    if daily:
        line += " (daily)"
    if at:
        stamp(at, "%Y-%m-%d %H:%M")
        line += f" (at: {at})"
    if done_on:
        datetime.strptime(done_on, "%Y-%m-%d")
        line += f" (done: {done_on})"
    if predicate:
        if not any(p.match(predicate) for p, _ in todos.PREDICATES):
            shapes = ", ".join(p.pattern for p, _ in todos.PREDICATES)
            raise TodoEditError(f"predicate {predicate!r} matches none of: {shapes}")
        line += f" done-when: {predicate}"
    if todos.parse_todo_line(line) is None:
        raise TodoEditError(f"line does not parse as a todo: {line!r}")
    return line


def box_text(line: str) -> str | None:
    """The todo text of a checkbox line, ticked or not. None when the line is not a box."""
    m = BOX.match(line)
    if not m:
        return None
    parsed = todos.parse_todo_line(m.group("indent") + "- [ ] " + m.group("body"))
    return parsed.text if parsed else None


def refuse_duplicate(note: Path, lines: list[str], text: str, skip: int | None = None) -> None:
    """Two boxes with the same text in one note would share one content id, and the id is the
    address: `locate` would only ever reach the first, so the second could never be ticked
    from the dashboard and ticking the first would look like it moved.

    `skip` is the 0-based index of the line being rewritten, which is never its own duplicate."""
    for number, line in enumerate(lines, 1):
        if number - 1 != skip and box_text(line) == text:
            raise TodoEditError(f"{note.name} line {number} already has this todo: {line.strip()!r}. "
                                "Two boxes with the same text share one content id, so the second "
                                "could never be addressed. Reword it, or tick the one that is there.")


def heading_name(line: str) -> str | None:
    """The directive a `### ` line names, star and all stripped, or None for any other line."""
    h = todos.HEADING.match(line.strip())
    return todos.directive_heading(h.group("title"))[0] if h and h.group("level") == "###" else None


def insert_block(lines: list[str], project: str | None, block: list[str]) -> list[str]:
    """The note with `block` placed under `## Todos`, creating the heading before `## Not here`
    when absent. With a project, under that `### <project>` heading inside Todos, creating it at
    the end of the section when absent. Without one, before the first ### heading, so the todo
    stays unfiled rather than falling into whichever directive is last.

    `add` places one line this way and `edit` places a whole block, so both come through here."""
    lines = list(lines)
    try:
        start = lines.index(TODOS_HEADING)
    except ValueError:
        anchor = next((i for i, l in enumerate(lines) if l.startswith("## Not here")), len(lines))
        head = [TODOS_HEADING, ""] if project is None else [TODOS_HEADING, "", f"### {project}", ""]
        lines[anchor:anchor] = head + block + [""]
        return lines
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    if project is None:
        stop = next((i for i in range(start + 1, end) if lines[i].startswith("### ")), end)
    else:
        head_at = next((i for i in range(start + 1, end) if heading_name(lines[i]) == project), None)
        if head_at is None:
            while end > start + 1 and not lines[end - 1].strip():
                end -= 1
            lines[end:end] = ["", f"### {project}", ""] + block
            tail = end + 3 + len(block)
            if tail < len(lines) and lines[tail].strip():
                lines.insert(tail, "")
            return lines
        start = head_at
        stop = next((i for i in range(head_at + 1, end) if lines[i].startswith("### ")), end)
    last_box = max((i for i in range(start, stop) if BOX.match(lines[i]) and not lines[i][:1].isspace()), default=None)
    if last_box is not None:
        at_line = last_box + 1
        while at_line < stop and lines[at_line][:1].isspace():
            at_line += 1
    else:
        at_line = start + 2
        if start + 1 >= len(lines) or lines[start + 1].strip():
            lines.insert(start + 1, "")
    lines[at_line:at_line] = block
    return lines


def add(dept: str, text: str, due: str | None, predicate: str | None,
        project: str | None = None, daily: bool = False, at: str | None = None) -> tuple[Path, str]:
    """Append a new todo to the department note. Placement is `insert_block`."""
    note = note_for(dept)
    line = format_line(text, due, predicate, daily, at)
    lines = note.read_text().splitlines()
    refuse_duplicate(note, lines, todos.parse_todo_line(line).text)
    write_note(note, "\n".join(insert_block(lines, project, [line])) + "\n")
    return note, line


def locate(row_id: str) -> tuple[Path, int, re.Match[str], list[str]]:
    """The note, the 0-based index of the line whose content id is `row_id` (ticked or not),
    the box match, and the lines exactly as they were read.

    The lines come back with the index because the caller rewrites the file from them. Reading
    the note a second time would leave a window in which anything else, Obsidian included,
    moves the line, and the index would then point at a different row."""
    for dept in common.DEPARTMENTS:
        note = note_for(dept)
        if not note.exists():
            continue
        rel = rel_for(note)
        lines = note.read_text().splitlines()
        for i, raw in enumerate(lines):
            m = BOX.match(raw)
            if not m:
                continue
            parsed = todos.parse_todo_line(m.group("indent") + "- [ ] " + m.group("body"))
            if parsed and common.content_id(rel, parsed.text) == row_id:
                return note, i, m, lines
    raise UnknownTodo(f"no todo with id {row_id}")


def set_done(row_id: str, done: bool, today: str | None = None) -> tuple[Path, str, bool]:
    """Flip the box. Returns (note, new line, changed). Idempotent: a box already in the
    requested state is left alone and reported as unchanged. A daily is never ticked:
    done writes `(done: today)` on the line and undone takes it off, so tomorrow the
    same line is open again without anything resetting it."""
    note, i, m, lines = locate(row_id)
    parsed = todos.parse_todo_line(f"- [ ] {m.group('body')}")
    if parsed and parsed.kind == "daily":
        today = today or datetime.now().strftime("%Y-%m-%d")
        if (parsed.done_on == today) == done:
            return note, lines[i], False
        body = todos.DONE_ON.sub("", m.group("body")).rstrip()
        if done:
            body += f" (done: {today})"
        lines[i] = f"{m.group('indent')}- [ ] {body}"
        write_note(note, "\n".join(lines) + "\n")
        return note, lines[i], True
    want = "x" if done else " "
    if m.group("state") == want:
        return note, lines[i], False
    lines[i] = f"{m.group('indent')}- [{want}] {m.group('body')}"
    write_note(note, "\n".join(lines) + "\n")
    return note, lines[i], True


def block_end(lines: list[str], index: int) -> int:
    """One past the last line of the todo's block: the line plus the notes and subtasks
    indented under it, delimited the way sources/todos.parse_note delimits them."""
    end = index + 1
    while end < len(lines) and lines[end][:1].isspace():
        end += 1
    return end


def directive_at(lines: list[str], index: int) -> str | None:
    """The `### <directive>` heading a line sits under, None when it is unfiled. Only headings
    inside `## Todos` count, which is what sources/todos.parse_note reports as `project`."""
    section: str | None = None
    directive: str | None = None
    for line in lines[:index]:
        h = todos.HEADING.match(line)
        if not h:
            continue
        if h.group("level") == "##":
            section, directive = h.group("title"), None
        elif section == todos.TODOS_HEADING:
            directive = todos.directive_heading(h.group("title"))[0]
    return directive


@dataclass(frozen=True)
class Schedule:
    """When a todo is due, as one value, so `edit` cannot be asked for a todo that is both
    dated and daily. `kind` is a todos.ParsedTodo kind and `value` is its marker: a date for
    a todo (None for an undated one), a stamp for an event, nothing for a daily."""
    kind: str = "todo"
    value: str | None = None


# A directive of None means unfiled, so "leave this todo where it is" needs a third value.
KEEP = object()


def edit(row_id: str, text: str | None = None, schedule: Schedule | None = None,
         project: str | None | object = KEEP) -> tuple[Path, str, bool, str]:
    """Rewrite the named fields of one todo and leave the others as they are. Returns
    (note, new line, changed, new text). The `done-when:` tail and a daily's `(done: ...)`
    are carried over untouched. A new directive moves the whole block, notes and subtasks
    with it. Idempotent: the same values in every field write nothing and report changed
    false. The content id is over the text alone, so only `text` gives the todo a new one."""
    note, i, m, lines = locate(row_id)
    parsed = todos.parse_todo_line(f"- [ ] {m.group('body')}")
    if parsed is None:
        raise TodoEditError(f"{note.name} line {i + 1} is not a todo: {lines[i].strip()!r}")
    new_text = " ".join(text.split()) if text else parsed.text
    if new_text != parsed.text:
        refuse_duplicate(note, lines, new_text, skip=i)
    if schedule is None:
        schedule = Schedule(parsed.kind, parsed.due or parsed.at)
    body = format_line(new_text, schedule.value if schedule.kind == "todo" else None, parsed.predicate,
                       schedule.kind == "daily", schedule.value if schedule.kind == "event" else None,
                       parsed.done_on if schedule.kind == "daily" else None)
    new_line = f"{m.group('indent')}- [{m.group('state')}] {body.removeprefix('- [ ] ')}"
    was = directive_at(lines, i)
    where = was if project is KEEP else project
    if new_line == lines[i] and where == was:
        return note, lines[i], False, new_text
    end = block_end(lines, i)
    block = [new_line] + lines[i + 1:end]
    if where == was:
        lines[i:end] = block
    else:
        del lines[i:end]
        if 0 < i < len(lines) and not lines[i - 1].strip() and not lines[i].strip():
            del lines[i]
        lines = insert_block(lines, where, block)  # type: ignore[arg-type]
    write_note(note, "\n".join(lines) + "\n")
    return note, new_line, True, new_text


def child_key(line: str) -> tuple[bool, str]:
    """What makes two lines under a todo the same line. A ticked subtask and an open one with
    the same text are the same subtask, so a `--sub` that is already there is still refused."""
    sub = todos.SUB_LINE.match(line)
    return (True, " ".join(sub.group("body").split())) if sub else (False, " ".join(line.split()))


def annotate(row_id: str, text: str, sub: bool = False) -> tuple[Path, str, str]:
    """Append an indented line under the todo, after the notes and subtasks it already has.
    Returns (note, the line written, the todo's text)."""
    note, i, m, lines = locate(row_id)
    parsed = todos.parse_todo_line(f"- [ ] {m.group('body')}")
    if parsed is None:
        raise TodoEditError(f"{note.name} line {i + 1} is not a todo: {lines[i].strip()!r}")
    body = " ".join(text.split())
    if not body:
        raise TodoEditError("a note needs some text")
    line = f"  - [ ] {body}" if sub else f"  {body}"
    end = block_end(lines, i)
    for existing in lines[i + 1:end]:
        if child_key(existing) == child_key(line):
            raise TodoEditError(f"{note.name} line {i + 1} already has this line under it: {existing.strip()!r}")
    lines.insert(end, line)
    write_note(note, "\n".join(lines) + "\n")
    return note, line, parsed.text


def edit_message(note: Path, text: str) -> str:
    return f"Edit a {note.stem} todo: {text}"


def note_message(note: Path, text: str, sub: bool) -> str:
    return f"{'Add a subtask to' if sub else 'Note on'} a {note.stem} todo: {text}"


def message_for(note: Path, line: str, done: bool) -> str:
    """The commit subject for a tick or an untick. The CLI below and the dashboard's toggle
    endpoint both use it, so the vault's history reads the same whoever flipped the box.

    The box comes off through BOX rather than a string replace, so a todo whose own text
    contains `[x]` keeps its text."""
    m = BOX.match(line)
    body = m.group("body") if m else line
    text = todos.parse_todo_line(f"- [ ] {body}").text
    return f"{'Tick' if done else 'Untick'} a {note.stem} todo: {text}"


def commit(note: Path, message: str) -> str:
    rel = str(note.relative_to(common.VAULT))
    for argv in (["git", "-C", str(common.VAULT), "add", "--", rel],
                 ["git", "-C", str(common.VAULT), "commit", "-q", "-m", message, "--", rel]):
        r = subprocess.run(argv, capture_output=True, text=True)
        if r.returncode != 0:
            raise TodoEditError(f"{' '.join(argv[3:5])} failed: {r.stderr.strip() or r.stdout.strip()}")
    return subprocess.run(["git", "-C", str(common.VAULT), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()


def row_for(row_id: str) -> dict | None:
    env = common.load_env()
    now = datetime.now(common.local_tz(env))
    # collect() also reports starred directive headings, which are not todos and carry no id.
    return next((r for r in todos.collect(env, now) if r.get("id") == row_id), None)


def run(args: argparse.Namespace) -> dict:
    if args.cmd == "add":
        note, line = add(args.dept, args.text, args.due, args.predicate, args.project, args.daily, args.at)
        text = todos.parse_todo_line(line).text
        sha = None if args.no_commit else commit(note, f"Add a {args.dept} todo: {text}")
        row_id = common.content_id(rel_for(note), text)
        return {"commit": sha, "line": line, "row": row_for(row_id)}
    if args.cmd == "edit":
        schedule = None
        if args.undated:
            schedule = Schedule("todo")
        elif args.due:
            schedule = Schedule("todo", args.due)
        elif args.daily:
            schedule = Schedule("daily")
        elif args.at:
            schedule = Schedule("event", args.at)
        project = None if args.unfile else KEEP if args.project is None else args.project
        note, line, changed, text = edit(args.id, args.text, schedule, project)
        sha = commit(note, edit_message(note, text)) if changed and not args.no_commit else None
        row_id = common.content_id(rel_for(note), text)
        return {"commit": sha, "changed": changed, "line": line, "row": row_for(row_id)}
    if args.cmd == "note":
        note, line, text = annotate(args.id, args.text, args.sub)
        sha = None if args.no_commit else commit(note, note_message(note, text, args.sub))
        return {"commit": sha, "changed": True, "line": line, "row": row_for(args.id)}
    done = args.cmd == "tick"
    note, line, changed = set_done(args.id, done)
    sha = None
    if changed and not args.no_commit:
        sha = commit(note, message_for(note, line, done))
    parsed = todos.parse_todo_line(re.sub(r"\[x\]", "[ ]", line, count=1))
    keep = not done or (parsed is not None and parsed.kind == "daily")
    return {"commit": sha, "changed": changed, "line": line, "row": row_for(args.id) if keep else None}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("dept", choices=common.DEPARTMENTS)
    a.add_argument("text")
    a.add_argument("--project", help="the ### directive heading under Todos to file it under")
    a.add_argument("--due")
    a.add_argument("--daily", action="store_true")
    a.add_argument("--at", help='"YYYY-MM-DD HH:MM", makes it an event')
    a.add_argument("--done-when", dest="predicate")
    a.add_argument("--no-commit", action="store_true")
    for name in ("tick", "untick"):
        t = sub.add_parser(name)
        t.add_argument("id")
        t.add_argument("--no-commit", action="store_true")
    e = sub.add_parser("edit")
    e.add_argument("id")
    e.add_argument("--text", help="the new text; it gives the todo a new id")
    when = e.add_mutually_exclusive_group()
    when.add_argument("--due")
    when.add_argument("--daily", action="store_true")
    when.add_argument("--at", help='"YYYY-MM-DD HH:MM", makes it an event')
    when.add_argument("--undated", action="store_true", help="take the date marker off")
    where = e.add_mutually_exclusive_group()
    where.add_argument("--project", help="the ### directive heading to move the block under")
    where.add_argument("--unfile", action="store_true", help="move the block before the first directive")
    e.add_argument("--no-commit", action="store_true")
    n = sub.add_parser("note")
    n.add_argument("id")
    n.add_argument("text")
    n.add_argument("--sub", action="store_true", help="append a subtask box instead of a note")
    n.add_argument("--no-commit", action="store_true")
    args = ap.parse_args(argv)

    try:
        with vault_write_lock():
            result = run(args)
        if not args.no_commit:
            import capture
            result["agenda_produced"] = capture.refresh("todos")
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()
    except TodoEditError as e:
        print(f"todo_edit: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
