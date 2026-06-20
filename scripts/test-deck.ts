// Command-deck state sweep — deriveDeckState(skills, runs, queue) maps each
// roster skill to idle / queued / running by correlating in-flight runs and the
// pending queue. Pure, no DOM, no I/O. Run: npx -y tsx scripts/test-deck.ts
import { deriveDeckState, type DeckRun, type DeckQueueItem } from "../lib/deck";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

const ROSTER = ["morning-report", "inbox-brief", "plan-today"];
const run = (skill: string, status: string, ts_started: string | null = null): DeckRun => ({
  skill,
  status,
  ts_started,
});
const q = (skill: string): DeckQueueItem => ({ skill });

// --- empty → everything idle -----------------------------------------------
const idle = deriveDeckState(ROSTER, [], []);
check(Object.keys(idle).length === ROSTER.length, "output has exactly one entry per roster skill");
check(
  ROSTER.every((s) => idle[s].phase === "idle" && idle[s].startedAt === null && idle[s].queued === 0),
  "no runs + no queue → every skill idle, no start, 0 queued"
);

// --- a running run ----------------------------------------------------------
const r1 = deriveDeckState(ROSTER, [run("inbox-brief", "running", "2026-06-20T10:00:00Z")], []);
check(r1["inbox-brief"].phase === "running", "a status=running run marks that skill running");
check(r1["inbox-brief"].startedAt === "2026-06-20T10:00:00Z", "running carries the run's start time");
check(r1["morning-report"].phase === "idle", "other skills stay idle");

// --- a queued intent --------------------------------------------------------
const r2 = deriveDeckState(ROSTER, [], [q("plan-today")]);
check(r2["plan-today"].phase === "queued", "a queue entry marks that skill queued");
check(r2["plan-today"].queued === 1, "queued count reflects the pending intent");
check(r2["plan-today"].startedAt === null, "queued skill has no start time");

// --- running beats queued ---------------------------------------------------
const r3 = deriveDeckState(
  ROSTER,
  [run("morning-report", "running", "2026-06-20T09:00:00Z")],
  [q("morning-report")]
);
check(r3["morning-report"].phase === "running", "running takes precedence over a queued intent");
check(r3["morning-report"].queued === 1, "queued count still reported under a running phase");

// --- terminal runs are NOT running -----------------------------------------
const r4 = deriveDeckState(ROSTER, [run("inbox-brief", "ok", "2026-06-20T08:00:00Z")], []);
check(r4["inbox-brief"].phase === "idle", "an ok (completed) run does not mark a skill running");
const r4b = deriveDeckState(ROSTER, [run("inbox-brief", "error", "2026-06-20T08:00:00Z")], []);
check(r4b["inbox-brief"].phase === "idle", "an errored run does not mark a skill running");

// --- multiple queued of one skill -------------------------------------------
const r5 = deriveDeckState(ROSTER, [], [q("plan-today"), q("plan-today"), q("inbox-brief")]);
check(r5["plan-today"].queued === 2, "queued count tallies multiple intents for one skill");
check(r5["plan-today"].phase === "queued", "multiple queued → still queued");

// --- multiple running picks the latest start --------------------------------
const r6 = deriveDeckState(
  ROSTER,
  [
    run("plan-today", "running", "2026-06-20T10:00:00Z"),
    run("plan-today", "running", "2026-06-20T10:05:00Z"),
  ],
  []
);
check(r6["plan-today"].startedAt === "2026-06-20T10:05:00Z", "concurrent runs → latest start wins the clock");

// --- a null ts_started never displaces a real one ---------------------------
const r7 = deriveDeckState(
  ROSTER,
  [run("plan-today", "running", null), run("plan-today", "running", "2026-06-20T10:00:00Z")],
  []
);
check(r7["plan-today"].phase === "running", "running even with a null-start sibling");
check(r7["plan-today"].startedAt === "2026-06-20T10:00:00Z", "a null start does not overwrite a real start");

// --- runs/queue for off-roster skills are ignored ---------------------------
const r8 = deriveDeckState(ROSTER, [run("weekly-review", "running", "2026-06-20T10:00:00Z")], [q("vault-cleanup")]);
check(
  Object.keys(r8).length === ROSTER.length && ROSTER.every((s) => r8[s].phase === "idle"),
  "runs/queue outside the roster never appear and never flip a roster skill"
);

// --- summary ----------------------------------------------------------------
console.log(failed === 0 ? `\nAll deck checks pass.` : `\n${failed} deck check(s) failed.`);
process.exit(failed ? 1 : 0);
