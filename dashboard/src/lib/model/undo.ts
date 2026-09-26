// The undo window as data. A tick waits here before it is written, and the header reads the
// newest one back with its countdown. Times are the page's monotonic clock
// (performance.now), not epoch milliseconds, because only the gap between two of them matters.

import type { TodoId } from "./types";

export const UNDO_MS = 5000;

export type Tick = { todo: TodoId; label: string; at: number };

/** The ticks whose window has run out, to write now, and the ones still waiting. */
export function settle(ticks: readonly Tick[], now: number): { due: Tick[]; waiting: Tick[] } {
  const due = ticks.filter((t) => now - t.at >= UNDO_MS);
  return { due, waiting: ticks.filter((t) => !due.includes(t)) };
}

export type Banner = { label: string; seconds: number; more: number };

/** What the header says: the newest tick, whole seconds left rounded up so it never reads
 *  0s while it can still be undone, and how many older ones wait behind it. */
export function banner(ticks: readonly Tick[], now: number): Banner | null {
  const newest = ticks.at(-1);
  if (newest === undefined) return null;
  const seconds = Math.max(1, Math.ceil((newest.at + UNDO_MS - now) / 1000));
  return { label: newest.label, seconds, more: ticks.length - 1 };
}
