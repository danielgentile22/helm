#!/usr/bin/env python3
"""The job search routine: search, detail, eligibility, skills, rank, tailor, report. One
stage after another, each leaving its result as JSON under `~/.helm/status/job-search/<day>/`
beside the drops it made, so a stage can be rerun alone with `--only` and a reader can see
what every stage decided. The pool at `pool.json` carries judged postings across days.

    run.py                      what launchd runs: the whole day
    run.py --only rank          rerun one stage from the previous stage's file
    run.py --limit 2            tailor only the first two picks, for a cheap end to end
    run.py --only tailor --force  tailor every pick again, even the folders already done
    run.py --desktop /tmp/d     write the morning folder somewhere other than ~/Desktop
    run.py --replay --day D     rerun the cascade over a past day's cards from the cache, no LinkedIn,
                                no pool, no note, no PDF; the files and the funnel land in <day>/replay/

Safe to run late (the day is today's date at the start, not 04:00) and safe to run twice (every
file is overwritten, a pool record written today counts as new again, and a todo already on
the note is left alone).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import claude  # noqa: E402
import funnel  # noqa: E402
import linkedin  # noqa: E402
import passes  # noqa: E402
import rank  # noqa: E402
import report  # noqa: E402
import screen  # noqa: E402
import tailor  # noqa: E402
from model import (CRITERIA_PATH, Cost, Criteria, Dropped, Eligibility, Pick, Posting, Skills,  # noqa: E402
                   Usage, dump, load_picks, load_postings, verdict_key)
from pool import Pool  # noqa: E402

ENGINE = HERE.parents[1]
STATE = Path(os.environ.get("HELM_STATE") or Path.home() / ".helm")
VAULT = Path(os.environ.get("HELM_VAULT_ROOT") or Path.home() / "Vault")
ROUTINE = "job-search"
STAGES = ("search", "detail", "eligibility", "skills", "rank", "tailor", "report")
RANK_TIMEOUT_S = 15 * 60
PASS_TIMEOUT_S = 4 * 60
PASS_WORKERS = 4
TAILOR_WORKERS = 2


class Run:
    def __init__(self, day: date, desktop: Path, limit: int | None, no_tailor: bool,
                 force: bool = False, replay: bool = False) -> None:
        self.replay = replay
        self.day = day
        self.today = day.isoformat()
        self.desktop = desktop
        self.limit = limit
        self.no_tailor = no_tailor
        self.force = force
        self.criteria = Criteria.load(VAULT / CRITERIA_PATH)
        self.source = STATE / "status" / ROUTINE / day.isoformat()
        self.dir = self.source / "replay" if replay else self.source
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cache = STATE / "status" / ROUTINE / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.pool = Pool(None, {}) if replay else \
            Pool.load(STATE / "status" / ROUTINE / "pool.json", STATE / "status" / ROUTINE / "seen.json")
        self.verdicts = STATE / "status" / ROUTINE / "verdicts"
        self.sandbox = STATE / "status" / ROUTINE / "sandbox"
        self.skills_path = VAULT / self.criteria.skills_note
        self.folder = desktop / f"Jobs {day.isoformat()}"
        self.pdf = desktop / f"Jobs {day.isoformat()}.pdf"
        self.note_path = VAULT / "Atlas/Work/research" / f"{report.note_stem(day, self.criteria.count)}.md"
        self.dropped_path = VAULT / "Atlas/Work/research" / f"{report.dropped_stem(day)}.md"
        self.mirror = VAULT / "Atlas/Work/files/applications" / day.isoformat()

    def say(self, line: str) -> None:
        print(line, flush=True)

    # search: cards per bucket until its target of new ones is met, title screened, pool screened

    def search(self) -> None:
        c = self.criteria
        cards: dict[str, Posting] = {}
        new = {bucket: 0 for bucket in c.targets}
        known = {pid for pid, rec in self.pool.records.items() if rec.day != self.today}
        for q in c.queries:
            bucket = "remote" if q.remote else "home"
            want = c.targets.get(bucket, 0) - new[bucket]
            if want <= 0:
                self.say(f"search  {q.keywords!r} in {q.location!r}: skipped, the {bucket} target is met")
                continue
            found = linkedin.search(q, c, set(cards) | known, want)
            fresh = 0
            for p in found:
                if p.id in cards:
                    continue
                cards[p.id] = p
                if p.id not in known:
                    fresh += 1
            new[bucket] += fresh
            self.say(f"search  {q.keywords!r} in {q.location!r}: {len(found)} cards, {fresh} new")
        if not cards:
            raise RuntimeError("LinkedIn returned no cards for any query; throttled or the markup changed")
        kept = self.screen_cards(list(cards.values()))
        self.say(f"search  {len(cards)} unique ({', '.join(f'{n} {b}' for b, n in new.items())} new), "
                 f"{kept} kept after the title and pool screen")

    def screen_cards(self, cards: list[Posting]) -> int:
        """The title and pool screen over every card pulled. Writes cards.json whole and the
        drops beside it; returns how many survived."""
        c = self.criteria
        dropped: list[Dropped] = []
        for p in cards:
            rec = self.pool.known(p.id)
            if rec is not None and rec.day != self.today:
                dropped.append(Dropped(p.id, "pool", f"{rec.status} {rec.day}"))
                continue
            reason = screen.title_reason(p, c)
            if reason:
                dropped.append(Dropped(p.id, "search", reason))
                self.pool.drop(p, "search", reason, self.today)
        dump(self.dir / "cards.json", cards)
        dump(self.dir / "dropped-search.json", dropped)
        self.pool.save()
        return len(cards) - len(dropped)

    # detail: fetch each kept card's page, screen the description

    def detail(self) -> None:
        c = self.criteria
        gone = {d["id"] for d in json.loads((self.dir / "dropped-search.json").read_text())}
        cards = [p for p in load_postings(self.dir / "cards.json") if p.id not in gone]
        kept: list[Posting] = []
        dropped: list[Dropped] = []
        failed = 0
        for p in cards:
            cached = self.cache / f"{p.id}.json"
            if cached.exists():
                p = Posting.from_dict(json.loads(cached.read_text()))
            elif self.replay:
                dropped.append(Dropped(p.id, "detail", "not cached"))
                continue
            else:
                try:
                    p = linkedin.fetch_posting(p)
                except ValueError as e:
                    failed += 1
                    dropped.append(Dropped(p.id, "detail", f"not fetched: {e}"))
                    continue
                cached.write_text(json.dumps(p.__dict__, ensure_ascii=False))
            reason = screen.description_reason(p, c)
            if reason:
                dropped.append(Dropped(p.id, "detail", reason))
                self.pool.drop(p, "detail", reason, self.today)
            else:
                kept.append(p)
        if cards and failed == len(cards):
            raise RuntimeError("no posting page could be fetched; LinkedIn is throttling")
        dump(self.dir / "postings.json", kept)
        dump(self.dir / "dropped-detail.json", dropped)
        self.pool.save()
        self.say(f"detail  {len(cards)} fetched ({failed} failed), {len(kept)} kept after the description screen")

    # eligibility and skills: one model call per batch of postings, a fixed JSON form each, code decides the drop

    def skills_text(self) -> str:
        if not self.skills_path.exists():
            raise RuntimeError(f"the skills inventory {self.criteria.skills_note} is not in the vault; "
                               f"criteria.json names it under skills_note")
        return self.skills_path.read_text()

    def rows(self, name: str) -> list[dict]:
        """The rows of a verdict file, each `{"posting": Posting, ...verdict dicts}`."""
        out = []
        for row in json.loads((self.dir / name).read_text()):
            row["posting"] = Posting.from_dict(row["posting"])
            out.append(row)
        return out

    def verdicts_of(self, pid: str) -> dict:
        """The verdict file: each pass's form under its name, beside the key it was asked
        under, so the two passes expire independently."""
        path = self.verdicts / f"{pid}.json"
        return json.loads(path.read_text()) if path.exists() else {}

    def cached_verdict(self, pid: str, stage: str, key: str) -> dict | None:
        data = self.verdicts_of(pid)
        return data.get(stage) if data.get(f"{stage}_key") == key else None

    def remember(self, pid: str, stage: str, key: str, verdict: dict) -> None:
        data = self.verdicts_of(pid)
        data[stage], data[f"{stage}_key"] = verdict, key
        self.verdicts.mkdir(parents=True, exist_ok=True)
        tmp = self.verdicts / f"{pid}.json.tmp"
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(self.verdicts / f"{pid}.json")

    def add_cost(self, stage: str, cost: Cost) -> None:
        path = self.dir / "costs.json"
        costs = json.loads(path.read_text()) if path.exists() else {}
        costs[stage] = cost.to_dict()
        path.write_text(json.dumps(costs, indent=1))

    def judge(self, stage: str, rows: list[dict], prompt_for, parse, reason) -> tuple[list[dict], list[Dropped]]:
        """Run `stage` over `rows`: a cached verdict under the pass's current key is reused,
        the rest are asked in batches of `batch_size`, one model call each. A batch whose call
        fails, will not parse, or leaves an id unanswered is asked once more for the postings
        still without a verdict; a posting without one after that is dropped closed. The calls
        run from an empty directory, not the vault, so no instructions file rides along on
        every prompt. Returns the rows that passed, each with the verdict added, and the
        drops."""
        c = self.criteria
        model, effort = claude.pass_registry(ROUTINE, stage)
        key = verdict_key(stage, c, self.skills_text())
        self.sandbox.mkdir(parents=True, exist_ok=True)
        cost = Cost()
        verdicts: dict[str, dict] = {}
        pending: list[Posting] = []
        for row in rows:
            p: Posting = row["posting"]
            cached = self.cached_verdict(p.id, stage, key)
            if cached:
                verdicts[p.id] = cached
                cost.cached += 1
            else:
                pending.append(p)
        batches = [pending[i:i + c.batch_size] for i in range(0, len(pending), c.batch_size)]

        def ask(batch: list[Posting]) -> tuple[dict[str, dict], str, Usage]:
            out = claude.run(prompt_for(batch), model, effort, cwd=self.sandbox, timeout_s=PASS_TIMEOUT_S, read_only=True)
            if not out.ok:
                return {}, f"call failed ({'timed out' if out.timed_out else out.returncode}): {out.tail(300)}", out.usage
            try:
                forms = parse(out.stdout)
            except (ValueError, json.JSONDecodeError) as e:
                return {}, f"call failed (unparsable answer: {e}): {out.tail(300)}", out.usage
            return {p.id: forms[p.id].to_dict() for p in batch if p.id in forms}, "", out.usage

        def one(batch: list[Posting]) -> tuple[dict[str, dict], str, list[Usage]]:
            got, failure, usage = ask(batch)
            attempts = [usage]
            if len(got) < len(batch):
                more, failure, usage = ask([p for p in batch if p.id not in got])
                got.update(more)
                attempts.append(usage)
            return got, failure, attempts

        with ThreadPoolExecutor(max_workers=PASS_WORKERS) as workers:
            results = list(workers.map(one, batches))
        failures: dict[str, str] = {}
        for batch, (got, failure, attempts) in zip(batches, results):
            for usage in attempts:
                cost.add(usage)
            for p in batch:
                if p.id in got:
                    verdicts[p.id] = got[p.id]
                    self.remember(p.id, stage, key, got[p.id])
                else:
                    failures[p.id] = failure or "call failed (no verdict for this posting in the answer)"
        kept: list[dict] = []
        dropped: list[Dropped] = []
        for row in rows:
            p = row["posting"]
            if p.id in failures:
                cost.failed += 1
                dropped.append(Dropped(p.id, stage, failures[p.id]))
                continue
            why = reason(verdicts[p.id])
            if why:
                dropped.append(Dropped(p.id, stage, why))
                self.pool.drop(p, stage, why, self.today)
            else:
                kept.append({**row, stage: verdicts[p.id]})
        self.add_cost(stage, cost)
        if rows and cost.failed == len(rows):
            raise RuntimeError(f"every {stage} call failed: {dropped[0].why}")
        return kept, dropped

    def eligibility(self) -> None:
        c = self.criteria
        rows = [{"posting": p} for p in load_postings(self.dir / "postings.json")]
        kept, dropped = self.judge("eligibility", rows, lambda batch: passes.eligibility_prompt(batch, c),
                                   passes.parse_eligibility,
                                   lambda v: passes.eligibility_reason(Eligibility.from_dict(v), c))
        dump(self.dir / "eligible.json", kept)
        dump(self.dir / "dropped-eligibility.json", dropped)
        self.pool.save()
        self.say(f"eligibility  {len(rows)} judged, {len(kept)} eligible")

    def skills(self) -> None:
        c = self.criteria
        text = self.skills_text()
        rows = self.rows("eligible.json")
        kept, dropped = self.judge("skills", rows, lambda batch: passes.skills_prompt(batch, c, text),
                                   passes.parse_skills, lambda v: passes.skills_reason(Skills.from_dict(v), c))
        dump(self.dir / "judged.json", kept)
        dump(self.dir / "dropped-skills.json", dropped)
        self.pool.save()
        self.say(f"skills  {len(rows)} judged, {len(kept)} match")

    # rank: one model call over today's judged postings and the pool's live ones

    def carried(self, skip: set[str]) -> list[dict]:
        """The pool's live records from earlier days, as rank rows, from the posting cache and
        the verdict cache. A record missing either is left in the pool and logged."""
        rows = []
        for pid, rec in self.pool.live().items():
            if pid in skip:
                continue
            cached = self.cache / f"{pid}.json"
            v = self.verdicts_of(pid)
            if not cached.exists() or not v:
                self.say(f"rank    {pid} ({rec.title} at {rec.company}) carried but not cached, skipped")
                continue
            if not v.get("eligibility") or not v.get("skills"):
                self.say(f"rank    {pid} ({rec.title} at {rec.company}) carried without both verdicts, skipped")
                continue
            rows.append({"posting": Posting.from_dict(json.loads(cached.read_text())),
                         "eligibility": v["eligibility"], "skills": v["skills"], "source": "carried"})
        return rows

    def rank(self) -> None:
        c = self.criteria
        self.pool.unpick(self.today)
        expired = self.pool.expire(self.day, c.pool_days)
        if expired:
            self.say(f"rank    {len(expired)} pool entries expired")
        new = [{**row, "source": "new"} for row in self.rows("judged.json")]
        for row in new:
            rec = self.pool.known(row["posting"].id)
            if rec is None or rec.day == self.today:
                self.pool.judged(row["posting"], self.today)
        rows = new + self.carried({row["posting"].id for row in new})
        if not rows:
            for name in ("ranked.json", "picks.json", "dropped-rank.json"):
                dump(self.dir / name, [])
            self.pool.save()
            self.say("rank    nothing survived the passes and the pool is empty; no picks today")
            return
        rows.sort(key=lambda r: screen.prescore(r["posting"], c, self.day), reverse=True)
        short = rows[: c.shortlist]
        dump(self.dir / "ranked.json", [{"id": r["posting"].id, "source": r["source"]} for r in short])
        text = rank.prompt(short, c, self.day, "Atlas/Work/Job Search.md")
        (self.dir / "rank-prompt.txt").write_text(text)
        model, effort = claude.registry("routines", ROUTINE)
        out = claude.run(text, model, effort, cwd=VAULT, timeout_s=RANK_TIMEOUT_S, read_only=True)
        (self.dir / "rank-answer.txt").write_text(out.stdout + "\n--- stderr ---\n" + out.stderr)
        cost = Cost()
        cost.add(out.usage)
        if not out.ok:
            cost.failed += 1
            self.add_cost("rank", cost)
            self.pool.save()
            raise RuntimeError(f"the ranker failed ({'timed out' if out.timed_out else out.returncode}): {out.tail()}")
        self.add_cost("rank", cost)
        picks, overturned, passed = rank.parse(out.stdout, [r["posting"] for r in short], c.count)
        by_id = {r["posting"].id: r["posting"] for r in short}
        why = {d.id: d.why for d in passed}
        dump(self.dir / "ranked.json", [{"id": r["posting"].id, "source": r["source"], "why": why.get(r["posting"].id, "")}
                                        for r in short])
        for d in overturned:
            self.pool.drop(by_id[d.id], "rank", d.why, self.today)
        for pk in picks:
            self.pool.pick(pk.posting.id, self.today)
        self.pool.save()
        dump(self.dir / "picks.json", [pk.to_dict() for pk in picks])
        dump(self.dir / "dropped-rank.json", overturned)
        carried = sum(1 for r in short if r["source"] == "carried")
        self.say(f"rank    {len(short)} read ({carried} carried), {len(overturned)} overturned, {len(picks)} picked")

    # tailor: one headless resume-tailor run per pick, into the morning folder

    def tailor(self) -> None:
        picks = load_picks(self.dir / "picks.json")
        todo = picks[: self.limit] if self.limit else picks
        if self.no_tailor or not self.criteria.tailor:
            self.say("tailor  skipped")
            return
        self.folder.mkdir(parents=True, exist_ok=True)

        def one(pk: Pick) -> tuple[Pick, Usage | None]:
            folder = self.folder / tailor.folder_name(pk)
            log = self.dir / f"tailor-{pk.posting.id}.log"
            if not self.force and folder.exists() and tailor.check(folder, self.criteria.resume_deny) is None:
                pk.folder, pk.tailored, pk.tailor_note = str(folder), True, ""
                self.say(f"tailor  {pk.rank:02d} {pk.posting.company}: already done")
                return pk, None
            done, usage = tailor.tailor(pk, folder, VAULT, self.day, log, self.criteria.resume_deny)
            self.say(f"tailor  {pk.rank:02d} {pk.posting.company}: {'ok' if done.tailored else done.tailor_note}")
            return done, usage

        with ThreadPoolExecutor(max_workers=TAILOR_WORKERS) as workers:
            done = list(workers.map(one, todo))
        cost = Cost()
        for pk, usage in done:
            if usage is None:
                cost.cached += 1
            else:
                cost.add(usage)
                cost.failed += 0 if pk.tailored else 1
        self.add_cost("tailor", cost)
        by_rank = {pk.rank: pk for pk, _ in done}
        picks = [by_rank.get(pk.rank, pk) for pk in picks]
        dump(self.dir / "picks.json", [pk.to_dict() for pk in picks])

    # report: the funnel, the two vault notes, the mirror, the todo, the desktop PDF, the vault commit

    def dropped_rows(self) -> dict[str, list[report.Row]]:
        """Every drop the day recorded, by stage, each named from cards.json, the cache or the
        pool record, whichever knows the posting."""
        cards = {p.id: p for p in load_postings(self.dir / "cards.json")} if (self.dir / "cards.json").exists() else {}

        def name(pid: str) -> tuple[str, str]:
            if pid in cards:
                return cards[pid].title, cards[pid].company
            cached = self.cache / f"{pid}.json"
            if cached.exists():
                d = json.loads(cached.read_text())
                return d.get("title", ""), d.get("company", "")
            rec = self.pool.known(pid)
            return (rec.title, rec.company) if rec else ("", "")

        by_stage: dict[str, list[report.Row]] = {}
        for stage, _ in report.DROPPED_HEADINGS:
            file = self.dir / ("dropped-search.json" if stage == "pool" else f"dropped-{stage}.json")
            if not file.exists():
                continue
            for d in json.loads(file.read_text()):
                if d["stage"] != stage:
                    continue
                by_stage.setdefault(stage, []).append(report.Row(d["id"], *name(d["id"]), d["why"]))
        return by_stage

    def carried_rows(self) -> list[report.Row]:
        return [report.Row(pid, r.title, r.company, f"judged {r.day}, posted {r.posted or 'unknown'}")
                for pid, r in sorted(self.pool.live().items(), key=lambda kv: kv[1].posted, reverse=True)]

    def report(self, failed: str | None = None) -> None:
        picks = load_picks(self.dir / "picks.json") if (self.dir / "picks.json").exists() else []
        if failed:
            picks = []
        f = funnel.compute(self.dir)
        (self.dir / "funnel.json").write_text(json.dumps(f.to_dict(), indent=1))
        self.note_path.parent.mkdir(parents=True, exist_ok=True)
        self.note_path.write_text(report.note(picks, f, self.day, failed))
        self.dropped_path.write_text(report.dropped_note(self.day, self.dropped_rows(), self.carried_rows(),
                                                         self.criteria.count))
        if self.folder.exists() and any(self.folder.iterdir()):
            if self.mirror.exists():
                shutil.rmtree(self.mirror)
            shutil.copytree(self.folder, self.mirror)
        self.desktop.mkdir(parents=True, exist_ok=True)
        tex_path = self.dir / "report.tex"
        tex_path.write_text(report.report_tex(picks, self.day, f, failed))
        problem = report.compile_pdf(tex_path, self.pdf)
        if problem:
            raise RuntimeError(f"the report PDF did not compile: {problem}")
        self.commit_vault()
        if picks and not failed:
            self.add_todo(len(picks))
        self.say(f"report  {funnel.line(f)}")
        self.say(f"report  {self.pdf} and {self.note_path.relative_to(VAULT)}")

    def commit_vault(self) -> None:
        if not (VAULT / ".git").exists():
            return
        paths = [str(self.note_path.relative_to(VAULT)), str(self.dropped_path.relative_to(VAULT))]
        if self.mirror.exists():
            paths.append(str(self.mirror.relative_to(VAULT)))
        subprocess.run(["git", "-C", str(VAULT), "add", "-A", "--", *paths], check=True, capture_output=True)
        staged = subprocess.run(["git", "-C", str(VAULT), "diff", "--cached", "--quiet", "--", *paths])
        if staged.returncode != 0:
            subprocess.run(["git", "-C", str(VAULT), "commit", "-q", "-m",
                            f"Record the {self.day.isoformat()} job search", "--", *paths],
                           check=True, capture_output=True)

    def add_todo(self, count: int) -> None:
        text = report.todo_text(report.note_stem(self.day, self.criteria.count), count)
        argv = [sys.executable, str(ENGINE / "runner/producers/todo_edit.py"), "add", "Work", text,
                "--due", self.day.isoformat()]
        if not (VAULT / ".git").exists():
            argv.append("--no-commit")
        if self.criteria.todo_directive:
            argv += ["--project", self.criteria.todo_directive]
        r = subprocess.run(argv, capture_output=True, text=True, cwd=str(ENGINE))
        if r.returncode != 0 and "already" not in (r.stdout + r.stderr):
            self.say(f"todo    not added: {(r.stdout + r.stderr).strip()[-300:]}")

    # replay: the cascade again over a past day's cards, from the cache, against no pool

    def replay_day(self) -> None:
        """The day's cards again through every stage after search, into `<day>/replay/`, so
        the files of the morning the owner was shown stay as they were."""
        cards = load_postings(self.source / "cards.json")
        (self.dir / "costs.json").unlink(missing_ok=True)
        self.say(f"replay  {self.today}: {len(cards)} cards from cards.json, "
                 f"{self.screen_cards(cards)} kept after the title screen")
        for stage in ("detail", "eligibility", "skills", "rank"):
            getattr(self, stage)()
        f = funnel.compute(self.dir)
        (self.dir / "funnel.json").write_text(json.dumps(f.to_dict(), indent=1))
        (self.dir / "funnel.md").write_text(f"{funnel.line(f)}\n\n{funnel.table(f)}")
        self.say(f"replay  {funnel.line(f)}")

    def status(self, result: str, failures: int, detail: str = "") -> None:
        path = STATE / "status" / f"{ROUTINE}.json"
        picks = load_picks(self.dir / "picks.json") if (self.dir / "picks.json").exists() else []
        f = funnel.compute(self.dir)
        path.write_text(json.dumps({
            "routine": ROUTINE,
            "last_run": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "result": result,
            "failures": failures,
            "day": self.day.isoformat(),
            "picks": len(picks),
            "tailored": sum(1 for pk in picks if pk.tailored),
            "report": str(self.pdf).replace(str(Path.home()), "~"),
            "cost_usd": round(f.usd, 4),
            "pool_live": len(self.pool.live()),
            "detail": detail,
        }, indent=1))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--day", default=date.today().isoformat())
    ap.add_argument("--desktop", default=str(Path.home() / "Desktop"))
    ap.add_argument("--only", choices=STAGES)
    ap.add_argument("--limit", type=int, help="tailor only the first N picks")
    ap.add_argument("--no-tailor", action="store_true")
    ap.add_argument("--force", action="store_true", help="tailor again even where the folder is already done")
    ap.add_argument("--replay", action="store_true", help="rerun a past day's cascade from the cache, pool untouched")
    args = ap.parse_args(argv)

    if args.replay:
        day = date.fromisoformat(args.day)
        if day >= date.today():
            ap.error("--replay is for a past day; today's run is the live one")
        run = Run(day, Path(args.desktop).expanduser(), None, True, replay=True)
        if not (run.source / "cards.json").exists():
            ap.error(f"{run.source / 'cards.json'} does not exist; nothing to replay")
        run.replay_day()
        return 0

    run = Run(date.fromisoformat(args.day), Path(args.desktop).expanduser(), args.limit, args.no_tailor,
              args.force)
    stages = [args.only] if args.only else list(STAGES)
    try:
        for stage in stages:
            getattr(run, stage)()
    except Exception as e:  # noqa: BLE001
        detail = f"{stage} failed: {e}"
        run.say(f"FAIL  {detail}")
        traceback.print_exc()
        try:
            if stage != "report":
                run.report(failed=detail)
        except Exception as e2:  # noqa: BLE001
            run.say(f"FAIL  report failed too: {e2}")
        run.status("fail", 1, detail)
        return 1
    picks = load_picks(run.dir / "picks.json") if (run.dir / "picks.json").exists() else []
    untailored = [pk for pk in picks if pk.folder and not pk.tailored]
    run.status("pass" if not untailored else "fail", len(untailored),
               "; ".join(f"{pk.posting.company}: {pk.tailor_note}" for pk in untailored))
    return 1 if untailored else 0


if __name__ == "__main__":
    sys.exit(main())
