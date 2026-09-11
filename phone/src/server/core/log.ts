/**
 * ThreadLog: the append-only event log for one thread, and the only place a
 * Seq is minted. Everything else in the server is either a producer that
 * calls append() or a projection that calls read()/subscribe().
 *
 * File: ~/.helm2/threads/<threadId>/events.jsonl, one ThreadEvent per line.
 *
 * Invariants
 *   I1. seq is contiguous from 1. append() assigns lastSeq + 1 under a
 *       per-instance serial queue; there is exactly one ThreadLog instance
 *       per thread per process (LogRegistry enforces it).
 *   I2. An event is emitted to subscribers only after its line has been
 *       fully written to the file. So anything a subscriber has seen is on
 *       disk, and anything on disk with seq > cursor is returned by read().
 *   I3. The file's last line may be torn (crash mid-write). open() truncates
 *       to the last complete line. This is the only place the log is ever
 *       shortened, and it can only drop an event nobody was told about (I2).
 *   I4. A log never ends inside a turn after open(): if the last turn
 *       boundary is `turn.started`, open() appends `turn.ended {orphaned}`.
 *       Running open() twice is a no-op the second time.
 */

import type {
  ClaudeSessionId,
  ClientMsgId,
  Cursor,
  Seq,
  ThreadEvent,
  ThreadEventBody,
  ThreadId,
  TurnId,
} from "../../shared/protocol";

/** Derived from the tail of the log by open(); never stored. */
export interface ThreadHead {
  readonly lastSeq: Cursor;
  readonly sessionId: ClaudeSessionId | null;
  /** turnId of a `turn.started` without a matching `turn.ended`. Always null after open(). */
  readonly openTurn: TurnId | null;
  /** `input.queued` events not yet consumed by a `turn.started`, in order. */
  readonly queued: readonly Extract<ThreadEvent, { kind: "input.queued" }>[];
  /** Recent clientMsgIds for send() idempotency (last 64 turn boundaries). */
  readonly recentClientMsgIds: ReadonlyMap<ClientMsgId, Seq>;
}

export type Unsubscribe = () => void;

export class ThreadLog {
  private constructor(
    readonly threadId: ThreadId,
    private readonly path: string,
    private head: ThreadHead,
  ) {}

  /**
   * Open (or create) the log and derive the head. Performs I3 and I4 repairs.
   * Returns the same instance if already open for this thread (see LogRegistry).
   */
  static async open(threadId: ThreadId, dir: string): Promise<ThreadLog> {
    // TODO:
    //   ensure dir; open events.jsonl a+
    //   scan backward from EOF in 64 KiB chunks:
    //     - if the final byte is not "\n", find the last "\n" and truncate there (I3),
    //       log a warning with the dropped byte count
    //     - walk lines backward collecting: last seq, last session.bound / turn.ended.sessionId,
    //       input.queued not followed by a turn.started with the same clientMsgId,
    //       and whether the last turn.* boundary is a turn.started
    //     - stop once we have seen a turn.ended AND 64 clientMsgIds, or hit BOF
    //   if openTurn: append turn.ended {outcome: "orphaned", sessionId, usage: null, error: null} (I4)
    //   for each remaining queued input: append input.dropped {reason: "restart"}
    //   (I4 and the drop rule make open() idempotent: second run finds nothing to repair)
    throw new Error("not implemented");
  }

  getHead(): ThreadHead {
    throw new Error("not implemented");
  }

  /**
   * Append one event. Serialized per instance; resolves after the line is on
   * disk (fs.appendFile with the whole line as one buffer). Emits to live
   * subscribers after resolve (I2). Returns the minted event.
   */
  append<B extends ThreadEventBody>(body: B): Promise<Extract<ThreadEvent, { kind: B["kind"] }>> {
    // TODO: queue = queue.then(async () => { seq = head.lastSeq + 1; line = JSON.stringify({seq, ts, ...body}) + "\n";
    //       await appendFile(path, line); update head (sessionId on session.bound/turn.ended,
    //       openTurn on turn.started/turn.ended, queued on input.queued/turn.started/input.dropped,
    //       recentClientMsgIds on turn.started); emit(event); return event })
    throw new Error("not implemented");
  }

  /**
   * Coalescing append for `assistant.text` / `assistant.thinking`: buffers deltas
   * for the same (turnId, blockIx) up to DELTA_COALESCE_MS, then appends one event.
   * flush() is called by the supervisor before any non-delta append so ordering
   * in the log matches ordering the model produced.
   */
  appendDelta(body: Extract<ThreadEventBody, { kind: "assistant.text" | "assistant.thinking" }>): void {
    throw new Error("not implemented");
  }
  flushDeltas(): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Stream events with seq > after, from disk, in order. Cheap: seeks by
   * scanning forward from BOF; a personal tool with logs in the low MB does
   * not need an index. If it ever does, add a sparse seq -> byte offset side
   * file rebuilt on open(), and this signature does not change.
   */
  read(after: Cursor): AsyncIterable<ThreadEvent> {
    throw new Error("not implemented");
  }

  /**
   * Live tail. The listener sees every event appended after this call
   * returns, in seq order. Attach BEFORE calling read() to get a gap-free
   * handoff; dedupe on seq to get a duplicate-free one (see http/sse.ts).
   */
  subscribe(listener: (ev: ThreadEvent) => void): Unsubscribe {
    throw new Error("not implemented");
  }

  /** Number of live subscribers. push.ts uses "0" as "nobody is watching". */
  subscriberCount(): number {
    throw new Error("not implemented");
  }
}

/**
 * One ThreadLog per thread per process. Both the supervisor and the SSE
 * route go through here so they share the instance and therefore the
 * serial append queue and the subscriber list.
 */
export class LogRegistry {
  constructor(private readonly threadsRoot: string) {}
  /** Opens on first use; later calls return the same instance. */
  get(threadId: ThreadId): Promise<ThreadLog> {
    throw new Error("not implemented");
  }
  /** Run open() over every thread directory at boot so I3/I4 repairs happen before any client attaches. */
  recoverAll(): Promise<readonly ThreadId[]> {
    throw new Error("not implemented");
  }
}

/** Fold used by projections that need the last assistant text or the title; pure. */
export function lastAssistantText(events: Iterable<ThreadEvent>, maxChars: number): string | null {
  throw new Error("not implemented");
}
