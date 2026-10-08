"""The deterministic cuts before any model reads a posting: title words that mark the wrong
level or stack, description phrases the owner cannot satisfy, a years floor above the
owner's, and a cheap score that keeps the shortlist the ranker reads to a page or two.
"""
from __future__ import annotations

import re
from datetime import date

from model import Criteria, Posting

_YEARS = re.compile(r"(\d{1,2})\s*(?:\+|-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)'?"
                    r"(?=[^.;]{0,60}?\b(?:experience|exp\b|hands.on|professional|industry|relevant|related|"
                    r"working|developing|building|programming|engineering|software|"
                    r"(?:of|in|with)\s+(?!history|age|business|operation|service|existence|success|"
                    r"innovation|excellence|growth|tradition|leadership)))", re.I)
_IN_LIEU = re.compile(r"in lieu|additional|equivalent|instead of|or an?\s*$", re.I)
_APPLICANTS = re.compile(r"(\d+)")


def title_reason(p: Posting, c: Criteria) -> str | None:
    t = p.title.lower()
    for pattern in c.title_deny:
        if re.search(pattern, t, re.I):
            return f"title matches {pattern!r}"
    return None


def min_years(description: str) -> int | None:
    """The smallest years figure the posting asks for, or None when it names none. A range
    like "2 to 4 years" counts as its low end, which is the bar a junior has to clear. Only a
    figure followed by an experience phrase counts, so "80 years of history" and "18 years of
    age" do not, and neither does the "or an additional 4 years in lieu of a degree" clause."""
    found = [int(m.group(1)) for m in _YEARS.finditer(description)
             if int(m.group(1)) <= 15 and not _IN_LIEU.search(description[max(0, m.start() - 60):m.start()])]
    return min(found) if found else None


def description_reason(p: Posting, c: Criteria) -> str | None:
    d = p.description
    for pattern in c.description_deny:
        m = re.search(pattern, d, re.I)
        if m:
            return f"description says {m.group(0)!r}"
    years = min_years(d)
    if years is not None and years > c.max_years:
        return f"asks {years} years"
    return None


def applicants(p: Posting) -> int | None:
    m = _APPLICANTS.search(p.applicants)
    return int(m.group(1)) if m else None


def prescore(p: Posting, c: Criteria, today: date) -> float:
    """Higher is better. Keyword hits in the description count most, then few applicants,
    then recency. The ranker makes the real call; this only decides who it reads."""
    text = (p.title + " " + p.description).lower()
    hits = sum(1 for k in c.keywords if k in text)
    n = applicants(p)
    crowd = 0.0 if n is None else max(0.0, 2.0 - n / 100.0)
    try:
        age = (today - date.fromisoformat(p.posted)).days
    except ValueError:
        age = c.posted_within_days
    fresh = max(0.0, 1.0 - age / max(1, c.posted_within_days))
    return hits + crowd + fresh


def shortlist(postings: list[Posting], c: Criteria, today: date) -> list[Posting]:
    ranked = sorted(postings, key=lambda p: prescore(p, c, today), reverse=True)
    return ranked[: c.shortlist]
