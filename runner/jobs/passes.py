"""The two cheap model passes between the regex screen and the ranker, and the drop rules
code applies to their answers.

Each pass asks one question per batch of postings and gets back one fixed JSON form per
posting, keyed by id. Parsing is strict on shape and lenient on text: a form missing a key is
unparsable and its batch fails closed, and an unknown enum value lands on the side that drops,
so a sloppy answer never lets a posting through. The drop rules are pure functions over a
verdict and the criteria, and each returns the reason the note will show or None.
"""
from __future__ import annotations

import json
import re

from model import CITIZENSHIP, CLEARANCE, SKILL_STATUS, Criteria, Eligibility, Posting, SkillMark, Skills

ELIGIBILITY_HEAD = "Read each job posting below and report three facts about who may apply to it."
SKILLS_HEAD = "Read each job posting below against a candidate's skills inventory."
FENCE = "=== posting {id} ==="
ONE_EACH = """Answer with one JSON object and nothing else, keyed by posting id, with every id below present
and each value in exactly this form:"""
APART = """Each posting speaks only for itself: a sentence in one posting never answers for another."""


def _posting_block(p: Posting) -> str:
    head = f"{p.title} at {p.company}, {p.location}"
    if p.seniority or p.employment:
        head += f" ({', '.join(x for x in (p.seniority, p.employment) if x)})"
    return f"Posting:\n{head}\n\n{p.description}"


def _fenced(postings: list[Posting]) -> str:
    return "\n\n".join(f"{FENCE.format(id=p.id)}\n{_posting_block(p)}" for p in postings)


def eligibility_prompt(postings: list[Posting], c: Criteria) -> str:
    status = c.work_status or "not stated"
    return f"""{ELIGIBILITY_HEAD}

The candidate is {status}.

For each posting report:
1. citizenship: "required" when the posting requires a citizenship or residency the candidate does not hold, "open" when it names a requirement the candidate's status satisfies, "not_required" when it says nothing or welcomes anyone.
2. clearance: "required" when an active or current security clearance is required to start, including Public Trust; "obtainable" when the posting says the employer will sponsor or obtain one; "none" otherwise.
3. reposted: true when a job board, staffing agency or aggregator posted this on behalf of another employer, or the apply button leads to its own site rather than the employer's. False when the named company is hiring for itself.

Quote the sentence each answer rests on, or an empty string when nothing in the text speaks to it.

{ONE_EACH}
{{"<id>": {{"citizenship": "required" | "not_required" | "open", "citizenship_quote": "...",
 "clearance": "required" | "obtainable" | "none", "clearance_quote": "...",
 "reposted": true | false, "reposted_quote": "..."}}, ...}}

{APART}

{_fenced(postings)}
"""


def skills_prompt(postings: list[Posting], c: Criteria, skills_text: str) -> str:
    return f"""{SKILLS_HEAD}

For each posting report:
1. years: the smallest number of years of professional experience the required or minimum qualifications demand, as an integer, or null when the required section names none. Ignore the preferred or nice to have section. Quote the line.
2. stack: the one programming language or framework most of the day to day work is in, named in a word or two, never a list. When the posting accepts any of several, name the one the inventory below lists; a language that merely appears somewhere in the text is not the stack.
3. skills: every hard skill the required section names (languages, frameworks, databases, clouds, tools). Mark each "has" when the inventory below lists it, "adjacent" when the inventory lists something a hiring manager would accept in its place, "missing" otherwise. Leave soft skills, degrees and years out.

{ONE_EACH}
{{"<id>": {{"years": 3 | null, "years_quote": "...", "stack": "Python",
 "skills": [{{"name": "...", "status": "has" | "adjacent" | "missing"}}]}}, ...}}

{APART}

Candidate's skills inventory:
{skills_text.strip()}

{_fenced(postings)}
"""


def _object(text: str) -> dict:
    """The first JSON object in the answer; a fence, a preamble or a remark after it is
    ignored."""
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object in the answer")
    data, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(data, dict):
        raise ValueError("the answer is not a JSON object")
    return data


def _require(d: dict, keys: tuple[str, ...]) -> None:
    missing = [k for k in keys if k not in d]
    if missing:
        raise ValueError(f"the answer lacks {', '.join(missing)}")


def _enum(value, allowed: tuple[str, ...], fallback: str) -> str:
    v = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return v if v in allowed else fallback


def _quote(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _flag(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "yes", "y", "1")


def _each(text: str, build) -> dict:
    """One verdict per posting id in the answer's object, ids compared as stripped strings.
    A value that is not a form, or a form missing a key, fails the whole answer naming the
    id, so the batch is asked again rather than one posting slipping through."""
    out = {}
    for pid, form in _object(text).items():
        pid = str(pid).strip()
        if not isinstance(form, dict):
            raise ValueError(f"posting {pid}: the value is not a JSON object")
        try:
            out[pid] = build(form)
        except ValueError as e:
            raise ValueError(f"posting {pid}: {e}") from None
    return out


def eligibility_from(d: dict) -> Eligibility:
    _require(d, ("citizenship", "clearance", "reposted"))
    return Eligibility(
        citizenship=_enum(d.get("citizenship"), CITIZENSHIP, "required"),
        citizenship_quote=_quote(d.get("citizenship_quote")),
        clearance=_enum(d.get("clearance"), CLEARANCE, "required"),
        clearance_quote=_quote(d.get("clearance_quote")),
        reposted=_flag(d.get("reposted")),
        reposted_quote=_quote(d.get("reposted_quote")),
    )


def parse_eligibility(text: str) -> dict[str, Eligibility]:
    return _each(text, eligibility_from)


def _years(value) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    m = re.search(r"\d+", str(value))
    return int(m.group(0)) if m else None


def skills_from(d: dict) -> Skills:
    _require(d, ("years", "stack", "skills"))
    marks = []
    for row in d.get("skills") or []:
        if isinstance(row, dict):
            name = _quote(row.get("name"))
            if name:
                marks.append(SkillMark(name, _enum(row.get("status"), SKILL_STATUS, "missing")))
        elif isinstance(row, str) and row.strip():
            marks.append(SkillMark(row.strip(), "missing"))
    return Skills(years=_years(d.get("years")), years_quote=_quote(d.get("years_quote")),
                  stack=_quote(d.get("stack")), skills=tuple(marks))


def parse_skills(text: str) -> dict[str, Skills]:
    return _each(text, skills_from)


def eligibility_reason(v: Eligibility, c: Criteria) -> str | None:
    if v.citizenship == "required":
        return f"citizenship required: {v.citizenship_quote}"
    if v.clearance == "required":
        return f"clearance required: {v.clearance_quote}"
    if v.reposted:
        return f"reposted: {v.reposted_quote}"
    return None


def skills_reason(v: Skills, c: Criteria) -> str | None:
    if v.years is not None and v.years > c.max_years:
        return f"asks {v.years} years: {v.years_quote}"
    for pattern in c.never_stack:
        if v.stack and re.search(pattern, v.stack, re.I):
            return f"primary stack {v.stack} is on the never list"
    missing = v.missing()
    if len(missing) >= c.max_missing:
        return f"missing {len(missing)} of {len(v.skills)} required skills: {', '.join(missing)}"
    return None
