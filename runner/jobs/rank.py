"""The one judgment call: which of the screened postings are the day's picks.

The prompt carries the owner's profile and ranking guidance from the criteria file, plus a
compact card per shortlisted posting. The model answers with JSON naming exactly `count`
ids in order, each with a tier and one sentence of reasoning, and every other id with why
it lost. Parsing is pure and tested; the model call is one function.
"""
from __future__ import annotations

import json
import re
from datetime import date

from model import Criteria, Dropped, Pick, Posting

EXCERPT = 1400


def card(p: Posting) -> str:
    bits = [f"id {p.id}", f"{p.title} at {p.company}", p.location]
    if p.remote:
        bits.append("remote search")
    if p.posted:
        bits.append(f"posted {p.posted}")
    if p.applicants:
        bits.append(p.applicants)
    if p.easy_apply:
        bits.append("Easy Apply")
    if p.seniority:
        bits.append(p.seniority)
    head = " | ".join(bits)
    desc = p.description[:EXCERPT] + ("..." if len(p.description) > EXCERPT else "")
    return f"{head}\n{desc}\n"


def prompt(postings: list[Posting], c: Criteria, today: date, vault_note: str) -> str:
    cards = "\n".join(card(p) for p in postings)
    return f"""You are ranking job postings for the owner of this vault. Today is {today.isoformat()}.

Owner profile:
{c.profile}

What to weigh, in order:
{c.ranking or "Level fit first, then hard requirements the owner cannot meet, then stack match, then location, then applicant count."}

The owner's own notes on the search are in {vault_note}; read it if a posting needs context, and read nothing else.

Below are {len(postings)} postings that passed the deterministic screen. Pick exactly {c.count} the owner is most likely to get an interview at, best first. Tier A means apply today, B is a solid fit with more competition or a small gap, C is a stretch. A posting whose description contradicts the profile (a clearance, a citizenship requirement, a years floor the owner does not meet) must not be picked, whatever the title says.

Answer with one JSON object and nothing else, of this shape:
{{"picks": [{{"id": "123", "tier": "A", "why": "one sentence naming the concrete fit"}}],
 "dropped": [{{"id": "456", "why": "a few words"}}]}}

Every id below appears in exactly one of the two lists. No preamble, no markdown fence, no em dashes.

{cards}"""


def parse(text: str, postings: list[Posting], count: int) -> tuple[list[Pick], list[Dropped]]:
    """The picks in the model's order, bound to their postings. An id the model invented is
    ignored; a duplicate keeps its first mention; more than `count` picks are cut to `count`."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError("no JSON object in the ranker's answer")
    data = json.loads(text[start:end + 1])
    by_id = {p.id: p for p in postings}
    picks: list[Pick] = []
    seen: set[str] = set()
    for row in data.get("picks", []):
        pid = str(row.get("id", "")).strip()
        if pid not in by_id or pid in seen:
            continue
        seen.add(pid)
        tier = str(row.get("tier", "B")).strip().upper()[:1] or "B"
        picks.append(Pick(rank=len(picks) + 1, tier=tier if tier in "ABC" else "B",
                          why=re.sub(r"\s+", " ", str(row.get("why", ""))).strip(), posting=by_id[pid]))
        if len(picks) == count:
            break
    if not picks:
        raise ValueError("the ranker picked nothing")
    dropped = [Dropped(str(r.get("id", "")), "rank", str(r.get("why", "")).strip())
               for r in data.get("dropped", []) if str(r.get("id", "")) in by_id and str(r.get("id", "")) not in seen]
    return picks, dropped
