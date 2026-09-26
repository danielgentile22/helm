// The talk loop as a table. A phase is a function of the phase before it and one event, so a
// transition nobody named cannot happen and no pair of booleans can disagree about whether the
// microphone is hot. The server's own turn phases (~/.helm/voice/turns/<id>.json) are the other
// half: the client only ever reads them through a poll event.

import { todoId } from "./types";
import type { TodoId } from "./types";

export type Phase =
  | { name: "offline" }
  | { name: "idle" }
  | { name: "listening" }
  | { name: "transcribing" }
  /** A headless run is in flight. `refused` is a press that arrived during it, cleared by the
   *  next transition, which is what lets the indicator say "still working" without a timer. */
  | { name: "working"; refused: boolean }
  | { name: "speaking"; says: string }
  | { name: "error"; message: string };

/** The phases a turn file goes through. heard -> working -> done | failed | cancelled. */
export type TurnPhase = "heard" | "working" | "done" | "failed" | "cancelled";

export type TurnOp = "add" | "tick" | "untick" | "edit" | "note";
export type TurnAction = { op: TurnOp; id: TodoId; dept: string; row: string };

export type Turn = {
  id: string;
  transcript: string;
  phase: TurnPhase;
  ack: string;
  confirmation: string | null;
  actions: readonly TurnAction[];
  error: string | null;
};

export type Event =
  | { kind: "press" }
  | { kind: "mic-denied" }
  | { kind: "released-short" }
  | { kind: "released" }
  | { kind: "dropped" }
  | { kind: "heard"; turn: string }
  | { kind: "poll"; phase: TurnPhase; confirmation: string | null; actions: readonly TurnAction[] }
  | { kind: "spoken" }
  | { kind: "unplayable" }
  | { kind: "failed"; message: string }
  | { kind: "cancel" }
  | { kind: "health-up" }
  | { kind: "health-down" };

export const DENIED =
  "helm cannot open the microphone. Allow microphone access for this page, then hold space again.";
export const UNPLAYABLE = "helm could not play the reply.";

const TURN_PHASES: readonly TurnPhase[] = ["heard", "working", "done", "failed", "cancelled"];
const OPS: readonly TurnOp[] = ["add", "tick", "untick", "edit", "note"];

const WORKING: Phase = { name: "working", refused: false };
const IDLE: Phase = { name: "idle" };

/** listening covers a press whose permission prompt has not resolved yet, and working covers a
 *  run that speaks when it lands, so both have to count as hot to the health poll. */
export function hot(phase: Phase): boolean {
  const name = phase.name;
  return name === "listening" || name === "transcribing" || name === "working" || name === "speaking";
}

function pressable(phase: Phase): boolean {
  const name = phase.name;
  return name === "idle" || name === "offline" || name === "error";
}

function landed(phase: TurnPhase, confirmation: string | null): Phase {
  const says = confirmation ?? "";
  return says === "" || phase === "cancelled" ? IDLE : { name: "speaking", says };
}

export function advance(phase: Phase, event: Event): Phase {
  switch (event.kind) {
    case "press":
      if (phase.name === "working") return { name: "working", refused: true };
      return pressable(phase) ? { name: "listening" } : phase;
    case "mic-denied":
      return phase.name === "listening" ? { name: "error", message: DENIED } : phase;
    case "released-short":
      return phase.name === "listening" ? IDLE : phase;
    case "released":
      return phase.name === "listening" ? { name: "transcribing" } : phase;
    case "dropped":
      return phase.name === "listening" || phase.name === "transcribing" ? IDLE : phase;
    case "heard":
      return phase.name === "transcribing" ? WORKING : phase;
    case "poll":
      if (phase.name !== "working") return phase;
      if (event.phase === "heard" || event.phase === "working") return phase;
      return landed(event.phase, event.confirmation);
    case "spoken":
      return phase.name === "speaking" ? IDLE : phase;
    case "unplayable":
      return phase.name === "speaking" ? { name: "error", message: UNPLAYABLE } : phase;
    case "failed":
      return hot(phase) ? { name: "error", message: event.message } : phase;
    case "cancel":
      return phase.name === "listening" || phase.name === "working" ? IDLE : phase;
    case "health-up":
      return phase.name === "offline" ? IDLE : phase;
    case "health-down":
      return hot(phase) || phase.name === "offline" ? phase : { name: "offline" };
  }
}

export function isTurnPhase(value: unknown): value is TurnPhase {
  return TURN_PHASES.some((name) => name === value);
}

export function isOp(value: unknown): value is TurnOp {
  return OPS.some((name) => name === value);
}

export function action(value: unknown): TurnAction | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = row["id"];
  const dept = row["dept"];
  const line = row["row"];
  if (!isOp(row["op"]) || typeof id !== "string" || typeof dept !== "string" || typeof line !== "string") {
    return null;
  }
  return { op: row["op"], id: todoId(id), dept, row: line };
}
