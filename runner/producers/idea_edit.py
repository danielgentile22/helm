#!/usr/bin/env python3
"""Every write anything makes to an idea note, and the one parser of one.

An idea is one note at `Atlas/Ideas/<created>-<slug>.md` (shape in docs/data-shapes.md):
frontmatter, then the title as the first body line, then anything. The `update-vault`
skill and the job search write through here; the capture source reads through
`parse_idea`. The vault is its own git repo, so every write ends in a commit there with
the one path it touched, and the subject names the action only, never the idea's text
(ADR 0038).

    idea_edit.py add "<title>" [--project <title>] [--department Work|Projects|Chess|Life]
                               [--due YYYY-MM-DD] [--body <text>] [--created YYYY-MM-DD]
    idea_edit.py status <path-or-slug> open|done|dropped
    idea_edit.py due <path-or-slug> YYYY-MM-DD|none
    idea_edit.py list [--status open|done|dropped|promoted] [--json]

`add`, `status` and `due` print one JSON line: the written path, the commit, whether
anything changed, and the parsed idea. `status` and `due` with the value already set write
nothing. `--no-commit` writes the note and skips the commit and the capture refresh.

Promotion (status `promoted` plus `issue:`) needs a project's tracker, so it is not here
yet. It will be one more function beside `set_status` that writes `issue:` and the status
together; `status` refuses `promoted` until then.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Literal, get_args

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
import frontmatter  # noqa: E402

Status = Literal["open", "done", "dropped", "promoted"]
STATUSES: tuple[Status, ...] = get_args(Status)
IDEAS = Path("Atlas") / "Ideas"
# Frontmatter keys in the order a written note carries them.
FIELDS = ("type", "created", "status", "project", "department", "due", "issue")
STATUS_SUBJECTS: dict[Status, str] = {"open": "Reopen an idea", "done": "Mark an idea done",
                                      "dropped": "Drop an idea"}  # type: ignore[dict-item]
ADD_SUBJECT = "Add an idea"
DUE_SUBJECT = "Change an idea's due date"


class IdeaError(Exception):
    pass


class UnknownIdea(IdeaError):
    """No idea note answers to that path or slug. Its own type so a route can answer 404."""


@dataclass(frozen=True)
class Idea:
    path: str                  # vault-relative, `Atlas/Ideas/<created>-<slug>.md`
    title: str
    created: str
    status: Status
    department: common.Department
    project: str | None = None
    due: str | None = None
    issue: str | None = None

    @property
    def id(self) -> str:
        return Path(self.path).stem

    def to_row(self) -> dict:
        return {"id": self.id, **asdict(self)}


def valid_day(value: str, what: str) -> str:
    try:
        if len(value) == 10:
            date.fromisoformat(value)
            return value
    except ValueError:
        pass
    raise IdeaError(f"{what} {value!r} is not a date like 2026-11-15")


def valid_status(value: str) -> Status:
    if value not in STATUSES:
        raise IdeaError(f"unknown status {value!r}, want one of {', '.join(STATUSES)}")
    return value  # type: ignore[return-value]


def valid_department(value: str) -> common.Department:
    if value not in common.DEPARTMENTS:
        raise IdeaError(f"unknown department {value!r}, want one of {', '.join(common.DEPARTMENTS)}")
    return value  # type: ignore[return-value]


def parse_idea(text: str, path: str) -> Idea:
    """The one reading of an idea note. Raises IdeaError naming the path for anything the
    shape does not allow, so a hand edit that broke a note is reported, never guessed at."""
    fields, body = frontmatter.split(text)

    def field(key: str) -> str | None:
        return frontmatter.text_of(fields.get(key))

    try:
        if field("type") != "idea":
            raise IdeaError("frontmatter has no `type: idea`")
        title = next((ln.strip().lstrip("#").strip() for ln in body.splitlines() if ln.strip()), "")
        if not title:
            raise IdeaError("no title: the first body line is empty")
        due = field("due")
        return Idea(
            path=path,
            title=title,
            created=valid_day(field("created") or "", "created"),
            status=valid_status(field("status") or ""),
            department=valid_department(field("department") or "Life"),
            project=field("project"),
            due=valid_day(due, "due") if due else None,
            issue=field("issue"),
        )
    except IdeaError as e:
        raise IdeaError(f"{path}: {e}") from None


def render(fields: dict[str, frontmatter.Value | None], body: str) -> str:
    lines = [frontmatter.line(k, v) for k in FIELDS if (v := fields.get(k))]
    lines += [frontmatter.line(k, v) for k, v in fields.items() if k not in FIELDS and v]
    return "---\n" + "\n".join(lines) + "\n---\n" + body.rstrip("\n") + "\n"


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def slugify(title: str, limit: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", re.sub(r"['’]", "", title.lower())).strip("-")
    if len(slug) > limit:
        slug = slug[:limit].rsplit("-", 1)[0]
    return slug or "idea"


def project_department(vault: Path, project: str) -> common.Department:
    """The department of the project note titled `project`: the Atlas folder it sits in.
    Project notes are found by `type: project` anywhere in Atlas."""
    for rel, fields, _ in frontmatter.typed_notes(vault, "project"):
        if fields.get("title") == project:
            top = Path(rel).parts[1]
            return top if top in common.DEPARTMENTS else "Life"  # type: ignore[return-value]
    raise IdeaError(f"no project note titled {project!r} (a note with `type: project` in Atlas)")


def add(vault: Path, title: str, project: str | None = None, department: str | None = None,
        due: str | None = None, body: str | None = None, created: str | None = None) -> Idea:
    """Write a new idea note and return it parsed back. Never commits."""
    title = " ".join(title.split())
    if not title:
        raise IdeaError("an idea needs a title")
    created = valid_day(created or date.today().isoformat(), "created")
    if due:
        valid_day(due, "due")
    if department:
        valid_department(department)
    if project:
        derived = project_department(vault, project)
        if department and department != derived:
            raise IdeaError(f"project {project!r} is in {derived}, not {department}")
        department = derived
    fields = {"type": "idea", "created": created, "status": "open", "project": project,
              "department": department or "Life", "due": due}
    folder = vault / IDEAS
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"{created}-{slugify(title)}"
    note, n = folder / f"{stem}.md", 1
    while note.exists():
        n += 1
        note = folder / f"{stem}-{n}.md"
    text = render(fields, title + (f"\n\n{body.strip()}" if body and body.strip() else ""))
    idea = parse_idea(text, str(note.relative_to(vault)))
    with open(note, "x") as fh:
        fh.write(text)
    return idea


def resolve(vault: Path, ref: str) -> Path:
    """A note path (absolute or vault-relative), a file name, a full stem
    (`2026-11-01-book-flights`) or the slug alone (`book-flights`) when only one note has it."""
    folder = (vault / IDEAS).resolve()
    for candidate in (Path(ref), vault / ref, folder / ref, folder / f"{ref}.md"):
        candidate = candidate.resolve()
        if candidate.suffix == ".md" and candidate.is_file():
            if candidate.parent != folder:
                raise IdeaError(f"{ref} is not an idea note; ideas live in {IDEAS}")
            return candidate
    hits = sorted(p for p in folder.glob("*.md") if re.fullmatch(rf"\d{{4}}-\d\d-\d\d-{re.escape(ref)}", p.stem))
    if len(hits) == 1:
        return hits[0]
    if hits:
        raise IdeaError(f"{ref!r} names {len(hits)} ideas: {', '.join(p.stem for p in hits)}")
    raise UnknownIdea(f"no idea note matches {ref!r} in {IDEAS}")


def load(vault: Path, note: Path) -> Idea:
    return parse_idea(note.read_text(), str(note.resolve().relative_to(vault.resolve())))


def scan(vault: Path) -> tuple[list[Idea], list[IdeaError]]:
    """Every idea note that parses, oldest first, and an error naming each one that does not."""
    folder = vault / IDEAS
    ideas: list[Idea] = []
    errors: list[IdeaError] = []
    for note in sorted(folder.glob("*.md")) if folder.is_dir() else []:
        try:
            ideas.append(load(vault, note))
        except (IdeaError, OSError, UnicodeDecodeError) as e:
            errors.append(e if isinstance(e, IdeaError) else IdeaError(f"{note.name}: {e}"))
    return ideas, errors


def load_ideas(vault: Path) -> list[Idea]:
    """Every idea note, oldest first. One broken note raises, naming its path."""
    ideas, errors = scan(vault)
    if errors:
        raise errors[0]
    return ideas


def set_field(vault: Path, note: Path, key: str, value: str | None) -> tuple[Idea, bool]:
    """Set one frontmatter field, or remove it when value is None. No change writes nothing."""
    before = load(vault, note)
    fields, body = frontmatter.split(note.read_text())
    if (fields.get(key) or None) == value:
        return before, False
    fields[key] = value  # type: ignore[assignment]
    text = render(fields, body)
    after = parse_idea(text, before.path)
    write_atomic(note, text)
    return after, True


def set_status(vault: Path, note: Path, status: str) -> tuple[Idea, bool]:
    if valid_status(status) == "promoted":
        raise IdeaError("promotion writes an issue to the project's tracker; it is not a status change")
    return set_field(vault, note, "status", status)


def set_due(vault: Path, note: Path, due: str | None) -> tuple[Idea, bool]:
    return set_field(vault, note, "due", valid_day(due, "due") if due else None)


def commit(vault: Path, rel: str, subject: str) -> str:
    """Stage and commit the one path. The subject is one of the fixed action subjects."""
    for argv in (["git", "-C", str(vault), "add", "--", rel],
                 ["git", "-C", str(vault), "commit", "-q", "-m", subject, "--", rel]):
        r = subprocess.run(argv, capture_output=True, text=True)
        if r.returncode != 0:
            raise IdeaError(f"git {argv[3]} failed: {r.stderr.strip() or r.stdout.strip()}")
    return subprocess.run(["git", "-C", str(vault), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True).stdout.strip()


def commit_or_restore(vault: Path, rel: str, subject: str, before: str | None) -> str:
    """Commit the one path, or put the note back as it was and raise, so a write the vault's
    history does not hold is never left on disk. `before` None means the note was new."""
    try:
        return commit(vault, rel, subject)
    except IdeaError:
        subprocess.run(["git", "-C", str(vault), "reset", "-q", "--", rel], capture_output=True)
        note = vault / rel
        if before is None:
            note.unlink(missing_ok=True)
        else:
            write_atomic(note, before)
        raise


def run(vault: Path, args: argparse.Namespace) -> dict:
    if args.cmd == "add":
        idea = add(vault, args.title, args.project, args.department, args.due, args.body, args.created)
        changed, subject, before = True, ADD_SUBJECT, None
    else:
        note = resolve(vault, args.ref)
        before = note.read_text()
        if args.cmd == "status":
            idea, changed = set_status(vault, note, args.value)
            subject = STATUS_SUBJECTS[idea.status]
        else:
            idea, changed = set_due(vault, note, None if args.value == "none" else args.value)
            subject = DUE_SUBJECT
    sha = commit_or_restore(vault, idea.path, subject, before) if changed and not args.no_commit else None
    return {"path": str(vault / idea.path), "commit": sha, "changed": changed, "idea": idea.to_row()}


def refresh_capture() -> None:
    """Rerun capture's ideas source so agenda.json shows the write at once."""
    import capture
    capture.refresh("ideas")


