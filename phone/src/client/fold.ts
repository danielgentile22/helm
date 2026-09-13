/**
 * The only renderer state the client has: a pure fold of ThreadEvents plus
 * the last sync frame. There is no other client-side truth. Reconnect = fold
 * more events.
 *
 * The turns come from the shared grouper; this adds the thread's config and
 * session state around them, the same derivation the server's ThreadHead
 * makes from the same log. Invariant: fold(view, ev) requires
 * ev.seq === view.headSeq + 1. The attach loop in api.ts keeps it: it drops
 * the connection on a gap or a duplicate before the event reaches the fold,
 * and it resets the view and its own cursor together when the server's log
 * turns out to be shorter. The throw below is for any other caller.
 */

import type { ClaudeSessionId, Cursor, SyncFrame, ThreadConfig, ThreadEvent, TurnId, UsageTotal } from "../shared/protocol";
import { addUsage } from "../shared/protocol";
import { foldTurn, pendingPrompt, type AskItem, type PromptUpload, type Turn } from "../shared/turns";

export type { PromptUpload };

export interface ThreadView {
  readonly config: ThreadConfig;
  readonly headSeq: Cursor;
  /** The server's head as last reported, the denominator while replaying. */
  readonly logHead: Cursor;
  readonly turns: readonly Turn[];
  readonly openTurn: TurnId | null;
  readonly session: SyncFrame["session"];
  readonly sessionId: ClaudeSessionId | null;
  readonly contextTokens: number | null;
  readonly contextWindow: number | null;
  readonly usageTotal: UsageTotal | null;
  /** Opened and not yet answered, in the order asked. Cleared by the turn's end, which answers them all. */
  readonly pendingAsks: readonly AskItem[];
  readonly replaying: boolean;
}

/** A turn is open and blocked on the user. The one place the phone decides it is waiting rather than working. */
export const isWaiting = (view: ThreadView): boolean => view.openTurn !== null && view.pendingAsks.length > 0;

export function emptyView(config: ThreadConfig, logHead: Cursor = 0): ThreadView {
  return { config, headSeq: 0, logHead, turns: [], openTurn: null, session: "cold", sessionId: null, contextTokens: null, contextWindow: null, usageTotal: null, pendingAsks: [], replaying: true };
}

/** Pure. Folds the event into the turns and the config and session state around them. */
export function fold(view: ThreadView, ev: ThreadEvent): ThreadView {
  if (ev.seq !== view.headSeq + 1) throw new Error(`seq gap: expected ${view.headSeq + 1}, got ${ev.seq}`);
  const base = { ...view, headSeq: ev.seq, turns: foldTurn(view.turns, ev) };
  switch (ev.kind) {
    case "thread.created":
      return { ...base, config: ev.config };
    case "thread.config":
      return { ...base, config: { ...view.config, ...ev.patch } };
    case "session.bound":
      return { ...base, sessionId: ev.sessionId };
    case "turn.started":
      return { ...base, openTurn: ev.turnId, session: "running" };
    case "ask.opened":
      return { ...base, pendingAsks: [...view.pendingAsks, { kind: "ask", askId: ev.askId, ask: ev.ask, openedAt: ev.ts, answer: null }] };
    case "ask.answered":
      return { ...base, pendingAsks: view.pendingAsks.filter((a) => a.askId !== ev.askId) };
    case "turn.ended": {
      const ended = { ...base, openTurn: null, session: view.session === "running" ? "idle" : view.session, pendingAsks: [] } as const;
      if (!ev.usage) return ended;
      return { ...ended, contextTokens: ev.usage.contextTokens, contextWindow: ev.usage.contextWindow ?? view.contextWindow, usageTotal: addUsage(view.usageTotal, ev.usage) };
    }
    default:
      return base;
  }
}

export function foldAll(view: ThreadView, events: Iterable<ThreadEvent>): ThreadView {
  let v = view;
  for (const ev of events) v = fold(v, ev);
  return v;
}

/** Apply the `sync` control frame: mark live, copy the session state and the server's head. */
export function applySync(view: ThreadView, frame: SyncFrame): ThreadView {
  return { ...view, replaying: false, logHead: frame.headSeq, session: frame.session, openTurn: frame.openTurn };
}

/** Optimistic prompt before the server has acked; replaced when input.queued arrives with the same clientMsgId. */
export function addPendingPrompt(view: ThreadView, clientMsgId: string, text: string, label: string, uploads: readonly PromptUpload[]): ThreadView {
  return { ...view, turns: pendingPrompt(view.turns, clientMsgId, text, label, uploads) };
}
