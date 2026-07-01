// Health / need-me derivation — one pure function feeding three surfaces: the
// shell's health dot, the Morphy tab's need-me detail, and the phone glance.
// Kept free of React so a plain tsx test can exercise it over VaultState
// fixtures. This is the single source of truth for "is everything OK / does
// anything need me".

import type { VaultState } from "./vault";

export type RunnerHealth = "alive" | "busy" | "stale";

export interface Status {
  runner: RunnerHealth;
  /** everything nominal — feeds the green/amber/red shell dot */
  healthy: boolean;
  /** count of things asking for Daniel's attention (phone glance + dot badge) */
  needMeCount: number;
  morphy: {
    /** board is currently syncing (last sync didn't fail); null board = true */
    syncing: boolean;
    /** cards Michael added since the last sync you saw */
    added: number;
    /** cards closed since the last sync */
    closed: number;
    /** open cards assigned to Daniel (todo / in progress / blocked) */
    openForYou: number;
  };
  /** intents waiting in the queue */
  pending: number;
  /** recent runs that ended in error */
  failedRuns: number;
}

const OPEN_STATUSES = ["todo", "in progress", "blocked"];

function openForDaniel(state: VaultState): number {
  const mp = state.morphy;
  if (!mp || mp.ok === false) return 0;
  // prefer the task list (same "open" definition as the objective panel);
  // fall back to open_by_assignee when tasks aren't cached
  if (mp.tasks && mp.tasks.length) {
    return mp.tasks.filter(
      (t) => t.assignee === "Daniel" && OPEN_STATUSES.includes((t.status || "").toLowerCase())
    ).length;
  }
  return mp.open_by_assignee?.["Daniel"] ?? 0;
}

export function deriveStatus(state: VaultState): Status {
  const r = state.runner;
  const runner: RunnerHealth = !r || !r.alive ? "stale" : r.busy ? "busy" : "alive";

  const mp = state.morphy;
  const syncing = mp ? mp.ok !== false : true; // no board yet ≠ unhealthy
  const added = mp?.delta?.added?.length ?? 0;
  const closed = mp?.delta?.closed?.length ?? 0;
  const openForYou = openForDaniel(state);

  const pending = state.queue.length;
  const failedRuns = state.runs.filter((r) => r.status === "error").length;

  // things that actually want Daniel: his open cards, whatever Michael just
  // added, and any failed run. Queue depth and "busy" are activity, not need.
  const needMeCount = openForYou + added + failedRuns;

  // healthy = the infrastructure is up. Red is reserved for "something's
  // broken" — a stale runner or a board that stopped syncing. A failed run or
  // open work is a "look at this" (it rides needMeCount → the amber dot), not
  // an infrastructure alarm, so it doesn't force the dot red.
  const healthy = runner !== "stale" && syncing;

  return {
    runner,
    healthy,
    needMeCount,
    morphy: { syncing, added, closed, openForYou },
    pending,
    failedRuns,
  };
}
