"""The shapes the job search routine passes between its stages.

The owner's criteria live in the vault (`Atlas/Work/files/job-search/criteria.json`), so the
engine knows nothing about who is searching until it reads them. Every stage reads and writes
plain JSON of these shapes under `~/.helm/status/job-search/<day>/`, so a stage can be rerun
on its own and a reader can see what each one decided.
"""
from __future__ import annotations

import hashlib
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
    """What to search for, what to throw away before any model reads a posting, and the
    thresholds the model passes drop on."""
    queries: tuple[Query, ...]
    profile: str
    ranking: str
    count: int = 10
    posted_within_days: int = 14
    experience_levels: tuple[str, ...] = ("2",)
    pages: int = 3
    shortlist: int = 60
    max_years: int = 2
    title_deny: tuple[str, ...] = ()
    company_deny: tuple[str, ...] = ()
    description_deny: tuple[str, ...] = ()
    home_location: str = ""
    remote_says: tuple[str, ...] = ()
    remote_denies: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()
    tailor: bool = True
    resume_deny: tuple[str, ...] = ()
    todo_directive: str = ""
    targets: dict[str, int] = field(default_factory=lambda: {"home": 100, "remote": 100})
    job_types: tuple[str, ...] = ()
    job_functions: tuple[str, ...] = ()
    work_status: str = ""
    never_stack: tuple[str, ...] = ()
    max_missing: int = 3
    pool_days: int = 30
    skills_note: str = "Atlas/Work/Skills & Certifications.md"

    @staticmethod
    def load(path: Path) -> "Criteria":
        raw = json.loads(path.read_text())
        queries = tuple(Query(q["keywords"], q["location"], bool(q.get("remote", False)))
                        for q in raw["queries"])
        if not queries:
            raise ValueError(f"{path}: queries is empty")
        for key in ("title_deny", "company_deny", "description_deny", "resume_deny",
                    "remote_says", "remote_denies", "never_stack"):
            for pattern in raw.get(key, ()):
                re.compile(pattern)
        re.compile(raw.get("home_location", ""))
        targets = {"home": 100, "remote": 100, **{k: int(v) for k, v in raw.get("targets", {}).items()}}
        return Criteria(
            queries=queries,
            profile=raw["profile"].strip(),
            ranking=raw.get("ranking", "").strip(),
            count=int(raw.get("count", 10)),
            posted_within_days=int(raw.get("posted_within_days", 14)),
            experience_levels=tuple(str(x) for x in raw.get("experience_levels", ["2"])),
            pages=int(raw.get("pages", 3)),
            shortlist=int(raw.get("shortlist", 60)),
            max_years=int(raw.get("max_years", 2)),
            title_deny=tuple(raw.get("title_deny", ())),
            company_deny=tuple(raw.get("company_deny", ())),
            description_deny=tuple(raw.get("description_deny", ())),
            home_location=str(raw.get("home_location", "")),
            remote_says=tuple(raw.get("remote_says", ())),
            remote_denies=tuple(raw.get("remote_denies", ())),
            keywords=tuple(k.lower() for k in raw.get("keywords", ())),
            tailor=bool(raw.get("tailor", True)),
            resume_deny=tuple(raw.get("resume_deny", ())),
            todo_directive=str(raw.get("todo_directive", "")),
            targets=targets,
            job_types=tuple(str(x) for x in raw.get("job_types", ())),
            job_functions=tuple(str(x) for x in raw.get("job_functions", ())),
            work_status=str(raw.get("work_status", "")).strip(),
            never_stack=tuple(raw.get("never_stack", ())),
            max_missing=int(raw.get("max_missing", 3)),
            pool_days=int(raw.get("pool_days", 30)),
            skills_note=str(raw.get("skills_note", "Atlas/Work/Skills & Certifications.md")),
        )


def criteria_hash(c: Criteria, skills_text: str) -> str:
    """Twelve hex digits over the fields that shape a verdict, so a cached verdict is reused
    only while the question it answered is unchanged."""
    key = json.dumps([c.work_status, c.max_years, list(c.never_stack), c.max_missing, skills_text])
    return hashlib.sha256(key.encode()).hexdigest()[:12]


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


CITIZENSHIP = ("required", "not_required", "open")
CLEARANCE = ("required", "obtainable", "none")
SKILL_STATUS = ("has", "adjacent", "missing")


@dataclass(frozen=True)
class Eligibility:
    """The eligibility pass's answer. `open` means open to the work status the criteria
    name. Each fact carries the sentence it was read from, which becomes the drop reason."""
    citizenship: str
    citizenship_quote: str
    clearance: str
    clearance_quote: str
    reposted: bool
    reposted_quote: str

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Eligibility":
        return Eligibility(**{k: d[k] for k in Eligibility.__dataclass_fields__})


@dataclass(frozen=True)
class SkillMark:
    name: str
    status: str


@dataclass(frozen=True)
class Skills:
    """The skills pass's answer: the years floor from the required section alone, the
    primary stack as the posting names it, and each required hard skill against the
    owner's inventory."""
    years: int | None
    years_quote: str
    stack: str
    skills: tuple[SkillMark, ...]

    def missing(self) -> list[str]:
        return [s.name for s in self.skills if s.status == "missing"]

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Skills":
        return Skills(d["years"], d["years_quote"], d["stack"],
                      tuple(SkillMark(s["name"], s["status"]) for s in d["skills"]))


@dataclass(frozen=True)
class Usage:
    """One model call's bill, zeros when the run gave none. `usd` is Claude's own estimate at
    API list rates; the subscription does not bill per token, so it is a drift gauge."""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    usd: float = 0.0

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(self.input_tokens + other.input_tokens, self.output_tokens + other.output_tokens,
                     self.cache_read_tokens + other.cache_read_tokens,
                     self.cache_write_tokens + other.cache_write_tokens, self.usd + other.usd)

    @staticmethod
    def from_dict(d: dict) -> "Usage":
        return Usage(**{k: d[k] for k in Usage.__dataclass_fields__ if k in d})


@dataclass
class Cost:
    """One stage's sum: how many calls it made, how many verdicts it reused, how many calls
    failed, and the bill."""
    calls: int = 0
    cached: int = 0
    failed: int = 0
    usage: Usage = field(default_factory=Usage)

    def add(self, u: Usage) -> None:
        self.calls += 1
        self.usage = self.usage + u

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "Cost":
        return Cost(int(d.get("calls", 0)), int(d.get("cached", 0)), int(d.get("failed", 0)),
                    Usage.from_dict(d.get("usage", {})))


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
