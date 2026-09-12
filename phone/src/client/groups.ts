/** Thread list grouping. Pure, no DOM. */

import type { ThreadSummary, TurnOutcome } from "../shared/protocol";

export type RowState = "running" | "done" | "error" | "orphaned" | "idle" | "archived";

export interface ThreadRow {
  summary: ThreadSummary;
  state: RowState;
  when: string;
}

export interface ThreadGroup {
  cwd: string;
  running: number;
  lastActivity: string;
  rows: ThreadRow[];
}

/** Exhaustive by construction: a new TurnOutcome fails to compile until it gets a row here. */
const OUTCOME_STATE: Record<TurnOutcome, RowState> = { ok: "done", error: "error", orphaned: "orphaned", interrupted: "idle" };

export function rowState(s: ThreadSummary): RowState {
  if (s.config.archivedAt !== null) return "archived";
  if (s.session === "running" || s.session === "warming") return "running";
  return s.lastOutcome === null ? "idle" : OUTCOME_STATE[s.lastOutcome];
}

const rowOf = (summary: ThreadSummary): ThreadRow => ({ summary, state: rowState(summary), when: summary.lastTurnEndedAt ?? summary.config.createdAt });

const desc = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

export function groupThreads(threads: readonly ThreadSummary[], showArchived: boolean): ThreadGroup[] {
  const byCwd = new Map<string, ThreadRow[]>();
  for (const s of threads) {
    const row = rowOf(s);
    if (row.state === "archived" && !showArchived) continue;
    const rows = byCwd.get(s.config.cwd);
    if (rows) rows.push(row);
    else byCwd.set(s.config.cwd, [row]);
  }

  const groups: ThreadGroup[] = [];
  for (const [cwd, rows] of byCwd) {
    rows.sort((a, b) => (a.state === b.state ? 0 : a.state === "running" ? -1 : b.state === "running" ? 1 : 0) || desc(a.when, b.when));
    groups.push({
      cwd,
      running: rows.filter((r) => r.state === "running").length,
      lastActivity: rows.reduce((max, r) => (r.when > max ? r.when : max), rows[0]!.when),
      rows,
    });
  }
  return groups.sort((a, b) => desc(a.lastActivity, b.lastActivity));
}
