#!/usr/bin/env python3
"""The job search routine: search, detail, rank, tailor, report. One stage after another,
each leaving its result as JSON under `~/.helm/status/job-search/<day>/`, so a stage can be
rerun alone with `--only` and a reader can see what every stage decided.

    run.py                      what launchd runs: the whole day
    run.py --only rank          rerun one stage from the previous stage's file
    run.py --limit 2            tailor only the first two picks, for a cheap end to end
    run.py --only tailor --force  tailor every pick again, even the folders already done
    run.py --desktop /tmp/d     write the morning folder somewhere other than ~/Desktop

Safe to run late (the day is today's date at the start, not 04:00) and safe to run twice (every
file is overwritten, the ledger only hides postings reported on an earlier day, and a todo
already on the note is left alone).
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
import linkedin  # noqa: E402
import rank  # noqa: E402
import report  # noqa: E402
import screen  # noqa: E402
import tailor  # noqa: E402
from model import CRITERIA_PATH, Criteria, Dropped, Pick, Posting, dump, load_picks, load_postings  # noqa: E402

ENGINE = HERE.parents[1]
STATE = Path(os.environ.get("HELM_STATE") or Path.home() / ".helm")
VAULT = Path(os.environ.get("HELM_VAULT_ROOT") or Path.home() / "Vault")
ROUTINE = "job-search"
STAGES = ("search", "detail", "rank", "tailor", "report")
RANK_TIMEOUT_S = 15 * 60
TAILOR_WORKERS = 2


class Run:
    def __init__(self, day: date, desktop: Path, limit: int | None, no_tailor: bool,
                 force: bool = False) -> None:
        self.day = day
        self.desktop = desktop
        self.limit = limit
        self.no_tailor = no_tailor
        self.force = force
        self.criteria = Criteria.load(VAULT / CRITERIA_PATH)
        self.dir = STATE / "status" / ROUTINE / day.isoformat()
        self.dir.mkdir(parents=True, exist_ok=True)
        self.cache = STATE / "status" / ROUTINE / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.ledger_path = STATE / "status" / ROUTINE / "seen.json"
        self.folder = desktop / f"Jobs {day.isoformat()}"
        self.pdf = desktop / f"Jobs {day.isoformat()}.pdf"
        self.note_path = VAULT / "Atlas/Work/research" / f"{report.note_stem(day, self.criteria.count)}.md"
        self.mirror = VAULT / "Atlas/Work/files/applications" / day.isoformat()

    def say(self, line: str) -> None:
        print(line, flush=True)

    # search: cards from every query, deduplicated, title screened, ledger screened

    def ledger(self) -> dict[str, str]:
        if self.ledger_path.exists():
            return json.loads(self.ledger_path.read_text())
        return {}

    def search(self) -> None:
        c = self.criteria
        seen = self.ledger()
        cards: dict[str, Posting] = {}
        dropped: list[Dropped] = []
        for q in c.queries:
            found = linkedin.search(q, c.experience_levels, c.posted_within_days, c.pages)
            new = 0
            for p in found:
                if p.id in cards:
                    continue
                cards[p.id] = p
                new += 1
            self.say(f"search  {q.keywords!r} in {q.location!r}: {len(found)} cards, {new} new")
        kept: list[Posting] = []
        for p in cards.values():
            reason = screen.title_reason(p, c)
            if reason is None and seen.get(p.id) not in (None, self.day.isoformat()):
                reason = f"reported on {seen[p.id]}"
            if reason:
                dropped.append(Dropped(p.id, "search", reason))
            else:
                kept.append(p)
        if not cards:
            raise RuntimeError("LinkedIn returned no cards for any query; throttled or the markup changed")
        dump(self.dir / "cards.json", kept)
        dump(self.dir / "dropped-search.json", dropped)
        self.say(f"search  {len(cards)} unique, {len(kept)} kept after the title and ledger screen")

    # detail: fetch each kept card's page, screen the description

    def detail(self) -> None:
        c = self.criteria
        cards = load_postings(self.dir / "cards.json")
        kept: list[Posting] = []
        dropped: list[Dropped] = []
        failed = 0
        for p in cards:
            cached = self.cache / f"{p.id}.json"
            if cached.exists():
                p = Posting.from_dict(json.loads(cached.read_text()))
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
            else:
                kept.append(p)
        if cards and failed == len(cards):
            raise RuntimeError("no posting page could be fetched; LinkedIn is throttling")
        dump(self.dir / "postings.json", kept)
        dump(self.dir / "dropped-detail.json", dropped)
        self.say(f"detail  {len(cards)} fetched ({failed} failed), {len(kept)} kept after the description screen")

    # rank: one model call over the shortlist

    def rank(self) -> None:
        c = self.criteria
        postings = load_postings(self.dir / "postings.json")
        if not postings:
            raise RuntimeError("nothing survived the screen, so there is nothing to rank")
        short = screen.shortlist(postings, c, self.day)
        text = rank.prompt(short, c, self.day, "Atlas/Work/Job Search.md")
        (self.dir / "rank-prompt.txt").write_text(text)
        model, effort = claude.registry("routines", ROUTINE)
        out = claude.run(text, model, effort, cwd=VAULT, timeout_s=RANK_TIMEOUT_S, read_only=True)
        (self.dir / "rank-answer.txt").write_text(out.stdout + "\n--- stderr ---\n" + out.stderr)
        if not out.ok:
            raise RuntimeError(f"the ranker failed ({'timed out' if out.timed_out else out.returncode}): {out.tail()}")
        picks, dropped = rank.parse(out.stdout, short, c.count)
        ledger = self.ledger()
        for pk in picks:
            ledger.setdefault(pk.posting.id, self.day.isoformat())
        self.ledger_path.write_text(json.dumps(ledger, indent=1))
        dump(self.dir / "picks.json", [pk.to_dict() for pk in picks])
        dump(self.dir / "dropped-rank.json", dropped)
        self.say(f"rank    {len(short)} read, {len(picks)} picked")

    # tailor: one headless resume-tailor run per pick, into the morning folder

    def tailor(self) -> None:
        picks = load_picks(self.dir / "picks.json")
        todo = picks[: self.limit] if self.limit else picks
        if self.no_tailor or not self.criteria.tailor:
            self.say("tailor  skipped")
            return
        self.folder.mkdir(parents=True, exist_ok=True)

        def one(pk: Pick) -> Pick:
            folder = self.folder / tailor.folder_name(pk)
            log = self.dir / f"tailor-{pk.posting.id}.log"
            if not self.force and folder.exists() and tailor.check(folder, self.criteria.resume_deny) is None:
                pk.folder, pk.tailored, pk.tailor_note = str(folder), True, ""
                self.say(f"tailor  {pk.rank:02d} {pk.posting.company}: already done")
                return pk
            done = tailor.tailor(pk, folder, VAULT, self.day, log, self.criteria.resume_deny)
            self.say(f"tailor  {pk.rank:02d} {pk.posting.company}: {'ok' if done.tailored else done.tailor_note}")
            return done

        with ThreadPoolExecutor(max_workers=TAILOR_WORKERS) as pool:
            done = list(pool.map(one, todo))
        by_rank = {pk.rank: pk for pk in done}
        picks = [by_rank.get(pk.rank, pk) for pk in picks]
        dump(self.dir / "picks.json", [pk.to_dict() for pk in picks])

    # report: the vault note, the mirror, the todo, the desktop PDF, the vault commit

    def counts(self) -> tuple[int, int]:
        def n(name: str) -> int:
            p = self.dir / name
            return len(json.loads(p.read_text())) if p.exists() else 0
        searched = n("cards.json") + n("dropped-search.json")
        return searched, n("postings.json")

    def report(self, failed: str | None = None) -> None:
        picks = load_picks(self.dir / "picks.json") if (self.dir / "picks.json").exists() else []
        dropped = [Dropped(**d) for d in json.loads((self.dir / "dropped-rank.json").read_text())] \
            if (self.dir / "dropped-rank.json").exists() else []
        if failed:
            picks = []
        searched, screened = self.counts()
        self.note_path.parent.mkdir(parents=True, exist_ok=True)
        self.note_path.write_text(report.note(picks, dropped, self.day, searched, screened, failed))
        if self.folder.exists() and any(self.folder.iterdir()):
            if self.mirror.exists():
                shutil.rmtree(self.mirror)
            shutil.copytree(self.folder, self.mirror)
        self.desktop.mkdir(parents=True, exist_ok=True)
        tex_path = self.dir / "report.tex"
        tex_path.write_text(report.report_tex(picks, self.day, failed))
        problem = report.compile_pdf(tex_path, self.pdf)
        if problem:
            raise RuntimeError(f"the report PDF did not compile: {problem}")
        self.commit_vault()
        if picks and not failed:
            self.add_todo(len(picks))
        self.say(f"report  {self.pdf} and {self.note_path.relative_to(VAULT)}")

    def commit_vault(self) -> None:
        if not (VAULT / ".git").exists():
            return
        paths = [str(self.note_path.relative_to(VAULT))]
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

    def status(self, result: str, failures: int, detail: str = "") -> None:
        path = STATE / "status" / f"{ROUTINE}.json"
        picks = load_picks(self.dir / "picks.json") if (self.dir / "picks.json").exists() else []
        path.write_text(json.dumps({
            "routine": ROUTINE,
            "last_run": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "result": result,
            "failures": failures,
            "day": self.day.isoformat(),
            "picks": len(picks),
            "tailored": sum(1 for pk in picks if pk.tailored),
            "report": str(self.pdf).replace(str(Path.home()), "~"),
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
    args = ap.parse_args(argv)

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
