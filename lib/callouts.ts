// Cross-tab callout derivation — the shell's toast stack is a pure function of
// two vault snapshots (previous poll vs current). Extracted out of the HUD
// component so it's testable and tab-independent: a run fired on any tab
// surfaces its progress everywhere. Kept free of React.
//
// Contract: emit a toast only on a *transition* (a run reaching a terminal
// status, a fresh report landing). Because we diff prev → cur, the same event
// never re-emits on the next poll, and the first call (prev = null) primes
// silently — a freshly-loaded HUD doesn't replay history as a burst of toasts.

export type ToastKind = "started" | "done" | "failed" | "report";

export interface Toast {
  /** stable key — the shell dedupes and replaces on this */
  id: string;
  kind: ToastKind;
  label: string;
  /** doc path (kind "done"/"report") or URL (external run output) to open */
  target?: string;
}

export interface CalloutRun {
  id: string;
  skill: string;
  label: string | null;
  status: string; // running | ok | error | ...
  deliverable_path: string | null;
  link: string | null;
}

export interface CalloutSnapshot {
  runs: CalloutRun[];
  /** vault-relative path of today's morning report, or null */
  reportRel: string | null;
}

function runLabel(r: CalloutRun): string {
  return r.label ? `${r.label} ask` : r.skill.replace(/-/g, " ");
}

/**
 * New toasts to add, given the previous snapshot and the current one.
 *
 * - a run newly seen as `running` → a "started" toast
 * - a run newly reaching `ok` → a "done" toast (target = link ?? deliverable)
 * - a run newly reaching `error` → a "failed" toast
 * - the morning report path changing → a "report" toast
 *
 * prev = null primes silently. Toast ids are keyed by run id + kind so the
 * shell can replace a "started" with its "done" in place and never stacks
 * duplicates across polls.
 */
export function deriveCallouts(prev: CalloutSnapshot | null, cur: CalloutSnapshot): Toast[] {
  if (!prev) return []; // prime silently on first sight
  const out: Toast[] = [];

  const prevById = new Map(prev.runs.map((r) => [r.id, r]));
  for (const r of cur.runs) {
    const before = prevById.get(r.id);
    const wasTerminal = before && (before.status === "ok" || before.status === "error");
    if (wasTerminal) continue; // already reported — never re-emit

    if (r.status === "ok") {
      out.push({
        id: `done:${r.id}`,
        kind: "done",
        label: runLabel(r),
        target: r.link ?? r.deliverable_path ?? undefined,
      });
    } else if (r.status === "error") {
      out.push({ id: `failed:${r.id}`, kind: "failed", label: runLabel(r) });
    } else if (r.status === "running" && !before) {
      // only announce the START of a run we haven't seen before
      out.push({ id: `started:${r.id}`, kind: "started", label: runLabel(r) });
    }
  }

  if (cur.reportRel && cur.reportRel !== prev.reportRel) {
    out.push({
      id: `report:${cur.reportRel}`,
      kind: "report",
      label: "morning report",
      target: cur.reportRel,
    });
  }

  return out;
}
