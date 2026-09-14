/**
 * GET /api/threads/:id/events?after=<seq>&gen=<generation>   (also honors Last-Event-ID)
 *
 * Replay-then-live with a gap-free, duplicate-free handoff:
 *
 *   1. subscribe() to the live log FIRST; buffer everything that arrives.
 *   2. stream read(after) from disk; track lastSent.
 *   3. flush the buffer, skipping seq <= lastSent.
 *   4. send `event: sync` with the head, its generation and session state.
 *   5. go live: forward each event as it arrives.
 *
 * Because append() emits only after the line is on disk (log I2), every
 * event is either in the file when read() runs or arrives via the
 * subscription; the seq dedupe removes the overlap. The client asserts
 * ev.seq === headSeq + 1 and reconnects on violation.
 *
 * A cursor counts in one generation (log I6). A cursor above 0 whose
 * generation is not the log's, or is missing, gets one sync frame naming the
 * current generation and no events; the client throws its fold away and
 * comes back from 0. A cursor of 0 has nothing to be stale, so its
 * generation is ignored.
 *
 * Wire: `retry: 1000` first, then `id: <seq>` + `data: <json>` per event;
 * `: hb` comment every SSE_HEARTBEAT_MS.
 *
 * Both streams are AsyncIterables of wire chunks that end when the signal
 * aborts, the consumer stops iterating, or the source fails. Cleanup
 * (unsubscribe, stop heartbeat) runs on every exit path.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { LIMITS } from "../../shared/protocol";
import type { Cursor, Generation, SyncFrame, ThreadEvent, ThreadId } from "../../shared/protocol";
import type { LogRegistry, ThreadLog } from "../core/log";
import type { Supervisor } from "../core/supervisor";
import { Pushable } from "../util/pushable";

export interface StreamOptions {
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
}

/** Wire chunks for one thread's event stream. Never throws; a failed replay logs and ends the stream. */
export function threadStream(log: ThreadLog, supervisor: Supervisor, after: Cursor, generation: Generation | null, opts: StreamOptions = {}): AsyncIterable<string> {
  let unsub = (): void => {};
  const out = wire(opts, () => unsub());
  const sync = (): string => {
    const head = log.getHead();
    return formatControl("sync", { headSeq: head.lastSeq, generation: head.generation, ...supervisor.status(log.threadId), queuedCount: head.queued.length });
  };
  if (after > 0 && generation !== log.getHead().generation) {
    out.push(sync());
    out.end();
    return out.chunks;
  }
  let lastSent: Cursor = after;
  let live = false;
  const buffer: ThreadEvent[] = [];
  const forward = (ev: ThreadEvent): void => {
    if (ev.seq <= lastSent) return;
    lastSent = ev.seq;
    out.push(formatEvent(ev));
  };
  unsub = log.subscribe("viewer", (ev) => (live ? forward(ev) : buffer.push(ev)));
  void (async () => {
    try {
      for await (const ev of log.read(after)) forward(ev);
      for (const ev of buffer) forward(ev);
      buffer.length = 0;
      live = true;
      out.push(sync());
    } catch (err) {
      console.error(`[sse ${log.threadId}] stream failed`, err);
      out.end();
    }
  })();
  return out.chunks;
}

/** Thread boundaries plus ask events, so the list row moves into and out of "waiting", plus both halves of a fork, so a new one shows up in the list. */
const GLOBAL_KINDS = new Set<ThreadEvent["kind"]>(["thread.created", "thread.config", "thread.archived", "thread.forked", "thread.forked.out", "turn.started", "turn.ended", "input.queued", "ask.opened", "ask.answered"]);

/**
 * GET /api/events   (global, not persisted)
 * Fan-in of thread.* and turn boundaries from every open log, each tagged
 * with threadId, for the thread list badge. Clients re-fetch GET /api/threads
 * on reconnect instead of replaying; this stream has no cursor.
 */
export function globalStream(logs: LogRegistry, opts: StreamOptions = {}): AsyncIterable<string> {
  const unsubs: (() => void)[] = [];
  const out = wire(opts, () => unsubs.forEach((u) => u()));
  const attach = (log: ThreadLog): void => {
    unsubs.push(log.subscribe("projection", (ev) => GLOBAL_KINDS.has(ev.kind) && out.push(formatGlobalEvent(log.threadId, ev))));
  };
  unsubs.push(logs.onOpen(attach));
  logs.openLogs().then(
    (open) => open.forEach(attach),
    (err: unknown) => {
      console.error("[sse global] stream failed", err);
      out.end();
    },
  );
  return out.chunks;
}

/** Attach a thread's stream to the response. Ends when the client disconnects. The header is for curl users, who see no sync frame before they need it. */
export function respondThread(c: Context, log: ThreadLog, supervisor: Supervisor, after: Cursor, generation: Generation | null, heartbeatMs?: number): Response {
  c.header("X-Helm-Generation", String(log.getHead().generation));
  return respond(c, (signal) => threadStream(log, supervisor, after, generation, { heartbeatMs, signal }));
}

/** Attach the global stream to the response. Ends when the client disconnects. */
export function respondGlobal(c: Context, logs: LogRegistry, heartbeatMs?: number): Response {
  return respond(c, (signal) => globalStream(logs, { heartbeatMs, signal }));
}

/** Pure. Parse `after` (or Last-Event-ID) and `gen` into a cursor and its generation; bad input is 400, a missing gen is null. */
export function cursorFrom(url: URL, lastEventId: string | null): { ok: true; after: Cursor; generation: Generation | null } | { ok: false } {
  const after = nonNegative(lastEventId ?? url.searchParams.get("after"));
  const generation = nonNegative(url.searchParams.get("gen"));
  if (after === undefined || generation === undefined) return { ok: false };
  return { ok: true, after: (after ?? 0) as Cursor, generation: generation as Generation | null };
}

/** A non-negative safe integer, null when absent or empty, undefined when malformed. */
function nonNegative(raw: string | null): number | null | undefined {
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

function respond(c: Context, open: (signal: AbortSignal) => AsyncIterable<string>): Response {
  return streamSSE(c, async (stream) => {
    const gone = new AbortController();
    stream.onAbort(() => gone.abort());
    for await (const chunk of open(gone.signal)) await stream.write(chunk);
  });
}

/** A chunk queue that opens with the retry line, heartbeats while idle, and ends on abort or when the consumer stops. */
function wire(opts: StreamOptions, cleanup: () => void): { push(chunk: string): void; end(): void; chunks: AsyncIterable<string> } {
  const out = new Pushable<string>();
  out.push("retry: 1000\n\n");
  const end = (): void => out.end();
  async function* chunks(): AsyncIterable<string> {
    const heartbeat = setInterval(() => out.push(formatComment("hb")), opts.heartbeatMs ?? LIMITS.SSE_HEARTBEAT_MS);
    opts.signal?.addEventListener("abort", end, { once: true });
    try {
      for await (const chunk of out) yield chunk;
    } finally {
      clearInterval(heartbeat);
      opts.signal?.removeEventListener("abort", end);
      cleanup();
      out.end();
    }
  }
  return { push: (chunk) => out.push(chunk), end, chunks: chunks() };
}

function formatEvent(ev: ThreadEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}
function formatControl(name: "sync", frame: SyncFrame): string {
  return `event: ${name}\ndata: ${JSON.stringify(frame)}\n\n`;
}
function formatComment(text: string): string {
  return `: ${text}\n\n`;
}
function formatGlobalEvent(threadId: ThreadId, ev: ThreadEvent): string {
  return `data: ${JSON.stringify({ threadId, ...ev })}\n\n`;
}
