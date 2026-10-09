"""The one judgment call: which of the judged postings are the day's picks.

The prompt carries the owner's profile, work status and ranking guidance from the criteria
file, then every candidate in full with the two verdicts the cheaper passes gave it. The
model re-checks each against the same rules, names any it overturns, and orders the rest,
returning at most `count` and fewer when fewer fit. Parsing is pure and tested; the model
call is one function in run.py.
"""
from __future__ import annotations

import json
import re
from datetime import date

from model import Criteria, Dropped, Eligibility, Pick, Posting, Skills

HEAD = "Rank job postings for the owner of this vault."


def verdict_lines(e: Eligibility, s: Skills) -> str:
    marks = ", ".join(f"{m.name} ({m.status})" for m in s.skills) or "none named"
    years = f"{s.years} ({s.years_quote})" if s.years is not None else "none stated"
    return (f"eligibility: citizenship {e.citizenship}, clearance {e.clearance}, "
            f"reposted {'yes' if e.reposted else 'no'}\n"
            f"skills: required years {years}; primary stack {s.stack or 'unstated'}; {marks}")


def card(p: Posting, e: Eligibility, s: Skills, source: str) -> str:
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
    if source == "carried":
        bits.append("carried from an earlier day")
    return f"{' | '.join(bits)}\n{verdict_lines(e, s)}\n{p.description}\n"


def prompt(rows: list[dict], c: Criteria, today: date, vault_note: str) -> str:
    cards = "\n".join(card(r["posting"], Eligibility.from_dict(r["eligibility"]),
                           Skills.from_dict(r["skills"]), r.get("source", "new")) for r in rows)
    status = c.work_status or "not stated"
    return f"""{HEAD} Today is {today.isoformat()}.

Owner profile:
{c.profile}

The owner is {status}. The owner meets at most {c.max_years} years of required experience, will not take a role whose primary stack matches any of {list(c.never_stack) or 'nothing'}, and a posting missing {c.max_missing} or more required skills is out.

What to weigh, in order:
{c.ranking or "Level fit first, then hard requirements the owner cannot meet, then stack match, then location, then applicant count."}

The owner's own notes on the search are in {vault_note}; read it if a posting needs context, and read nothing else.

Below are {len(rows)} postings, each in full with the verdicts two earlier passes gave it. Do two things.

First, re-check every posting against the rules above: a citizenship or residency the owner lacks, a clearance required to start (Public Trust included), a job board or agency posting on behalf of another employer, a required years floor above the owner's, a never-list stack, or too many missing skills. A posting that fails on reading the text goes in "overturned" with the sentence that decides it, whatever the earlier verdict said.

Then order the survivors by how likely the owner is to get an interview, best first. Return at most {c.count} picks. Fewer is the right answer when fewer fit; never pad the list. Tier A means apply today, B is a solid fit with more competition or a small gap, C is a stretch.

Answer with one JSON object and nothing else, in exactly this form:
{{"picks": [{{"id": "123", "tier": "A", "why": "one sentence naming the concrete fit"}}],
 "overturned": [{{"id": "456", "why": "the rule and the sentence"}}],
 "passed": [{{"id": "789", "why": "a few words on why it ranked below the picks"}}]}}

Every id below appears in exactly one of the three lists. No preamble, no markdown fence.

{cards}"""


def _rows(data: dict, key: str, by_id: dict[str, Posting], taken: set[str]) -> list[Dropped]:
    out = []
    for r in data.get(key, []) or []:
        pid = str(r.get("id", "")).strip()
        if pid in by_id and pid not in taken:
            taken.add(pid)
            out.append(Dropped(pid, "rank", re.sub(r"\s+", " ", str(r.get("why", ""))).strip()))
    return out


def parse(text: str, postings: list[Posting], count: int) -> tuple[list[Pick], list[Dropped], list[Dropped]]:
    """The picks in the model's order, bound to their postings, then the overturned and the
    passed-over ids with the model's reasons. An id the model invented is ignored; a
    duplicate keeps its first mention; more than `count` picks are cut to `count`. No picks
    is a valid answer; no JSON object is not."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("no JSON object in the ranker's answer")
    data = json.loads(text[start:end + 1])
    by_id = {p.id: p for p in postings}
    picks: list[Pick] = []
    seen: set[str] = set()
    for row in data.get("picks", []) or []:
        pid = str(row.get("id", "")).strip()
        if pid not in by_id or pid in seen:
            continue
        seen.add(pid)
        tier = str(row.get("tier", "B")).strip().upper()[:1] or "B"
        picks.append(Pick(rank=len(picks) + 1, tier=tier if tier in "ABC" else "B",
                          why=re.sub(r"\s+", " ", str(row.get("why", ""))).strip(), posting=by_id[pid]))
        if len(picks) == count:
            break
    overturned = _rows(data, "overturned", by_id, seen)
    passed = _rows(data, "passed", by_id, seen)
    return picks, overturned, passed
