"""The one reader and writer of a vault note's frontmatter.

A YAML subset, which is all the vault's notes use: `key: value` scalars (bare, double
quoted the way `scalar` writes them, or single quoted), inline lists (`[a, b]`), block
lists (indented `- a`), and one level of nested map (`specs:` then indented `chip: M5`).
A bare value may carry a trailing ` # comment`. Anything else on a line is skipped rather
than guessed at, so a note this reads badly still reads, and the caller validates the
fields it needs.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterator, Union

Value = Union[str, list[str], dict[str, str]]

# Bare words YAML reads as something other than a string.
YAML_WORDS = {"yes", "no", "true", "false", "on", "off", "null", "~"}
IDEAS = ("Atlas", "Ideas")


def _strip_comment(value: str) -> str:
    cut = value.find(" #")
    return value[:cut].rstrip() if cut >= 0 else value


def _split_items(inner: str) -> list[str]:
    items, buf, quote = [], "", ""
    for ch in inner:
        if quote:
            buf += ch
            if ch == quote:
                quote = ""
        elif ch in "\"'":
            quote = ch
            buf += ch
        elif ch == ",":
            items.append(buf)
            buf = ""
        else:
            buf += ch
    items.append(buf)
    return [s for s in (_scalar_text(i) for i in items) if s]


def _scalar_text(raw: str) -> str:
    value = raw.strip()
    if value.startswith('"'):
        try:
            return str(json.loads(value))
        except ValueError:
            return value.strip('"')
    if value.startswith("'") and value.endswith("'") and len(value) > 1:
        return value[1:-1].replace("''", "'")
    return _strip_comment(value)


def _value(raw: str) -> Value:
    text = raw.strip()
    bare = _strip_comment(text) if not text.startswith(("'", '"')) else text
    if bare.startswith("[") and bare.endswith("]"):
        return _split_items(bare[1:-1])
    return _scalar_text(text)


def split(text: str) -> tuple[dict[str, Value], str]:
    """Frontmatter as a dict, and the body after it. No frontmatter is an empty dict. A key
    with nothing after its colon and no indented lines under it reads as the empty string."""
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fields: dict[str, Value] = {}
    open_key: str | None = None
    for line in text[4:end].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line[:1].isspace():
            if open_key is None:
                continue
            held = fields[open_key]
            if stripped.startswith("- "):
                if held == "" or isinstance(held, list):
                    fields[open_key] = [*(held or []), _scalar_text(stripped[2:])]
                continue
            key, sep, value = stripped.partition(":")
            if sep and key.strip() and (held == "" or isinstance(held, dict)):
                fields[open_key] = {**(held or {}), key.strip(): _scalar_text(value)}
            continue
        key, sep, value = line.partition(":")
        if not sep or not key.strip():
            open_key = None
            continue
        key = key.strip()
        if value.strip():
            fields[key] = _value(value)
            open_key = None
        else:
            fields[key] = ""
            open_key = key
    return fields, text[end + 4:].lstrip("\n")


def scalar(value: str) -> str:
    """A value YAML reads back as the same string: bare when it is plain, else a JSON
    string, which is a valid YAML double-quoted scalar."""
    plain = re.fullmatch(r"[\w][\w .,/&()+'-]*", value) and not value.endswith(" ")
    if plain and value.lower() not in YAML_WORDS:
        return value
    return json.dumps(value, ensure_ascii=False)


def line(key: str, value: Value) -> str:
    """One field as `split` reads it back."""
    if isinstance(value, list):
        return f"{key}: [{', '.join(scalar(v) for v in value)}]"
    if isinstance(value, dict):
        return "\n".join([f"{key}:"] + [f"  {k}: {scalar(v)}" for k, v in value.items()])
    return f"{key}: {scalar(value)}"


def text_of(value: Value | None) -> str | None:
    """A field the caller wants as one string: None when missing, empty, or not a scalar."""
    return value.strip() or None if isinstance(value, str) else None


def typed_notes(vault: Path, kind: str) -> Iterator[tuple[str, dict[str, Value], str]]:
    """Every note in Atlas whose frontmatter says `type: <kind>`, as (vault-relative path,
    fields, body), in path order. Idea notes are skipped: none of them is anything else."""
    atlas = vault / "Atlas"
    if not atlas.is_dir():
        return
    marker = f"type: {kind}"
    for note in sorted(atlas.rglob("*.md")):
        rel = note.relative_to(vault)
        if rel.parts[:2] == IDEAS:
            continue
        try:
            text = note.read_text(errors="replace")
        except OSError:
            continue
        if not text.startswith("---\n") or marker not in text:
            continue
        fields, body = split(text)
        if fields.get("type") == kind:
            yield str(rel), fields, body
