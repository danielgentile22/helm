/**
 * The only renderer state the client has: a pure fold of ThreadEvents.
 * There is no other client-side truth. Reconnect = fold more events.
 *
 * The turns come from the shared grouper; this adds the connection state
 * around them. Invariant: fold(view, ev) requires ev.seq === view.headSeq + 1;
 * the caller (api.ts attach loop) drops the connection and re-attaches from
 * headSeq if it ever sees anything else. This is how a phone that missed
 * events, or received a duplicate, self-heals without any special-case code.
 */

import type { ClaudeSessionId, Cursor, SyncFrame, ThreadEvent, ThreadId, TurnId } from "../shared/protocol";
import { foldTurn, pendingPrompt, type PromptUpload, type Turn } from "../shared/turns";

export type { PromptUpload };

export interface ThreadView {
  readonly threadId: ThreadId;
  readonly headSeq: Cursor;
  readonly turns: readonly Turn[];
  readonly openTurn: TurnId | null;
  readonly session: SyncFrame["session"];
  readonly sessionId: ClaudeSessionId | null;
  readonly contextTokens: number | null;
  readonly replaying: boolean;
}

export function emptyView(threadId: ThreadId): ThreadView {
  return { threadId, headSeq: 0, turns: [], openTurn: null, session: "cold", sessionId: null, contextTokens: null, replaying: true };
}

/** Pure. Folds the event into the turns and the session state around them. */
export function fold(view: ThreadView, ev: ThreadEvent): ThreadView {
  if (ev.seq !== view.headSeq + 1) throw new Error(`seq gap: expected ${view.headSeq + 1}, got ${ev.seq}`);
  const base = { ...view, headSeq: ev.seq, turns: foldTurn(view.turns, ev) };
  switch (ev.kind) {
    case "session.bound":
      return { ...base, sessionId: ev.sessionId };
    case "turn.started":
      return { ...base, openTurn: ev.turnId, session: "running" };
    case "turn.ended":
      return { ...base, openTurn: null, session: view.session === "running" ? "idle" : view.session, contextTokens: ev.usage?.contextTokens ?? view.contextTokens };
    default:
      return base;
  }
}

export function foldAll(view: ThreadView, events: Iterable<ThreadEvent>): ThreadView {
  let v = view;
  for (const ev of events) v = fold(v, ev);
  return v;
}

/**
 * Apply the `sync` control frame: mark live, copy session state. A head
 * behind ours means the server's log is shorter than what we folded (a
 * restore, or a truncation); reset so the attach loop replays from zero.
 */
export function applySync(view: ThreadView, frame: SyncFrame): ThreadView {
  if (frame.headSeq < view.headSeq) return { ...emptyView(view.threadId), session: frame.session };
  return { ...view, replaying: false, session: frame.session, openTurn: frame.openTurn };
}

/** Optimistic prompt before the server has acked; replaced when input.queued arrives with the same clientMsgId. */
export function addPendingPrompt(view: ThreadView, clientMsgId: string, text: string, label: string, uploads: readonly PromptUpload[]): ThreadView {
  return { ...view, turns: pendingPrompt(view.turns, clientMsgId, text, label, uploads) };
}
