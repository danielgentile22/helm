"""The morning funnel: what came in, what each stage removed, what was ranked and picked, and
what it cost. Computed from the stage files alone, so it can be rebuilt for any day.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from model import Cost

STAGE_LABELS = (("eligibility", "Eligibility"), ("skills", "Skills"), ("rank", "Rank"), ("tailor", "Tailor"))


@dataclass
class Funnel:
    pulled: dict[str, int] = field(default_factory=dict)
    known: int = 0
    title: int = 0
    unfetched: int = 0
    screen: int = 0
    eligibility: int = 0
    skills: int = 0
    carried: int = 0
    ranked: int = 0
    overturned: int = 0
    picked: int = 0
    costs: dict[str, Cost] = field(default_factory=dict)

    @property
    def total_pulled(self) -> int:
        return sum(self.pulled.values())

    @property
    def usd(self) -> float:
        return sum(c.usage.usd for c in self.costs.values())

    def to_dict(self) -> dict:
        d = {k: getattr(self, k) for k in ("pulled", "known", "title", "unfetched", "screen", "eligibility",
                                          "skills", "carried", "ranked", "overturned", "picked")}
        d["costs"] = {k: c.to_dict() for k, c in self.costs.items()}
        d["usd"] = round(self.usd, 4)
        return d


def _rows(day_dir: Path, name: str) -> list[dict]:
    path = day_dir / name
    return json.loads(path.read_text()) if path.exists() else []


def compute(day_dir: Path) -> Funnel:
    f = Funnel()
    for card in _rows(day_dir, "cards.json"):
        bucket = "remote" if card.get("remote") else "home"
        f.pulled[bucket] = f.pulled.get(bucket, 0) + 1
    for d in _rows(day_dir, "dropped-search.json"):
        if d["stage"] == "pool":
            f.known += 1
        else:
            f.title += 1
    for d in _rows(day_dir, "dropped-detail.json"):
        if d["why"].startswith(("not fetched", "not cached")):
            f.unfetched += 1
        else:
            f.screen += 1
    f.eligibility = len(_rows(day_dir, "dropped-eligibility.json"))
    f.skills = len(_rows(day_dir, "dropped-skills.json"))
    ranked = _rows(day_dir, "ranked.json")
    f.ranked = len(ranked)
    f.carried = sum(1 for r in ranked if r.get("source") == "carried")
    f.overturned = len(_rows(day_dir, "dropped-rank.json"))
    f.picked = len(_rows(day_dir, "picks.json"))
    costs = day_dir / "costs.json"
    if costs.exists():
        f.costs = {k: Cost.from_dict(v) for k, v in json.loads(costs.read_text()).items()}
    return f


def line(f: Funnel) -> str:
    buckets = ", ".join(f"{n} {b}" for b, n in sorted(f.pulled.items()))
    return (f"{f.total_pulled} pulled ({buckets}), {f.known} known, {f.title} cut by title, "
            f"{f.unfetched} unfetched, {f.screen} cut by the screen, {f.eligibility} by eligibility, "
            f"{f.skills} by skills, {f.carried} carried, {f.ranked} ranked, {f.overturned} overturned, "
            f"{f.picked} picked, ${f.usd:.2f}")


def table(f: Funnel) -> str:
    rows = [("Pulled", f.total_pulled, ", ".join(f"{n} {b}" for b, n in sorted(f.pulled.items()))),
            ("Already in the pool", f.known, ""),
            ("Cut by title or employer", f.title, ""),
            ("Not fetched", f.unfetched, ""),
            ("Cut by the description screen", f.screen, "regex, years, remote"),
            ("Cut by eligibility", f.eligibility, _cost(f, "eligibility")),
            ("Cut by skills", f.skills, _cost(f, "skills")),
            ("Carried from earlier days", f.carried, ""),
            ("Ranked", f.ranked, _cost(f, "rank")),
            ("Overturned by the ranker", f.overturned, ""),
            ("Picked", f.picked, _cost(f, "tailor"))]
    out = "| Stage | Count | Notes |\n|---|---:|---|\n"
    out += "\n".join(f"| {label} | {n} | {note} |" for label, n, note in rows)
    return out + f"\n\nTotal estimated cost at API list rates: ${f.usd:.2f}.\n"


def _cost(f: Funnel, stage: str) -> str:
    c = f.costs.get(stage)
    if c is None:
        return ""
    bits = [f"{c.calls} call{'s' if c.calls != 1 else ''}"]
    if c.cached:
        bits.append(f"{c.cached} cached")
    if c.failed:
        bits.append(f"{c.failed} failed")
    bits.append(f"{c.usage.tokens_in} in, "
                f"{c.usage.output_tokens} out, ${c.usage.usd:.2f}")
    return ", ".join(bits)
