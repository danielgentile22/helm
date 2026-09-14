/**
 * The turn model: one fold of ThreadEvents into turns, shared by the phone's
 * transcript and the vault mirror. Three joins live here and nowhere else:
 * a prompt to its turn by clientMsgId, text deltas to a block by blockIx,
 * and a tool's start to its finish by toolUseId. Rendering is presentation
 * over the Turn value.
 *
 * A turn opens on the prompt that will start it, so a message queued while
 * another turn runs is already its own turn, and the content of its turn
 * lands under it by turnId rather than by position. A file or a note joins
 * the running turn, else the last turn while it has not ended (the auto-title
 * note lands between a prompt and its turn.started), else stands as a loose
 * section of its own.
 *
 * foldTurn replaces only the turn it touches, so a keyed renderer keeps the
 * identity of every other turn across an event.
 */

import type { AskAnswer, AskAnsweredBy, AskId, AskPayload, ClientMsgId, FileId, Seq, ThreadEvent, ThreadId, ToolUseId, TurnId, TurnOutcome, UploadId, Usage } from "./protocol";

/** What a prompt remembers about a file sent with it: enough to name it or fetch its bytes. */
export interface PromptUpload {
  readonly uploadId: UploadId;
  readonly name: string;
  readonly mime: string;
}

/** `pending` until the server acks, `queued` until its turn starts, `dropped` if the server restarted. */
export type PromptState = "pending" | "queued" | "started" | "dropped";

export interface Prompt {
  readonly clientMsgId: ClientMsgId;
  readonly text: string;
  readonly uploads: readonly PromptUpload[];
  readonly label: string;
  readonly state: PromptState;
  readonly ts: string;
}

export type Item =
  | { kind: "text"; blockIx: number; text: string }
  | { kind: "thinking"; text: string }
  /** One tool call. `endedAt` is null while it is still running; both stamps come from the event `ts`. */
  | { kind: "tool"; toolUseId: ToolUseId; name: string; input: unknown; output: string | null; isError: boolean | null; startedAt: string; endedAt: string | null }
  /** A file the model offered to the phone; the card fetches it by id. */
  | { kind: "file"; fileId: FileId; name: string; mime: string; bytes: number; note: string | null; ts: string }
  /** Claude Code paused on the user. `answer` is null while the card still waits; the turn's end never fills it, a sealing `ask.answered` does. */
  | { kind: "ask"; askId: AskId; ask: AskPayload; openedAt: string; answer: { answer: AskAnswer; by: AskAnsweredBy; ts: string } | null }
  /** The divider of a forked thread: the turns above were copied from `from`. `memory` says whether Claude remembers them. */
  | { kind: "fork"; from: ThreadId; fromTitle: string | null; atTurn: TurnId; memory: "session" | "fresh" }
  /** Under the turn someone forked from: a link to the copy. */
  | { kind: "forkOut"; to: ThreadId; toTitle: string }
  | { kind: "note"; text: string };

export type ToolItem = Extract<Item, { kind: "tool" }>;
export type FileItem = Extract<Item, { kind: "file" }>;
export type AskItem = Extract<Item, { kind: "ask" }>;

export interface TurnEnd {
  readonly outcome: TurnOutcome;
  readonly usage: Usage | null;
  readonly error: string | null;
  readonly seq: Seq;
  readonly ts: string;
}

export interface Turn {
  /** Stable across events: `p:<clientMsgId>` when a prompt opened it, `t:<turnId>` when content arrived first, `n:<seq>` for a loose section. */
  readonly key: string;
  readonly turnId: TurnId | null;
  readonly prompt: Prompt | null;
  readonly startedAt: string | null;
  readonly items: readonly Item[];
  readonly end: TurnEnd | null;
}

export type CompletedTurn = Turn & { readonly end: TurnEnd };

export const isCompleted = (turn: Turn): turn is CompletedTurn => turn.end !== null;

