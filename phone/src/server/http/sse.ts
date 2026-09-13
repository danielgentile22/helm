/**
 * GET /api/threads/:id/events?after=<seq>   (also honors Last-Event-ID)
 *
 * Replay-then-live with a gap-free, duplicate-free handoff:
 *
 *   1. subscribe() to the live log FIRST; buffer everything that arrives.
 *   2. stream read(after) from disk; track lastSent.
 *   3. flush the buffer, skipping seq <= lastSent.
 *   4. send `event: sync` with the head and session state.
 *   5. go live: forward each event as it arrives.
 *
 * Because append() emits only after the line is on disk (log I2), every
 * event is either in the file when read() runs or arrives via the
 * subscription; the seq dedupe removes the overlap. The client asserts
 * ev.seq === headSeq + 1 and reconnects on violation.
 *
 * Wire: `id: <seq>` + `data: <json>` per event; `: hb` comment every
 * SSE_HEARTBEAT_MS; `retry: 1000`.
 */

import { LIMITS } from "../../shared/protocol";
import type { Cursor, SyncFrame, ThreadEvent, ThreadId } from "../../shared/protocol";
import type { LogRegistry, ThreadLog } from "../core/log";
import { parseCursor } from "../core/ids";
import type { Supervisor } from "../core/supervisor";

export interface SseSink {
  event(ev: ThreadEvent): void;
  control(name: "sync", frame: SyncFrame): void;
  comment(text: string): void;
  close(): void;
  readonly closed: Promise<void>;
}

export interface StreamOptions {
  readonly heartbeatMs?: number;
}

/** Runs until the client disconnects. Never throws to the route; errors close the sink. */
export async function streamThread(log: ThreadLog, supervisor: Supervisor, after: Cursor, sink: SseSink, opts: StreamOptions = {}): Promise<void> {
  let lastSent: Cursor = after;
  let live = false;
  const buffer: ThreadEvent[] = [];
  const forward = (ev: ThreadEvent): void => {
    if (ev.seq <= lastSent) return;
    lastSent = ev.seq;
    sink.event(ev);
  };
  const unsub = log.subscribe("viewer", (ev) => (live ? forward(ev) : buffer.push(ev)));
  const heartbeat = setInterval(() => sink.comment("hb"), opts.heartbeatMs ?? LIMITS.SSE_HEARTBEAT_MS);
  try {
    for await (const ev of log.read(after)) forward(ev);
    for (const ev of buffer) forward(ev);
    buffer.length = 0;
    live = true;
    const head = log.getHead();
    sink.control("sync", { headSeq: head.lastSeq, ...supervisor.status(log.threadId), queuedCount: head.queued.length });
    await sink.closed;
  } catch (err) {
    console.error(`[sse ${log.threadId}] stream failed`, err);
  } finally {
    clearInterval(heartbeat);
    unsub();
    sink.close();
  }
}

const GLOBAL_KINDS = new Set<ThreadEvent["kind"]>(["thread.created", "thread.config", "thread.archived", "turn.started", "turn.ended", "input.queued"]);

/**
 * GET /api/events   (global, not persisted)
 * Fan-in of thread.* and turn boundaries from every open log, each tagged
 * with threadId, for the thread list badge. Clients re-fetch GET /api/threads
 * on reconnect instead of replaying; this stream has no cursor.
 */
export async function streamGlobal(
  logs: LogRegistry,
  sink: { event(threadId: ThreadId, ev: ThreadEvent): void; comment(text: string): void; readonly closed: Promise<void> },
  opts: StreamOptions = {},
): Promise<void> {
  const unsubs: (() => void)[] = [];
  const attach = (log: ThreadLog): void => {
    unsubs.push(log.subscribe("projection", (ev) => GLOBAL_KINDS.has(ev.kind) && sink.event(log.threadId, ev)));
  };
  const heartbeat = setInterval(() => sink.comment("hb"), opts.heartbeatMs ?? LIMITS.SSE_HEARTBEAT_MS);
  try {
    unsubs.push(logs.onOpen(attach));
    for (const log of await logs.openLogs()) attach(log);
    await sink.closed;
  } finally {
    clearInterval(heartbeat);
    for (const u of unsubs) u();
  }
}

/** Pure. Parse `after` query param or Last-Event-ID header into a cursor; bad input is 400. */
export function cursorFrom(url: URL, lastEventId: string | null): { ok: true; after: Cursor } | { ok: false } {
  return parseCursor(lastEventId ?? url.searchParams.get("after"));
}

// Wire formatting. Pure.
export function formatEvent(ev: ThreadEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}
export function formatControl(name: "sync", frame: SyncFrame): string {
  return `event: ${name}\ndata: ${JSON.stringify(frame)}\n\n`;
}
export function formatComment(text: string): string {
  return `: ${text}\n\n`;
}
export function formatGlobalEvent(threadId: ThreadId, ev: ThreadEvent): string {
  return `data: ${JSON.stringify({ threadId, ...ev })}\n\n`;
}
