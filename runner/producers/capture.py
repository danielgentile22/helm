#!/usr/bin/env python3
"""Capture: the producers that feed helm's dashboard. No Claude call anywhere in here.

Runs every source as its own failure domain, caches each under
`~/.helm/status/sources/`, then writes the two merged files the dashboard reads:

    ~/.helm/status/agenda.json     dated things: todos and scheduled jobs, plus every starred
                                  directive under `directives`, with or without todos
    ~/.helm/status/projects.json   every repo and workspace under ~/Projects, in flight

Both are overwritten, never appended. A source that fails keeps its last good rows and
says so in its own envelope under `sources.<name>`. Every time-dependent number (late,
age, days since touched) is left to the reader, which is the only one holding `now`.

    capture.py                        launchd, every 30 minutes; prints nothing on success
    capture.py --only todos           one source rerun; both merged files rewritten from the
                                      caches, so a todo ticked a second ago is in agenda.json
    capture.py --only todos --print   one source, printed, nothing written
"""
from __future__ import annotations

import argparse
import contextlib
import json
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import common  # noqa: E402
from schedule import cadence_seconds, parse_schedule  # noqa: E402
from sources import repos, routines, todos, trackers  # noqa: E402

ROUTINE = "capture"

SOURCES: dict[str, common.Collector] = {
    "todos": todos.collect,
    "routines": routines.collect,
    "repos": repos.collect,
    "trackers": trackers.collect,
}
AGENDA_SOURCES = ("todos", "routines")
PROJECT_SOURCES = ("repos", "trackers")


def cadence() -> int:
    models = json.loads((common.ENGINE / "models.json").read_text())
    return cadence_seconds(parse_schedule(models["routines"][ROUTINE]["schedule"]))


def latest_produced(runs: dict[str, common.SourceRun], names: tuple[str, ...]) -> str | None:
    """The newest `produced` among the sources in the file. Merging is not producing: a merge
    after one source reran would otherwise stamp the whole file as a second old while the
    routine rows in it are from half an hour ago (ADR 0013). None until something succeeds."""
    stamps = [runs[n].meta["produced"] for n in names if runs[n].meta["produced"]]
    return max(stamps, key=datetime.fromisoformat) if stamps else None


DIRECTIVE_FIELDS = ("dept", "name", "star", "path", "line")


def merge_agenda(runs: dict[str, common.SourceRun], tz: str) -> dict:
    """The todos source reports its starred directives as rows of kind `directive` in the
    same list as its todos, so they share its cache, its envelope and its failure domain:
    a failed run keeps the last good directives with the last good todos. They are lifted
    out here into a top-level `directives`, so `items` stays the dated things alone."""
    rows = [it for n in AGENDA_SOURCES for it in runs[n].items]
    items = [it for it in rows if it.get("kind") != "directive"]
    items.sort(key=lambda it: (it.get("at") is None, it.get("at") or "", it.get("title", "")))
    directives = [{k: it.get(k) for k in DIRECTIVE_FIELDS} for it in rows if it.get("kind") == "directive"]
    order = {d: i for i, d in enumerate(common.DEPARTMENTS)}
    directives.sort(key=lambda d: (order.get(d["dept"], len(order)), d["star"] or 9, d["name"] or ""))
    return {
        "produced": latest_produced(runs, AGENDA_SOURCES),
        "tz": tz,
        "sources": {n: runs[n].meta for n in AGENDA_SOURCES},
        "items": items,
        "directives": directives,
    }


def merge_projects(runs: dict[str, common.SourceRun]) -> dict:
    by_path = {t["path"]: t["tracker"] for t in runs["trackers"].items}
    in_flight = []
    for entry in runs["repos"].items:
        row = dict(entry)
        row["tracker"] = by_path.get(entry["path"])
        in_flight.append(row)
    return {
        "produced": latest_produced(runs, PROJECT_SOURCES),
        "sources": {n: runs[n].meta for n in PROJECT_SOURCES},
        "in_flight": in_flight,
    }


def held_for(name: str) -> contextlib.AbstractContextManager:
    """The vault write lock while the todos source runs, and nothing for the other sources.

    The todos source reads the notes the todo editor writes, and its collect takes seconds
    (a `git log -S` per line). Held from before the read until after the cache is replaced,
    a collect that started before a board click cannot write pre-click rows over the
    click's own re-merge; the click waits a few seconds instead. The other sources read
    nothing the editor writes."""
    return common.vault_write_lock() if name == "todos" else contextlib.nullcontext()


def write_merged(tz, cadence_s: int) -> str | None:
    """Merge from the caches on disk, never from the runs this process is holding.

    A full run takes as long as the repos and the trackers take, and the dashboard's toggle
    re-merges in the middle of it. Merging in-memory rows would write the pre-toggle todos
    over the fresh ones and leave the box ticked in the vault but open in agenda.json until
    the next capture. `run_source` writes each cache before it returns,
    so merging from the caches makes the last writer the one with the freshest set."""
    runs = {n: common.cached_run(n, cadence_s) for n in SOURCES}
    agenda = merge_agenda(runs, str(tz))
    common.write_json(common.STATUS / "agenda.json", agenda)
    common.write_json(common.STATUS / "projects.json", merge_projects(runs))
    return agenda["produced"]


def refresh(only: str) -> str | None:
    """Rerun one source and re-merge both files from the caches. The dashboard calls this
    after its one vault write so agenda.json agrees with the note within a second.
    Returns agenda.json's `produced`, which is the rerun source's own stamp when it is the
    newest one in the file."""
    env = common.load_env()
    tz = common.local_tz(env)
    now = datetime.now(tz)
    cad = cadence()
    with held_for(only):
        common.run_source(only, SOURCES[only], env, now, cad)
        return write_merged(tz, cad)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=sorted(SOURCES), help="run one source")
    ap.add_argument("--print", action="store_true", help="print the rows instead of writing anything")
    a = ap.parse_args(argv)

    env = common.load_env()
    tz = common.local_tz(env)
    now = datetime.now(tz)

    if a.only and a.print:
        rows = SOURCES[a.only](env, now)
        json.dump(rows, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0

    cad = cadence()
    names = [a.only] if a.only else list(SOURCES)
    runs: dict[str, common.SourceRun] = {}
    for n in names:
        with held_for(n):
            runs[n] = common.run_source(n, SOURCES[n], env, now, cad)
    with common.vault_write_lock():
        write_merged(tz, cad)
    if a.only:
        r = runs[a.only]
        print(f"{'PASS' if r.meta['ok'] else 'FAIL'}  {a.only}: {r.meta['count']} rows"
              + ("" if r.meta["ok"] else f", {r.meta['reason']}"))
        return 0 if r.meta["ok"] else 1

    failed = [r for r in runs.values() if not r.meta["ok"]]
    for r in failed:
        print(f"FAIL  {r.name}: {r.meta['reason']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