export function groupTurns(events: Iterable<ThreadEvent>): readonly Turn[] {
  let turns: readonly Turn[] = [];
  for (const ev of events) turns = foldTurn(turns, ev);
  return turns;
}

/** The optimistic prompt before the server has acked; input.queued with the same clientMsgId replaces it. */
export function pendingPrompt(turns: readonly Turn[], clientMsgId: string, text: string, label: string, uploads: readonly PromptUpload[]): readonly Turn[] {
  const prompt: Prompt = { clientMsgId: clientMsgId as ClientMsgId, text, uploads, label, state: "pending", ts: new Date().toISOString() };
  return [...turns, { key: `p:${clientMsgId}`, turnId: null, prompt, startedAt: null, items: [], end: null }];
}

/** Pure. Returns the same array when the event has no place in the turn model. */
export function foldTurn(turns: readonly Turn[], ev: ThreadEvent): readonly Turn[] {
  switch (ev.kind) {
    case "thread.created":
    case "upload.staged":
    case "session.bound":
    case "log.generation":
      return turns;
    case "input.queued": {
      const prompt: Prompt = { clientMsgId: ev.clientMsgId, text: ev.text, uploads: ev.uploads.map((u) => ({ uploadId: u.uploadId, name: u.name, mime: u.mime })), label: ev.origin.label, state: "queued", ts: ev.ts };
      const ix = turns.findLastIndex((t) => t.prompt?.clientMsgId === ev.clientMsgId && t.prompt.state === "pending");
      if (ix >= 0) return replace(turns, ix, { ...turns[ix]!, prompt });
      return [...turns, { key: `p:${ev.clientMsgId}`, turnId: null, prompt, startedAt: null, items: [], end: null }];
    }
    case "input.dropped":
      return withPrompt(turns, ev.clientMsgId, (t) => ({ ...t, prompt: { ...t.prompt!, state: "dropped" } }));
    case "turn.started": {
      const ix = turns.findLastIndex((t) => t.prompt?.clientMsgId === ev.clientMsgId);
      if (ix < 0) return [...turns, { key: `t:${ev.turnId}`, turnId: ev.turnId, prompt: null, startedAt: ev.ts, items: [], end: null }];
      const t = turns[ix]!;
      return replace(turns, ix, { ...t, turnId: ev.turnId, startedAt: ev.ts, prompt: { ...t.prompt!, state: "started" } });
    }
    case "assistant.text":
      return withTurn(turns, ev.turnId, (t) => {
        const last = t.items[t.items.length - 1];
        if (last?.kind === "text" && last.blockIx === ev.blockIx) return { ...t, items: replace(t.items, t.items.length - 1, { ...last, text: last.text + ev.delta }) };
        return { ...t, items: [...t.items, { kind: "text", blockIx: ev.blockIx, text: ev.delta }] };
      });
    case "assistant.thinking":
      return withTurn(turns, ev.turnId, (t) => {
        const last = t.items[t.items.length - 1];
        if (last?.kind === "thinking") return { ...t, items: replace(t.items, t.items.length - 1, { ...last, text: last.text + ev.delta }) };
        return { ...t, items: [...t.items, { kind: "thinking", text: ev.delta }] };
      });
    case "tool.started":
      return withTurn(turns, ev.turnId, (t) => ({ ...t, items: [...t.items, { kind: "tool", toolUseId: ev.toolUseId, name: ev.name, input: ev.input, output: null, isError: null, startedAt: ev.ts, endedAt: null }] }));
    case "tool.finished":
      return withTurn(turns, ev.turnId, (t) => {
        const ix = t.items.findLastIndex((i) => i.kind === "tool" && i.toolUseId === ev.toolUseId);
        if (ix < 0) return { ...t, items: [...t.items, { kind: "tool", toolUseId: ev.toolUseId, name: "?", input: null, output: ev.output, isError: ev.isError, startedAt: ev.ts, endedAt: ev.ts }] };
        return { ...t, items: replace(t.items, ix, { ...(t.items[ix] as ToolItem), output: ev.output, isError: ev.isError, endedAt: ev.ts }) };
      });
    case "turn.ended":
      return withTurn(turns, ev.turnId, (t) => ({ ...t, end: { outcome: ev.outcome, usage: ev.usage, error: ev.error, seq: ev.seq, ts: ev.ts } }));
    case "file.offered":
      return loose(turns, ev.seq, { kind: "file", fileId: ev.file.fileId, name: ev.file.name, mime: ev.file.mime, bytes: ev.file.bytes, note: ev.file.note, ts: ev.ts });
    case "ask.opened":
      return withTurn(turns, ev.turnId, (t) => ({ ...t, items: [...t.items, { kind: "ask", askId: ev.askId, ask: ev.ask, openedAt: ev.ts, answer: null }] }));
    case "ask.answered":
      return withTurn(turns, ev.turnId, (t) => {
        const ix = t.items.findLastIndex((i) => i.kind === "ask" && i.askId === ev.askId);
        if (ix < 0) return t;
        return { ...t, items: replace(t.items, ix, { ...(t.items[ix] as AskItem), answer: { answer: ev.answer, by: ev.by, ts: ev.ts } }) };
      });
    case "thread.config": {
      const parts: string[] = [];
      if (ev.patch.title !== undefined) parts.push(`title set to "${ev.patch.title}"`);
      if (ev.patch.model !== undefined) parts.push(`model set to ${ev.patch.model}`);
      if (ev.patch.effort !== undefined) parts.push(`effort set to ${ev.patch.effort}`);
      if (ev.patch.permissionMode !== undefined) parts.push(`permissions set to ${ev.patch.permissionMode}`);
      return loose(turns, ev.seq, { kind: "note", text: `[${ev.origin.label}] ${parts.join(", ")}` });
    }
    case "thread.archived":
      return loose(turns, ev.seq, { kind: "note", text: "thread archived" });
    case "thread.forked":
      return loose(turns, ev.seq, { kind: "fork", from: ev.from, fromTitle: ev.fromTitle, atTurn: ev.atTurn, memory: ev.resume ? "session" : "fresh" });
    case "thread.forked.out":
      return withTurn(turns, ev.atTurn, (t) => ({ ...t, items: [...t.items, { kind: "forkOut", to: ev.to, toTitle: ev.toTitle }] }));
  }
}