def list_line(idea: Idea) -> str:
    where = idea.project or idea.department
    return f"{idea.status:<9} {idea.due or '-':<10}  {where:<12}  {idea.title}  ({idea.id})"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("title")
    a.add_argument("--project", help="a project note's title; the department follows from it")
    a.add_argument("--department", help=" | ".join(common.DEPARTMENTS))
    a.add_argument("--due")
    a.add_argument("--body")
    a.add_argument("--created", help="defaults to today")
    s = sub.add_parser("status")
    s.add_argument("ref")
    s.add_argument("value", metavar="open|done|dropped")
    d = sub.add_parser("due")
    d.add_argument("ref")
    d.add_argument("value", metavar="YYYY-MM-DD|none")
    for p in (a, s, d):
        p.add_argument("--no-commit", action="store_true")
    ls = sub.add_parser("list")
    ls.add_argument("--status")
    ls.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    vault = common.VAULT
    try:
        if args.cmd == "list":
            ideas = load_ideas(vault)
            if args.status:
                want = valid_status(args.status)
                ideas = [i for i in ideas if i.status == want]
            if args.json:
                print(json.dumps([i.to_row() for i in ideas], ensure_ascii=False))
            else:
                print("\n".join(list_line(i) for i in ideas))
            return 0
        with common.vault_write_lock():
            result = run(vault, args)
        if result["commit"]:
            refresh_capture()
        print(json.dumps(result, ensure_ascii=False))
    except IdeaError as e:
        print(f"idea_edit: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
