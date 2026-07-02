// Status derivation sweep — deriveStatus(state) over representative VaultState
// fixtures: all-clear, runner stale/busy, Morphy delta, open-for-you, failed
// run, pending queue. Pure: imports lib/status only. No I/O.
// Run: npx -y tsx scripts/test-status.ts
import { deriveStatus } from "../lib/status";
import type { VaultState, RunnerStatus, MorphyState, RunEntry, QueueEntry } from "../lib/vault";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// minimal VaultState with overrides — the fields deriveStatus reads
function state(over: Partial<VaultState> = {}): VaultState {
  return {
    generated_at: "2026-07-01T12:00:00Z",
    vault_root: "/tmp/vault",
    tz: "America/New_York",
    metrics: [],
    runner: null,
    daily: null,
    runs: [],
    queue: [],
    morning: null,
    morphy: null,
    agenda: null,
    etas: {},
    ...over,
  };
}
const runner = (over: Partial<RunnerStatus> = {}): RunnerStatus => ({
  ts: "2026-07-01T12:00:00Z",
  pid: 1,
  version: "1",
  busy: false,
  active: 0,
  max_concurrent: 2,
  pending: 0,
  heartbeat_age_s: 5,
  alive: true,
  ...over,
});
const morphy = (over: Partial<MorphyState> = {}): MorphyState => ({
  ok: true,
  last_sync_ts: "2026-07-01T11:00:00Z",
  ...over,
});
const run = (status: string): RunEntry => ({
  id: `r-${Math.round(Math.abs(status.length * 7.13))}-${status}`,
  skill: "morning-report",
  label: null,
  link: null,
  status,
  summary: "",
  ts_completed: null,
  ts_started: null,
  duration_s: null,
  deliverable_path: null,
});
const queued = (n: number): QueueEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `q${i}`, skill: "inbox-brief", label: null, ts: "" }));

// --- all clear -------------------------------------------------------------
{
  const s = deriveStatus(state({ runner: runner(), morphy: morphy() }));
  check(s.runner === "alive", "healthy machine: runner alive");
  check(s.healthy === true, "healthy machine: healthy flag true");
  check(s.needMeCount === 0, "healthy machine: nothing needs me");
}

// --- no runner at all → stale, unhealthy -----------------------------------
{
  const s = deriveStatus(state({ runner: null }));
  check(s.runner === "stale" && s.healthy === false, "missing runner is stale + unhealthy");
}

// --- runner heartbeat gone → stale -----------------------------------------
{
  const s = deriveStatus(state({ runner: runner({ alive: false }) }));
  check(s.runner === "stale", "dead heartbeat → stale");
  check(s.healthy === false, "stale runner drops healthy");
}

// --- runner busy → busy but still healthy ----------------------------------
{
  const s = deriveStatus(state({ runner: runner({ busy: true }) }));
  check(s.runner === "busy", "busy runner reads busy");
  check(s.healthy === true, "busy is activity, not ill-health");
}

// --- Morphy delta present (Michael added / closed) -------------------------
{
  const mp = morphy({
    delta: { since: null, added: [{ name: "A", addedBy: "Michael" }, { name: "B", addedBy: "Michael" }], closed: ["C"] },
  });
  const s = deriveStatus(state({ runner: runner(), morphy: mp }));
  check(s.morphy.added === 2, "counts 2 added since last sync");
  check(s.morphy.closed === 1, "counts 1 closed since last sync");
  check(s.needMeCount === 2, "added cards count toward need-me");
}

// --- open-for-you from the task list ---------------------------------------
{
  const mp = morphy({
    tasks: [
      { id: "1", name: "mine todo", status: "Todo", assignee: "Daniel", addedBy: null, priority: null, due: null },
      { id: "2", name: "mine blocked", status: "Blocked", assignee: "Daniel", addedBy: null, priority: null, due: null },
      { id: "3", name: "mine done", status: "Done", assignee: "Daniel", addedBy: null, priority: null, due: null },
      { id: "4", name: "his", status: "Todo", assignee: "Michael", addedBy: null, priority: null, due: null },
    ],
  });
  const s = deriveStatus(state({ runner: runner(), morphy: mp }));
  check(s.morphy.openForYou === 2, "open-for-you = Daniel's non-done tasks (2)");
  check(s.needMeCount === 2, "open-for-you feeds need-me");
}

// --- open-for-you falls back to open_by_assignee when no task list ----------
{
  const mp = morphy({ open_by_assignee: { Daniel: 3, Michael: 1 } });
  const s = deriveStatus(state({ runner: runner(), morphy: mp }));
  check(s.morphy.openForYou === 3, "falls back to open_by_assignee[Daniel]");
}

// --- board offline → not syncing, unhealthy --------------------------------
{
  const s = deriveStatus(state({ runner: runner(), morphy: morphy({ ok: false, reason: "no conn" }) }));
  check(s.morphy.syncing === false, "ok:false board is not syncing");
  check(s.healthy === false, "a board that stopped syncing drops healthy");
}

// --- never-synced board is not held against health -------------------------
{
  const s = deriveStatus(state({ runner: runner(), morphy: null }));
  check(s.morphy.syncing === true, "no board yet counts as syncing (unknown, not broken)");
  check(s.healthy === true, "a never-synced board doesn't make the system unhealthy");
}

// --- failed run → need-me, but NOT an infra alarm (stays healthy) ----------
{
  const s = deriveStatus(state({ runner: runner(), runs: [run("ok"), run("error")] }));
  check(s.failedRuns === 1, "counts the failed run");
  check(s.healthy === true, "a failed run wants attention but isn't an infra alarm (dot stays green→amber)");
  check(s.needMeCount === 1, "a failed run wants attention");
}

// --- pending queue is activity, not need-me --------------------------------
{
  const s = deriveStatus(state({ runner: runner(), queue: queued(3) }));
  check(s.pending === 3, "reports the queue depth");
  check(s.needMeCount === 0, "a full queue doesn't itself need me");
  check(s.healthy === true, "a full queue is healthy");
}

console.log(failed === 0 ? `\nAll status checks pass.` : `\n${failed} status check(s) failed.`);
process.exit(failed ? 1 : 0);
