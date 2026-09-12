/**
 * The only renderer state the client has: a pure fold of ThreadEvents.
 * There is no other client-side truth. Reconnect = fold more events.
 *
 * Invariant: fold(view, ev) requires ev.seq === view.headSeq + 1; the caller
 * (api.ts attach loop) drops the connection and re-attaches from headSeq if
 * it ever sees anything else. This is how a phone that missed events, or
 * received a duplicate, self-heals without any special-case code.
 */

import type { ClaudeSessionId, Cursor, SyncFrame, ThreadEvent, ThreadId, TurnId, TurnOutcome, Usage } from "../shared/protocol";

export type Line =
  /** `[iphone] > text` prompt line; `pending` until the server acks, `queued` until its turn starts, `dropped` if the server restarted. */
  | { kind: "prompt"; clientMsgId: string; text: string; uploads: readonly string[]; state: "pending" | "queued" | "started" | "dropped"; label: string }
  | { kind: "text"; turnId: TurnId; blockIx: number; text: string }
  | { kind: "thinking"; turnId: TurnId; text: string }
  /** One tool call. `endedAt` is null while it is still running; both stamps come from the event `ts`. */
  | { kind: "tool"; turnId: TurnId; toolUseId: string; name: string; input: unknown; output: string | null; isError: boolean | null; startedAt: string; endedAt: string | null }
  | { kind: "end"; turnId: TurnId; outcome: TurnOutcome; usage: Usage | null; error: string | null }
  | { kind: "note"; text: string }; // config changes, archived

export interface ThreadView {
  readonly threadId: ThreadId;
  readonly headSeq: Cursor;
  readonly lines: readonly Line[];
  readonly openTurn: TurnId | null;
  readonly session: SyncFrame["session"];
  readonly sessionId: ClaudeSessionId | null;
  readonly contextTokens: number | null;
  readonly replaying: boolean;
}

export function emptyView(threadId: ThreadId): ThreadView {
  return { threadId, headSeq: 0, lines: [], openTurn: null, session: "cold", sessionId: null, contextTokens: null, replaying: true };
}

function replaceLast(lines: readonly Line[], index: number, line: Line): Line[] {
  const next = lines.slice();
  next[index] = line;
  return next;
}

function findLastIndex(lines: readonly Line[], pred: (l: Line) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (pred(lines[i]!)) return i;
  return -1;
}

/** Pure. Appends or mutates the last matching Line; text deltas concatenate onto the open block. */
export function fold(view: ThreadView, ev: ThreadEvent): ThreadView {
  if (ev.seq !== view.headSeq + 1) throw new Error(`seq gap: expected ${view.headSeq + 1}, got ${ev.seq}`);
  const base = { ...view, headSeq: ev.seq };
  const lines = view.lines;
  switch (ev.kind) {
    case "thread.created":
    case "upload.staged":
      return base;
    case "session.bound":
      return { ...base, sessionId: ev.sessionId };
    case "input.queued": {
      const ix = findLastIndex(lines, (l) => l.kind === "prompt" && l.clientMsgId === ev.clientMsgId && l.state === "pending");
      const line: Line = { kind: "prompt", clientMsgId: ev.clientMsgId, text: ev.text, uploads: ev.uploads.map((u) => u.name), state: "queued", label: ev.origin.label };
      return { ...base, lines: ix >= 0 ? replaceLast(lines, ix, line) : [...lines, line] };
    }
    case "input.dropped": {
      const ix = findLastIndex(lines, (l) => l.kind === "prompt" && l.clientMsgId === ev.clientMsgId);
      if (ix < 0) return base;
      return { ...base, lines: replaceLast(lines, ix, { ...(lines[ix] as Extract<Line, { kind: "prompt" }>), state: "dropped" }) };
    }
    case "turn.started": {
      const ix = findLastIndex(lines, (l) => l.kind === "prompt" && l.clientMsgId === ev.clientMsgId);
      const next = ix >= 0 ? replaceLast(lines, ix, { ...(lines[ix] as Extract<Line, { kind: "prompt" }>), state: "started" }) : lines;
      return { ...base, lines: next, openTurn: ev.turnId, session: "running" };
    }
    case "assistant.text": {
      const ix = findLastIndex(lines, (l) => l.kind === "text" && l.turnId === ev.turnId && l.blockIx === ev.blockIx);
      const last = lines[lines.length - 1];
      if (ix >= 0 && ix === lines.length - 1 && last?.kind === "text") return { ...base, lines: replaceLast(lines, ix, { ...last, text: last.text + ev.delta }) };
      return { ...base, lines: [...lines, { kind: "text", turnId: ev.turnId, blockIx: ev.blockIx, text: ev.delta }] };
    }
    case "assistant.thinking": {
      const last = lines[lines.length - 1];
      if (last?.kind === "thinking" && last.turnId === ev.turnId) return { ...base, lines: replaceLast(lines, lines.length - 1, { ...last, text: last.text + ev.delta }) };
      return { ...base, lines: [...lines, { kind: "thinking", turnId: ev.turnId, text: ev.delta }] };
    }
    case "tool.started":
      return { ...base, lines: [...lines, { kind: "tool", turnId: ev.turnId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input, output: null, isError: null, startedAt: ev.ts, endedAt: null }] };
    case "tool.finished": {
      const ix = findLastIndex(lines, (l) => l.kind === "tool" && l.toolUseId === ev.toolUseId);
      if (ix < 0) return { ...base, lines: [...lines, { kind: "tool", turnId: ev.turnId, toolUseId: ev.toolUseId, name: "?", input: null, output: ev.output, isError: ev.isError, startedAt: ev.ts, endedAt: ev.ts }] };
      return { ...base, lines: replaceLast(lines, ix, { ...(lines[ix] as Extract<Line, { kind: "tool" }>), output: ev.output, isError: ev.isError, endedAt: ev.ts }) };
    }
    case "turn.ended":
      return {
        ...base,
        lines: [...lines, { kind: "end", turnId: ev.turnId, outcome: ev.outcome, usage: ev.usage, error: ev.error }],
        openTurn: null,
        session: view.session === "running" ? "idle" : view.session,
        contextTokens: ev.usage?.contextTokens ?? view.contextTokens,
      };
    case "thread.config": {
      const parts: string[] = [];
      if (ev.patch.title !== undefined) parts.push(`title set to "${ev.patch.title}"`);
      if (ev.patch.model !== undefined) parts.push(`model set to ${ev.patch.model}`);
      if (ev.patch.effort !== undefined) parts.push(`effort set to ${ev.patch.effort}`);
      return { ...base, lines: [...lines, { kind: "note", text: `[${ev.origin.label}] ${parts.join(", ")}` }] };
    }
    case "thread.archived":
      return { ...base, lines: [...lines, { kind: "note", text: "thread archived" }] };
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

/** Optimistic prompt line before the server has acked; replaced when input.queued arrives with the same clientMsgId. */
export function addPendingPrompt(view: ThreadView, clientMsgId: string, text: string, label: string): ThreadView {
  return { ...view, lines: [...view.lines, { kind: "prompt", clientMsgId, text, uploads: [], state: "pending", label }] };
}