/** Route to the turn with this id, opening one when content arrives before its turn.started. */
function withTurn(turns: readonly Turn[], turnId: TurnId, f: (t: Turn) => Turn): readonly Turn[] {
  const ix = turns.findLastIndex((t) => t.turnId === turnId);
  if (ix >= 0) return replace(turns, ix, f(turns[ix]!));
  return [...turns, f({ key: `t:${turnId}`, turnId, prompt: null, startedAt: null, items: [], end: null })];
}

function withPrompt(turns: readonly Turn[], clientMsgId: ClientMsgId, f: (t: Turn) => Turn): readonly Turn[] {
  const ix = turns.findLastIndex((t) => t.prompt?.clientMsgId === clientMsgId);
  return ix >= 0 ? replace(turns, ix, f(turns[ix]!)) : turns;
}

function loose(turns: readonly Turn[], seq: Seq, item: Item): readonly Turn[] {
  const running = turns.findLastIndex((t) => t.turnId !== null && t.end === null);
  const last = turns.length - 1;
  const ix = running >= 0 ? running : turns[last]?.end === null ? last : -1;
  if (ix >= 0) return replace(turns, ix, { ...turns[ix]!, items: [...turns[ix]!.items, item] });
  return [...turns, { key: `n:${seq}`, turnId: null, prompt: null, startedAt: null, items: [item], end: null }];
}

function replace<T>(list: readonly T[], index: number, value: T): T[] {
  const next = list.slice();
  next[index] = value;
  return next;
}
