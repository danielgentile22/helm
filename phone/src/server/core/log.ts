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

import { createReadStream } from "node:fs";
import { appendFile, mkdir, open as fsOpen, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "../../shared/protocol";
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

const RECENT_IDS = 64;
const FILE = "events.jsonl";

const emptyHead: ThreadHead = { lastSeq: 0, sessionId: null, openTurn: null, queued: [], recentClientMsgIds: new Map() };

/** Pure: the head after one more event. */
function advance(h: ThreadHead, ev: ThreadEvent): ThreadHead {
  let { sessionId, openTurn, queued, recentClientMsgIds } = h;
  switch (ev.kind) {
    case "session.bound":
      sessionId = ev.sessionId;
      break;
    case "input.queued": {
      queued = [...queued, ev];
      const m = new Map(recentClientMsgIds);
      m.set(ev.clientMsgId, ev.seq);
      while (m.size > RECENT_IDS) m.delete(m.keys().next().value!);
      recentClientMsgIds = m;
      break;
    }
    case "input.dropped":
      queued = queued.filter((q) => q.clientMsgId !== ev.clientMsgId);
      break;
    case "turn.started":
      openTurn = ev.turnId;
      queued = queued.filter((q) => q.clientMsgId !== ev.clientMsgId);
      break;
    case "turn.ended":
      openTurn = null;
      if (ev.sessionId) sessionId = ev.sessionId;
      break;
    case "thread.archived":
      queued = [];
      break;
  }
  return { lastSeq: ev.seq, sessionId, openTurn, queued, recentClientMsgIds };
}

type DeltaBody = Extract<ThreadEventBody, { kind: "assistant.text" | "assistant.thinking" }>;

function deltaKey(b: DeltaBody): string {
  return b.kind === "assistant.text" ? `${b.turnId}:${b.blockIx}` : `${b.turnId}:thinking`;
}

export class ThreadLog {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(ev: ThreadEvent) => void>();
  private pendingDelta: { key: string; body: DeltaBody; timer: NodeJS.Timeout } | null = null;

  private constructor(
    readonly threadId: ThreadId,
    private readonly path: string,
    private head: ThreadHead,
  ) {}

  /**
   * Open (or create) the log and derive the head. Performs I3 and I4 repairs.
   * The registry caches instances; opening the same file twice is harmless
   * because both repairs are idempotent.
   */
  static async open(threadId: ThreadId, dir: string): Promise<ThreadLog> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, FILE);
    const fh = await fsOpen(path, "a");
    await fh.close();

    const bytes = await readFile(path);
    const keep = completePrefixLength(bytes);
    if (keep < bytes.length) {
      console.warn(`[log] ${threadId}: truncating ${bytes.length - keep} torn bytes`);
      await truncate(path, keep);
    }

    let head = emptyHead;
    for (const ev of parseLines(bytes.subarray(0, keep))) head = advance(head, ev);
    const log = new ThreadLog(threadId, path, head);

    if (head.openTurn) {
      await log.append({ kind: "turn.ended", turnId: head.openTurn, outcome: "orphaned", sessionId: head.sessionId, usage: null, error: null });
    }
    for (const q of head.queued) {
      await log.append({ kind: "input.dropped", clientMsgId: q.clientMsgId, reason: "restart" });
    }
    return log;
  }

  getHead(): ThreadHead {
    return this.head;
  }

  /**
   * Append one event. Serialized per instance; resolves after the line is on
   * disk (one write of the whole line). Emits to live subscribers after the
   * write lands (I2). Returns the minted event. A body may be a function of
   * the seq being minted, for events whose body names their own position
   * (turn.started carries `t:<seq>`).
   */
  append<B extends ThreadEventBody>(body: B | ((seq: Seq) => B)): Promise<Extract<ThreadEvent, { kind: B["kind"] }>> {
    const run = this.queue.then(async () => {
      const seq = (this.head.lastSeq + 1) as Seq;
      const ev = { seq, ts: new Date().toISOString(), ...(typeof body === "function" ? body(seq) : body) } as ThreadEvent;
      const line = Buffer.from(JSON.stringify(ev) + "\n");
      await appendFile(this.path, line);
      this.head = advance(this.head, ev);
      for (const l of this.listeners) {
        try {
          l(ev);
        } catch (err) {
          console.error(`[log] ${this.threadId}: subscriber threw`, err);
        }
      }
      return ev as Extract<ThreadEvent, { kind: B["kind"] }>;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Coalescing append for `assistant.text` / `assistant.thinking`: buffers deltas
   * for the same (turnId, blockIx) up to DELTA_COALESCE_MS, then appends one event.
   * A delta for a different block flushes the pending one first, so the log
   * keeps the order the model produced. flushDeltas() is called by the
   * supervisor before any non-delta append for the same reason.
   */
  appendDelta(body: DeltaBody): void {
    const key = deltaKey(body);
    if (this.pendingDelta && this.pendingDelta.key === key) {
      this.pendingDelta.body = { ...this.pendingDelta.body, delta: this.pendingDelta.body.delta + body.delta } as DeltaBody;
      return;
    }
    this.kickDelta();
    const timer = setTimeout(() => this.kickDelta(), LIMITS.DELTA_COALESCE_MS);
    timer.unref();
    this.pendingDelta = { key, body, timer };
  }

  flushDeltas(): Promise<void> {
    this.kickDelta();
    return this.queue.then(() => undefined);
  }

  private kickDelta(): void {
    const p = this.pendingDelta;
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingDelta = null;
    void this.append(p.body);
  }

  /**
   * Stream events with seq > after, from disk, in order. Scans forward from
   * BOF; a personal tool with logs in the low MB does not need an index.
   * A trailing partial line (a write in flight) is never yielded.
   */
  async *read(after: Cursor): AsyncIterable<ThreadEvent> {
    const stream = createReadStream(this.path);
    let carry = "";
    for await (const chunk of stream) {
      carry += (chunk as Buffer).toString("utf8");
      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.length === 0) continue;
        const ev = JSON.parse(line) as ThreadEvent;
        if (ev.seq > after) yield ev;
      }
    }
  }

  /**
   * Live tail. The listener sees every event appended after this call
   * returns, in seq order. Attach BEFORE calling read() to get a gap-free
   * handoff; dedupe on seq to get a duplicate-free one (see http/sse.ts).
   */
  subscribe(listener: (ev: ThreadEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Number of live subscribers. push.ts uses "0" as "nobody is watching". */
  subscriberCount(): number {
    return this.listeners.size;
  }
}

/** Length of the prefix that ends on the last complete, parseable line. */
function completePrefixLength(bytes: Buffer): number {
  let end = bytes.length;
  while (end > 0) {
    if (bytes[end - 1] !== 0x0a) {
      end = bytes.lastIndexOf(0x0a, end - 1) + 1;
      continue;
    }
    const start = bytes.lastIndexOf(0x0a, end - 2) + 1;
    try {
      JSON.parse(bytes.subarray(start, end - 1).toString("utf8"));
      return end;
    } catch {
      end = start;
    }
  }
  return 0;
}

function* parseLines(bytes: Buffer): Iterable<ThreadEvent> {
  const text = bytes.toString("utf8");
  let from = 0;
  let nl: number;
  while ((nl = text.indexOf("\n", from)) >= 0) {
    const line = text.slice(from, nl);
    from = nl + 1;
    if (line.length > 0) yield JSON.parse(line) as ThreadEvent;
  }
}

/**
 * One ThreadLog per thread per process. Both the supervisor and the SSE
 * route go through here so they share the instance and therefore the
 * serial append queue and the subscriber list.
 */
export class LogRegistry {
  private readonly logs = new Map<ThreadId, Promise<ThreadLog>>();
  private readonly openListeners = new Set<(log: ThreadLog) => void>();

  constructor(private readonly threadsRoot: string) {}

  /** Opens on first use; later calls return the same instance. */
  get(threadId: ThreadId): Promise<ThreadLog> {
    let p = this.logs.get(threadId);
    if (!p) {
      p = ThreadLog.open(threadId, join(this.threadsRoot, threadId)).then((log) => {
        for (const l of this.openListeners) l(log);
        return log;
      });
      p.catch(() => this.logs.delete(threadId));
      this.logs.set(threadId, p);
    }
    return p;
  }

  /** Called for every log this registry opens, including ones opened after boot. Projections attach here. */
  onOpen(listener: (log: ThreadLog) => void): void {
    this.openListeners.add(listener);
  }

  /** Every log already open, in open order. */
  async openLogs(): Promise<readonly ThreadLog[]> {
    return Promise.all([...this.logs.values()]);
  }

  /** Run open() over every thread directory at boot so I3/I4 repairs happen before any client attaches. */
  async recoverAll(): Promise<readonly ThreadId[]> {
    await mkdir(this.threadsRoot, { recursive: true });
    const ids: ThreadId[] = [];
    for (const entry of await readdir(this.threadsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.threadsRoot, entry.name);
      const hasLog = await stat(join(dir, FILE)).then(() => true, () => false);
      const hasConfig = await stat(join(dir, "thread.json")).then(() => true, () => false);
      if (!hasLog && !hasConfig) continue;
      const id = entry.name as ThreadId;
      await this.get(id);
      ids.push(id);
    }
    return ids;
  }
}

/** Fold used by projections that need the last assistant text or the title; pure. */
export function lastAssistantText(events: Iterable<ThreadEvent>, maxChars: number): string | null {
  let turn: TurnId | null = null;
  let text = "";
  for (const ev of events) {
    if (ev.kind !== "assistant.text") continue;
    if (ev.turnId !== turn) {
      turn = ev.turnId;
      text = "";
    }
    text += ev.delta;
  }
  if (turn === null) return null;
  const trimmed = text.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}
