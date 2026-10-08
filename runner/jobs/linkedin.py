"""LinkedIn's public guest endpoints, fetched with curl and parsed with regular expressions.

No login, no browser. The search endpoint returns 10 cards per page of HTML, contiguous in `start`; the
posting endpoint returns one page with the description, the criteria list and the applicant
count. Parsing is pure, so the tests feed it saved HTML and never touch the network.
"""
from __future__ import annotations

import html
import re
import subprocess
import time
import urllib.parse

from model import Posting, Query

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")
SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?"
POSTING = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/"
PAGE = 10

_CARD = re.compile(
    r'data-entity-urn="urn:li:jobPosting:(\d+)".*?base-search-card__title">\s*(.*?)\s*</h3>'
    r'.*?(?:hidden-nested-link">\s*(.*?)\s*</a>|base-search-card__subtitle">\s*(.*?)\s*</h4>)'
    r'.*?job-search-card__location">\s*(.*?)\s*</span>(?:.*?datetime="([\d-]+)")?', re.S)
_DESC = re.compile(r'description__text[^>]*>(.*?)</div>\s*<div', re.S)
_CRITERIA = re.compile(r'description__job-criteria-subheader[^>]*>\s*(.*?)\s*</h3>\s*'
                       r'<span[^>]*description__job-criteria-text[^>]*>\s*(.*?)\s*</span>', re.S)
_APPLICANTS = re.compile(r'num-applicants__caption[^>]*>\s*(.*?)\s*<', re.S)


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment))).strip()


def fetch(url: str, timeout_s: int = 30) -> str:
    r = subprocess.run(["curl", "-sL", "-A", UA, "--max-time", str(timeout_s), url],
                       capture_output=True, text=True)
    return r.stdout


def search_url(q: Query, experience_levels: tuple[str, ...], days: int, start: int) -> str:
    params = {"keywords": q.keywords, "location": q.location, "f_E": ",".join(experience_levels),
              "f_TPR": f"r{days * 86400}", "start": start}
    if q.remote:
        params["f_WT"] = "2"
    return SEARCH + urllib.parse.urlencode(params)


def parse_cards(page: str, q: Query) -> list[Posting]:
    out = []
    for jid, title, c1, c2, loc, date in _CARD.findall(page):
        out.append(Posting(id=jid, title=_text(title), company=_text(c1 or c2), location=_text(loc),
                           posted=date, query=q.keywords, remote=q.remote))
    return out


def search(q: Query, experience_levels: tuple[str, ...], days: int, pages: int,
           pause_s: float = 0.6) -> list[Posting]:
    found: list[Posting] = []
    for page in range(pages):
        cards = parse_cards(fetch(search_url(q, experience_levels, days, page * PAGE)), q)
        if not cards:
            break
        found.extend(cards)
        time.sleep(pause_s)
    return found


def parse_posting(page: str, p: Posting) -> Posting:
    """Fill the detail fields of `p` from its posting page. Raises if the page has no
    description, which is what LinkedIn serves when it throttles."""
    m = _DESC.search(page)
    if not m:
        raise ValueError("no description on the page")
    p.description = _text(m.group(1))
    for header, value in _CRITERIA.findall(page):
        h = _text(header).lower()
        if h.startswith("seniority"):
            p.seniority = _text(value)
        elif h.startswith("employment"):
            p.employment = _text(value)
    m2 = _APPLICANTS.search(page)
    p.applicants = _text(m2.group(1)) if m2 else ""
    p.easy_apply = "apply-button--easy" in page or "Easy Apply" in page
    return p


def fetch_posting(p: Posting, tries: int = 3, pause_s: float = 2.0) -> Posting:
    last = ValueError("not fetched")
    for _ in range(tries):
        try:
            return parse_posting(fetch(POSTING + p.id), p)
        except ValueError as e:
            last = e
            time.sleep(pause_s)
    raise last
