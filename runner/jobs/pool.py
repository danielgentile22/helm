"""The pool: one record per posting the job search has met, with a status that says what
happened to it. It replaces the seen ledger.

    judged    passed every pass, never shown; the ranker reads it again tomorrow
    dropped   a stage cut it, with the reason, so it is never fetched or judged again
    picked    shown on a morning list, never shown again
    expired   judged, but its posting date is older than the pool age

Transitions are the only writes. A caller never sets `status` by hand. A pool with no path
is the replay's scratch pool: it accepts every transition and keeps none of them.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path

from model import Posting

@dataclass
class Record:
    status: str
    day: str
    posted: str = ""
    stage: str = ""
    why: str = ""
    picked: str = ""
    title: str = ""
    company: str = ""


class Pool:
    def __init__(self, path: Path | None, records: dict[str, Record]) -> None:
        self.path = path
        self.records = records

    @staticmethod
    def load(path: Path, seen_path: Path | None = None) -> "Pool":
        """When the pool file is missing and the old `seen.json` ledger exists, every ledger
        entry becomes a picked record and the ledger is removed, so nothing already applied
        to resurfaces."""
        if path.exists():
            raw = json.loads(path.read_text())
            return Pool(path, {k: Record(**v) for k, v in raw.items()})
        pool = Pool(path, {})
        if seen_path is not None and seen_path.exists():
            for pid, day in json.loads(seen_path.read_text()).items():
                pool.records[pid] = Record("picked", day, picked=day)
            pool.save()
            seen_path.unlink()
        return pool

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({k: asdict(v) for k, v in self.records.items()}, indent=1, ensure_ascii=False))
        tmp.replace(self.path)

    def known(self, pid: str) -> Record | None:
        return self.records.get(pid)

    def drop(self, p: Posting, stage: str, why: str, day: str) -> None:
        self.records[p.id] = Record("dropped", day, p.posted, stage, why, "", p.title, p.company)

    def judged(self, p: Posting, day: str) -> None:
        self.records[p.id] = Record("judged", day, p.posted, title=p.title, company=p.company)

    def pick(self, pid: str, day: str) -> None:
        r = self.records.get(pid)
        if r is None:
            raise KeyError(f"{pid} is not in the pool")
        r.status, r.picked = "picked", day

    def unpick(self, today: str) -> list[str]:
        """Today's picks back to judged, so a rerun of the same morning ranks the same set and
        a posting the second run passes over is not stranded as picked."""
        back = [pid for pid, r in self.records.items() if r.status == "picked" and r.picked == today]
        for pid in back:
            self.records[pid].status, self.records[pid].picked = "judged", ""
        return back

    def expire(self, today: date, pool_days: int) -> list[str]:
        """Judged records older than `pool_days` from their posting date, or from the day the
        pool met them when LinkedIn gave no date."""
        cutoff = (today - timedelta(days=pool_days)).isoformat()
        gone = []
        for pid, r in self.records.items():
            if r.status == "judged" and (r.posted or r.day) < cutoff:
                r.status = "expired"
                gone.append(pid)
        return gone

    def live(self) -> dict[str, Record]:
        return {pid: r for pid, r in self.records.items() if r.status == "judged"}
