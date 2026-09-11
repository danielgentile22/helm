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

import type { Cursor, SyncFrame, ThreadEvent, ThreadId } from "../../shared/protocol";
import type { ThreadLog } from "../core/log";
import type { Supervisor } from "../core/supervisor";

export interface SseSink {
  event(ev: ThreadEvent): void;
  control(name: "sync", frame: SyncFrame): void;
  comment(text: string): void;
  close(): void;
  readonly closed: Promise<void>;
}

/** Runs until the client disconnects. Never throws to the route; errors close the sink. */
export function streamThread(log: ThreadLog, supervisor: Supervisor, after: Cursor, sink: SseSink): Promise<void> {
  throw new Error("not implemented");
}

/**
 * GET /api/events   (global, not persisted)
 * Fan-in of thread.* and turn.started/turn.ended from every open log, each
 * tagged with threadId, for the thread list badge. Clients re-fetch
 * GET /api/threads on reconnect instead of replaying; this stream has no cursor.
 */
export function streamGlobal(
  subscribeAll: (listener: (threadId: ThreadId, ev: ThreadEvent) => void) => () => void,
  sink: { event(threadId: ThreadId, ev: ThreadEvent): void; comment(text: string): void; readonly closed: Promise<void> },
): Promise<void> {
  throw new Error("not implemented");
}

/** Pure. Parse `after` query param or Last-Event-ID header into a cursor; bad input is 400. */
export function cursorFrom(url: URL, lastEventId: string | null): { ok: true; after: Cursor } | { ok: false } {
  throw new Error("not implemented");
}
