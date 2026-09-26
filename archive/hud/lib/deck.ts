// Pure derivation of the command deck's per-skill live state. Kept out of the
// HUD component so a plain tsx test can import it without React.
//
// The deck correlates the runner's in-flight runs and the pending queue against
// the deck's skill roster. "running" is read from the SAME source the core's
// live task cards use — runs with status === "running" — so the deck's running
// indicator and the orbiting task callouts can never disagree.

export type DeckPhase = "idle" | "queued" | "running";

/** the slice of a RunEntry the deck cares about */
export interface DeckRun {
  skill: string;
  status: string;
  ts_started: string | null;
}

/** the slice of a QueueEntry the deck cares about */
export interface DeckQueueItem {
  skill: string;
}

export interface DeckSkillState {
  phase: DeckPhase;
  /** ISO start time of the active run when phase === "running"; else null */
  startedAt: string | null;
  /** how many intents for this skill are waiting in the queue (0 when none) */
  queued: number;
}

/**
 * Map each roster `skill` to its live deck state.
 *
 * Precedence: a run actually in flight ("running") beats anything queued, which
 * beats idle. When several runs of one skill are in flight (rare), the
 * most-recently-started one supplies `startedAt` so the elapsed clock tracks the
 * freshest work. Runs in a terminal status (ok / error) never mark a skill
 * running — they're history, surfaced elsewhere.
 */
export function deriveDeckState(
  skills: string[],
  runs: DeckRun[],
  queue: DeckQueueItem[]
): Record<string, DeckSkillState> {
  const out: Record<string, DeckSkillState> = {};
  for (const skill of skills) {
    let running = false;
    let startedAt: string | null = null;
    for (const r of runs) {
      if (r.skill !== skill || r.status !== "running") continue;
      running = true;
      // keep the latest start; a null ts_started never displaces a real one
      if (r.ts_started && (startedAt === null || r.ts_started > startedAt)) {
        startedAt = r.ts_started;
      }
    }
    const queued = queue.reduce((n, q) => (q.skill === skill ? n + 1 : n), 0);
    const phase: DeckPhase = running ? "running" : queued > 0 ? "queued" : "idle";
    out[skill] = { phase, startedAt: running ? startedAt : null, queued };
  }
  return out;
}
