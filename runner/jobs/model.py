"""The shapes the job search routine passes between its stages.

The owner's criteria live in the vault (`Atlas/Work/files/job-search/criteria.json`), so the
engine knows nothing about who is searching until it reads them. Every stage reads and writes
plain JSON of these shapes under `~/.helm/status/job-search/<day>/`, so a stage can be rerun
on its own and a reader can see what each one decided.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

CRITERIA_PATH = Path("Atlas/Work/files/job-search/criteria.json")


@dataclass(frozen=True)
class Query:
    keywords: str
    location: str
    remote: bool = False


@dataclass(frozen=True)
class Criteria:
    """What to search for and what to throw away before any model reads a posting."""
    queries: tuple[Query, ...]
    profile: str
    ranking: str
    count: int = 10
    posted_within_days: int = 14
    experience_levels: tuple[str, ...] = ("2",)
    pages: int = 3
    shortlist: int = 50
    max_years: int = 2
    title_deny: tuple[str, ...] = ()
    description_deny: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()
    tailor: bool = True
    resume_deny: tuple[str, ...] = ()
    todo_directive: str = ""

    @staticmethod
    def load(path: Path) -> "Criteria":
        raw = json.loads(path.read_text())
        queries = tuple(Query(q["keywords"], q["location"], bool(q.get("remote", False)))
                        for q in raw["queries"])
        if not queries:
            raise ValueError(f"{path}: queries is empty")
        for key in ("title_deny", "description_deny", "resume_deny"):
            for pattern in raw.get(key, ()):
                re.compile(pattern)
        return Criteria(
            queries=queries,
            profile=raw["profile"].strip(),
            ranking=raw.get("ranking", "").strip(),
            count=int(raw.get("count", 10)),
            posted_within_days=int(raw.get("posted_within_days", 14)),
            experience_levels=tuple(str(x) for x in raw.get("experience_levels", ["2"])),
            pages=int(raw.get("pages", 3)),
            shortlist=int(raw.get("shortlist", 50)),
            max_years=int(raw.get("max_years", 2)),
            title_deny=tuple(raw.get("title_deny", ())),
            description_deny=tuple(raw.get("description_deny", ())),
            keywords=tuple(k.lower() for k in raw.get("keywords", ())),
            tailor=bool(raw.get("tailor", True)),
            resume_deny=tuple(raw.get("resume_deny", ())),
            todo_directive=str(raw.get("todo_directive", "")),
        )


@dataclass
class Posting:
    """One LinkedIn posting. `description` and the fields after it are empty until the detail
    stage has fetched the page."""
    id: str
    title: str
    company: str
    location: str
    posted: str
    query: str
    remote: bool = False
    description: str = ""
    seniority: str = ""
    employment: str = ""
    applicants: str = ""
    easy_apply: bool = False

    @property
    def url(self) -> str:
        return f"https://www.linkedin.com/jobs/view/{self.id}/"

    @staticmethod
    def from_dict(d: dict) -> "Posting":
        return Posting(**{k: d[k] for k in Posting.__dataclass_fields__ if k in d})


@dataclass
class Pick:
    """A posting the ranker chose, in the order it chose them."""
    rank: int
    tier: str
    why: str
    posting: Posting
    folder: str = ""
    tailored: bool = False
    tailor_note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Pick":
        d = dict(d)
        d["posting"] = Posting.from_dict(d["posting"])
        return Pick(**d)


@dataclass
class Dropped:
    id: str
    stage: str
    why: str


def dump(path: Path, rows: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps([asdict(r) if hasattr(r, "__dataclass_fields__") else r for r in rows],
                              indent=1, ensure_ascii=False))
    tmp.replace(path)


def load_postings(path: Path) -> list[Posting]:
    return [Posting.from_dict(d) for d in json.loads(path.read_text())]


def load_picks(path: Path) -> list[Pick]:
    return [Pick.from_dict(d) for d in json.loads(path.read_text())]
