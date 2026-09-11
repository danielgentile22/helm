/**
 * The only renderer state the client has: a pure fold of ThreadEvents.
 * There is no other client-side truth. Reconnect = fold more events.
 *
 * Invariant: fold(view, ev) requires ev.seq === view.headSeq + 1; the caller
 * (api.ts attach loop) drops the connection and re-attaches from headSeq if
 * it ever sees anything else. This is how a phone that missed events, or
 * received a duplicate, self-heals without any special-case code.
 */

import type { Cursor, Seq, SyncFrame, ThreadEvent, ThreadId, TurnId, Usage } from "../shared/protocol";

export type Line =
  /** `[iphone] > text` prompt line; `pending` until turn.started arrives, `dropped` if the server restarted. */
  | { kind: "prompt"; clientMsgId: string; text: string; uploads: readonly string[]; state: "pending" | "started" | "dropped"; label: string }
  | { kind: "text"; turnId: TurnId; blockIx: number; text: string }
  | { kind: "thinking"; turnId: TurnId; text: string }
  /** Rendered as a single collapsed row: `> Read Atlas/Areas/Health.md` then a checkmark or a cross. */
  | { kind: "tool"; turnId: TurnId; toolUseId: string; name: string; input: unknown; output: string | null; isError: boolean | null }
  | { kind: "end"; turnId: TurnId; outcome: string; usage: Usage | null; error: string | null }
  | { kind: "note"; text: string }; // config changes, session bound, archived

export interface ThreadView {
  readonly threadId: ThreadId;
  readonly headSeq: Cursor;
  readonly lines: readonly Line[];
  readonly openTurn: TurnId | null;
  readonly session: SyncFrame["session"];
  readonly contextTokens: number | null;
  readonly replaying: boolean;
}

export function emptyView(threadId: ThreadId): ThreadView {
  throw new Error("not implemented");
}

/** Pure. Appends or mutates the last matching Line; text deltas concatenate onto the open block. */
export function fold(view: ThreadView, ev: ThreadEvent): ThreadView {
  throw new Error("not implemented");
}

/** Apply the `sync` control frame: mark live, copy session state. */
export function applySync(view: ThreadView, frame: SyncFrame): ThreadView {
  throw new Error("not implemented");
}

/** Optimistic prompt line before the server has acked; replaced when input.queued arrives with the same clientMsgId. */
export function addPendingPrompt(view: ThreadView, clientMsgId: string, text: string, label: string): ThreadView {
  throw new Error("not implemented");
}
