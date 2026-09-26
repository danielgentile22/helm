// Where a thing stands at a given `now`. Never stored, always computed, which is what
// keeps the status files free of a phase that would be wrong a minute later (ADR 0020).

import type { Ms, Phase, Thing } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A landed job stays in the wake for a week. A todo past its date is late at once. */
export const WAKE_MS = 7 * DAY_MS;
const COLD_MS = 37 * DAY_MS;

/** 1 the moment a todo turns late, 0 once it has been late for thirty days more. */
export function heat(lateMs: number): number {
  const fall = (COLD_MS - lateMs) / (COLD_MS - WAKE_MS);
  return Math.min(1, Math.max(0, fall));
}

function late(lateMs: number): Phase {
  return { state: "late", lateMs, heat: heat(lateMs) };
}

function landedOrArriving(at: Ms, now: Ms): Phase {
  if (at > now) return { state: "arriving", inMs: at - now };
  return { state: "landed", agoMs: Math.max(0, now - (at + HOUR_MS)) };
}

/** An event is over an hour after it starts, like a job. It is never late. */
export function phase(thing: Thing, now: Ms): Phase {
  if (thing.kind === "job") return landedOrArriving(thing.at, now);
  if (thing.kind === "event") return landedOrArriving(thing.at ?? thing.since, now);
  if (thing.kind === "daily") return { state: "daily", done: thing.doneToday };
  if (thing.at === null) return { state: "open", ageMs: Math.max(0, now - thing.since) };
  if (thing.at > now) return { state: "arriving", inMs: thing.at - now };
  return late(now - thing.at);
}
