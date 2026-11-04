"""The Devices tab: device notes in the vault joined to live tailnet presence.

A device is a note with `type: device` anywhere in Atlas (docs/data-shapes.md). Every field
is checked here, at the boundary: a value outside its set is kept as written and named in
`problems`, a malformed date or a `specs` that is not a map reads as absent, and no one
note can fail the route. Presence comes only from the tailnet, joined on the note's
`tailnet` host name; a device with no `tailnet` has `presence: null`, never "offline".
Live usage (memory, disk, load) is known only for the machine the dashboard runs on, which
is the tailnet's `Self`; every other device has `usage: null`.
"""
from __future__ import annotations

from collections.abc import Callable
from datetime import date
from pathlib import Path

import frontmatter
from machine import Tailnet
from sources.projects import slugify

KINDS = ("desktop", "laptop", "phone", "tablet", "watch", "display", "dock", "storage", "network", "audio",
         "camera", "home")
STATUSES = ("ordered", "in service", "spare", "retired", "sold")
T3 = ("host", "client", "none")
# The order the tab lists them in: what is in use, then what is coming, then the rest.
STATUS_ORDER = {"in service": 0, "ordered": 1, "spare": 2, "retired": 3, "sold": 4}
NEVER = "0001-01-01"


def day(fields: dict, key: str, problems: list[str]) -> str | None:
    value = frontmatter.text_of(fields.get(key))
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        problems.append(f"{key}: {value!r} is not a date like 2026-09-23")
        return None


def one_of(fields: dict, key: str, allowed: tuple[str, ...], problems: list[str]) -> str | None:
    value = frontmatter.text_of(fields.get(key))
    if value is not None and value not in allowed:
        problems.append(f"{key}: {value!r} is not one of {', '.join(allowed)}")
    return value


def device(rel: str, fields: dict) -> dict:
    problems: list[str] = []
    specs = fields.get("specs")
    if specs not in (None, "") and not isinstance(specs, dict):
        problems.append("specs: not a map of name to value")
    title = frontmatter.text_of(fields.get("title")) or Path(rel).stem
    return {
        "slug": slugify(title),
        "title": title,
        "kind": one_of(fields, "kind", KINDS, problems),
        "status": one_of(fields, "status", STATUSES, problems),
        "role": frontmatter.text_of(fields.get("role")),
        "t3": one_of(fields, "t3", T3, problems),
        "tailnet": frontmatter.text_of(fields.get("tailnet")),
        "specs": specs if isinstance(specs, dict) else None,
        "purchased": day(fields, "purchased", problems),
        "warranty_until": day(fields, "warranty_until", problems),
        "path": rel,
        "problems": problems,
    }


def nodes(status: dict) -> dict[str, dict]:
    """Every node on the tailnet by lowercase host name: the first label of its MagicDNS
    name, which is what `tailscale status` prints, and its OS host name."""
    found: dict[str, dict] = {}
    for node in [status.get("Self") or {}, *(status.get("Peer") or {}).values()]:
        if not isinstance(node, dict):
            continue
        for name in (str(node.get("DNSName") or "").split(".")[0], str(node.get("HostName") or "")):
            if name:
                found.setdefault(name.lower(), node)
    return found


def presence(node: dict | None, is_self: bool) -> dict:
    if node is None:
        return {"online": False, "last_seen": None}
    seen = str(node.get("LastSeen") or "")
    return {"online": bool(node.get("Online")) or is_self,
            "last_seen": None if not seen or seen.startswith(NEVER) else seen}


def assemble(vault: Path, tailnet: Tailnet, usage: Callable[[], dict]) -> dict:
    rows = [device(rel, fields) for rel, fields, _ in frontmatter.typed_notes(vault, "device")]
    known = nodes(tailnet.status) if tailnet.status is not None else None
    self_node = (tailnet.status or {}).get("Self")
    for row in rows:
        node = None if row["tailnet"] is None or known is None else known.get(row["tailnet"].lower())
        is_self = node is not None and node is self_node
        row["presence"] = None if row["tailnet"] is None or known is None else presence(node, is_self)
        row["usage"] = usage() if is_self else None
    rows.sort(key=lambda r: (STATUS_ORDER.get(r["status"] or "", 9), r["title"].lower()))
    return {"devices": rows, "tailnet_error": tailnet.error}
