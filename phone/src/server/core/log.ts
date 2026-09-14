/**
 * ThreadLog: the append-only event log for one thread, and the only place a
 * Seq is minted. Everything else in the server is either a producer that
 * calls append() or a projection that calls read()/subscribe().
 *
 * File: ~/.helm2/threads/<threadId>/events.jsonl, one ThreadEvent per line.
 *
 * Invariants
 *   I1. Within a generation, seq is contiguous from 1. append() assigns
 *       lastSeq + 1 under a per-instance serial queue; there is exactly one
 *       ThreadLog instance per thread per process (LogRegistry enforces it).
 *       The one other minter is renumber, for a log written whole (a fork,
 *       a compaction) before any subscriber can see it.
 *   I2. Within a generation, an event is emitted to subscribers only after
 *       its line has been fully written to the file. So anything a
 *       subscriber has seen is on disk, and anything on disk with
 *       seq > cursor is returned by read().
 *   I3. The file's last line may be torn (crash mid-write). open() truncates
 *       to the last complete line. This is the only place the log is ever
 *       shortened, and it can only drop an event nobody was told about (I2).
 *   I4. A log never ends inside a turn after open(): if the last turn
 *       boundary is `turn.started`, open() appends `turn.ended {orphaned}`,
 *       preceded by `ask.answered {system: restart}` for every ask still
 *       pending in that turn, so no replaying phone shows a live button for
 *       a process that no longer exists. Running open() twice is a no-op
 *       the second time.
 *   I5. The pending ask set is a fold: `ask.opened` minus `ask.answered`,
 *       cleared by `turn.ended`. There is no other record of it.
 *   I6. The generation is the log's first line when that line is
 *       log.generation, else 0. Compaction is the only thing that changes
 *       it, and it rewrites the whole file through a temp file and one
 *       rename, so a log is always in exactly one generation. Seqs are
 *       contiguous from 1 within a generation. A cursor without its
 *       generation is only meaningful at 0.
 */

import { createReadStream } from "node:fs";
import { appendFile, mkdir, open as fsOpen, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { addUsage, FIRST_GENERATION, LIMITS, turnIdFor } from "../../shared/protocol";
import type {
  AskId,
  ClaudeSessionId,
  ClientMsgId,
  Cursor,
  ForkResume,
  Generation,
  PendingAsk,
  Seq,
  ThreadEvent,
  ThreadEventBody,
  ThreadId,
  ToolUseId,
  TurnId,
  TurnOutcome,
  UsageTotal,
} from "../../shared/protocol";

/** Derived from the tail of the log by open(); never stored. */
export interface ThreadHead {
  readonly lastSeq: Cursor;
  /** Which numbering `lastSeq` counts in (I6). */
  readonly generation: Generation;
  /**
   * Delta events whose immediately preceding event is a delta with the same
   * key (turn and block for text, turn for thinking): the number of lines
   * compaction would remove.
   */
  readonly collapsible: number;
  /** The key of the last event when it was a delta, else null; what `collapsible` counts against. */
  readonly lastDeltaKey: string | null;
  readonly sessionId: ClaudeSessionId | null;
  /**
   * The fork's first spawn resumes this session at this message uuid. Set by
   * `thread.forked`, cleared by the next `session.bound` or `turn.ended`, so a
   * spawn the SDK refused is retried fresh rather than forever.
   */
  readonly fork: ForkResume | null;
  /** turnId of a `turn.started` without a matching `turn.ended`. Always null after open(). */
  readonly openTurn: TurnId | null;
  /** `input.queued` events not yet consumed by a `turn.started`, in order. */
  readonly queued: readonly Extract<ThreadEvent, { kind: "input.queued" }>[];
  /** Recent clientMsgIds for send() idempotency (last 64 turn boundaries). */
  readonly recentClientMsgIds: ReadonlyMap<ClientMsgId, Seq>;
  /** From the last turn.ended, for ThreadSummary. */
  readonly lastTurnEndedAt: string | null;
  readonly lastOutcome: TurnOutcome | null;
  readonly contextTokens: number | null;
  /** The tool the model is waiting on, or null. Cleared by its own tool.finished and by turn.ended. */
  readonly activeTool: { toolUseId: ToolUseId; name: string; input: unknown } | null;
  /**
   * The assistant text of the most recent turn that produced any. A new turn
   * resets it, but turn.ended never clears it, so a turn that says nothing
   * leaves the previous preview standing rather than blanking the row.
   */
  readonly lastText: { turnId: TurnId; text: string } | null;
  readonly usageTotal: UsageTotal | null;
  /** From the most recent usage that carried one. */
  readonly contextWindow: number | null;
  /** Asks opened in the open turn and not yet answered, in open order (I5). Always empty after open(). */
  readonly pendingAsks: readonly PendingAsk[];
  /** The last 64 ask ids ever opened, so an answer to a settled ask reads as a conflict rather than as unknown. */
  readonly recentAskIds: ReadonlySet<AskId>;
}

export type Unsubscribe = () => void;

/**
 * Who a subscriber is. A viewer is a person with the thread open (an SSE
 * stream); a projection is server-side machinery (mirror, push, the global
 * list stream) that watches every log whether or not anyone is looking.
 * Push notifies on turn.ended when viewerCount() is zero.
 */
export type SubscriberKind = "viewer" | "projection";

const RECENT_IDS = 64;
const FILE = "events.jsonl";
/** Where a compaction is written before the rename; a leftover is a crash before it. */
const COMPACTING = `${FILE}.compacting`;

const emptyHead: ThreadHead = { lastSeq: 0, generation: FIRST_GENERATION, collapsible: 0, lastDeltaKey: null, sessionId: null, fork: null, openTurn: null, queued: [], recentClientMsgIds: new Map(), lastTurnEndedAt: null, lastOutcome: null, contextTokens: null, activeTool: null, lastText: null, usageTotal: null, contextWindow: null, pendingAsks: [], recentAskIds: new Set() };

/** Pure: the head after one more event. */
function advance(h: ThreadHead, ev: ThreadEvent): ThreadHead {
  let { generation, collapsible, sessionId, fork, openTurn, queued, recentClientMsgIds, lastTurnEndedAt, lastOutcome, contextTokens, activeTool, lastText, usageTotal, contextWindow, pendingAsks, recentAskIds } = h;
  const key = ev.kind === "assistant.text" || ev.kind === "assistant.thinking" ? deltaKey(ev) : null;
  if (key !== null && key === h.lastDeltaKey) collapsible += 1;
  switch (ev.kind) {
    case "log.generation":
      generation = ev.generation;
      break;
    case "session.bound":
      sessionId = ev.sessionId;
      fork = null;
      break;
    case "thread.forked":
      sessionId = null;
      fork = ev.resume;
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
    case "assistant.text":
      lastText = lastText && lastText.turnId === ev.turnId ? { turnId: ev.turnId, text: lastText.text + ev.delta } : { turnId: ev.turnId, text: ev.delta };
      break;
    case "tool.started":
      activeTool = { toolUseId: ev.toolUseId, name: ev.name, input: ev.input };
      break;
    case "tool.finished":
      if (activeTool?.toolUseId === ev.toolUseId) activeTool = null;
      break;
    case "ask.opened": {
      if (ev.turnId !== openTurn) break;
      pendingAsks = [...pendingAsks, { askId: ev.askId, turnId: ev.turnId, ask: ev.ask }];
      const ids = new Set(recentAskIds);
      ids.add(ev.askId);
      while (ids.size > RECENT_IDS) ids.delete(ids.values().next().value!);
      recentAskIds = ids;
      break;
    }
    case "ask.answered":
      pendingAsks = pendingAsks.filter((a) => a.askId !== ev.askId);
      break;
    case "turn.ended":
      openTurn = null;
      fork = null;
      activeTool = null;
      pendingAsks = [];
      if (ev.sessionId) sessionId = ev.sessionId;
      lastTurnEndedAt = ev.ts;
      lastOutcome = ev.outcome;
      if (ev.usage) {
        contextTokens = ev.usage.contextTokens;
        usageTotal = addUsage(usageTotal, ev.usage);
        if (ev.usage.contextWindow !== undefined) contextWindow = ev.usage.contextWindow;
      }
      break;
    case "thread.archived":
      queued = [];
      break;
  }
  return { lastSeq: ev.seq, generation, collapsible, lastDeltaKey: key, sessionId, fork, openTurn, queued, recentClientMsgIds, lastTurnEndedAt, lastOutcome, contextTokens, activeTool, lastText, usageTotal, contextWindow, pendingAsks, recentAskIds };
}

type DeltaBody = Extract<ThreadEventBody, { kind: "assistant.text" | "assistant.thinking" }>;

function isDelta(body: ThreadEventBody | ((seq: Seq) => ThreadEventBody)): body is DeltaBody {
  return typeof body !== "function" && (body.kind === "assistant.text" || body.kind === "assistant.thinking");
}

/** Two consecutive deltas with the same key fold into one block, so they are one line after compaction. */
function deltaKey(b: DeltaBody): string {
  return b.kind === "assistant.text" ? `${b.turnId}:${b.blockIx}` : `${b.turnId}:thinking`;
}

/**
 * Stamp a run of bodies as a whole log, seqs 1..n. The only way to mint seqs
 * outside append(), for a log written in one go (a fork, a compaction) rather
 * than appended event by event. Timestamps come in with the bodies: a copied
 * event keeps the ts it happened at. A TurnId is `t:<seq of its turn.started>`,
 * so every turn.started takes the id of its new seq and every event naming a
 * turn of this log follows it; `thread.forked.atTurn` names a turn of the
 * source thread and is left alone. An id with no turn.started here is kept.
 */
export function renumber(bodies: readonly (ThreadEventBody & { ts: string })[]): ThreadEvent[] {
  const turnIds = new Map<TurnId, TurnId>();
  const mapped = (id: TurnId): TurnId => turnIds.get(id) ?? id;
  return bodies.map(({ ts, ...body }, i) => {
    const seq = (i + 1) as Seq;
    let b: ThreadEventBody = body;
    if (b.kind === "turn.started") {
      const turnId = turnIdFor(seq);
      turnIds.set(b.turnId, turnId);
      b = { ...b, turnId };
    } else if (b.kind === "thread.forked.out") {
      b = { ...b, atTurn: mapped(b.atTurn) };
    } else if ("turnId" in b) {
      b = { ...b, turnId: mapped(b.turnId) };
    }
    return { seq, ts, ...b } as ThreadEvent;
  });
}

export interface Compacted {
  readonly events: ThreadEvent[];
  /** Old seq to new seq for every kept event; a delta absorbed into an earlier one has no entry. */
  readonly seqMap: ReadonlyMap<Seq, Seq>;
  /** Delta lines merged away. 0 means the input came back untouched. */
  readonly removed: number;
}

/**
 * Pure. The same log one generation on: every completed turn's runs of
 * consecutive same-key deltas become one delta each, everything else is kept
 * in order, and the whole is renumbered behind a `log.generation` at seq 1.
 * Everything after the last turn.ended is copied as is (renumbered only).
 * Only strictly consecutive deltas merge, which is exactly the merge the turn
 * fold makes, so the fold of the output is the fold of the input.
 */
export function compactEvents(events: readonly ThreadEvent[], generation: Generation, now: string): Compacted {
  const lastEnd = events.findLastIndex((ev) => ev.kind === "turn.ended");
  const out: { body: ThreadEventBody & { ts: string }; firstSeq: Seq | null; lastIx: number }[] = [{ body: { kind: "log.generation", generation, ts: now }, firstSeq: null, lastIx: -1 }];
  let removed = 0;
  events.forEach((ev, ix) => {
    const { seq, ...body } = ev;
    if (body.kind === "log.generation") return;
    const prev = out[out.length - 1]!;
    const { ts: _ts, ...prevBody } = prev.body;
    if (ix <= lastEnd && isDelta(body) && prev.lastIx === ix - 1 && isDelta(prevBody) && deltaKey(prevBody) === deltaKey(body)) {
      prev.body = { ...prevBody, delta: prevBody.delta + body.delta, ts: prev.body.ts };
      prev.lastIx = ix;
      removed += 1;
      return;
    }
    out.push({ body, firstSeq: seq, lastIx: ix });
  });
  if (removed === 0) return { events: [...events], seqMap: new Map(events.map((ev) => [ev.seq, ev.seq])), removed };
  const renumbered = renumber(out.map((o) => o.body));
  const seqMap = new Map<Seq, Seq>();
  out.forEach((o, i) => {
    if (o.firstSeq !== null) seqMap.set(o.firstSeq, renumbered[i]!.seq);
  });
  return { events: renumbered, seqMap, removed };
}

export type CompactResult = { ok: true; removed: number; generation: Generation } | { ok: false; reason: "viewer" | "nothing" };

/** Write a whole events.jsonl in the shape append() writes it, one event per line. */
export async function writeLogFile(dir: string, events: readonly ThreadEvent[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, FILE), events.map((ev) => JSON.stringify(ev) + "\n").join(""));
}

export class ThreadLog {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<{ readonly kind: SubscriberKind; readonly listener: (ev: ThreadEvent) => void }>();
  private pendingDelta: { key: string; body: DeltaBody; timer: NodeJS.Timeout } | null = null;

  private constructor(
    readonly threadId: ThreadId,
    private readonly path: string,
    private head: ThreadHead,
    /** Byte length of the clean file; a failed write is truncated back to it. */
    private bytes: number,
  ) {}

  /**
   * Open (or create) the log and derive the head. Performs I3 and I4 repairs.
   * The registry caches instances; opening the same file twice is harmless
   * because both repairs are idempotent.
   */
  static async open(threadId: ThreadId, dir: string): Promise<ThreadLog> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, FILE);
    await rm(join(dir, COMPACTING), { force: true });
    const fh = await fsOpen(path, "a");
    await fh.close();

    const bytes = await readFile(path);
    const { events, keep } = scan(bytes);
    if (keep < bytes.length) {
      console.warn(`[log] ${threadId}: truncating ${bytes.length - keep} torn bytes`);
      await truncate(path, keep);
    }

    let head = emptyHead;
    for (const ev of events) head = advance(head, ev);
    const log = new ThreadLog(threadId, path, head, keep);

    if (head.openTurn) {
      for (const a of head.pendingAsks) {
        await log.append({ kind: "ask.answered", turnId: a.turnId, askId: a.askId, answer: { kind: "deny", reason: null }, by: { by: "system", reason: "restart" } });
      }
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
    return this.appendIf(() => true, body) as Promise<Extract<ThreadEvent, { kind: B["kind"] }>>;
  }

  /**
   * Append only if `when(head)` holds at the moment the serial queue reaches
   * this call; otherwise resolve null. This is how send() dedupes a retried
   * clientMsgId without a window between check and write.
   */
  appendIf<B extends ThreadEventBody>(when: (head: ThreadHead) => boolean, body: B | ((seq: Seq) => B)): Promise<Extract<ThreadEvent, { kind: B["kind"] }> | null> {
    // A non-delta append flushes pending deltas first, so the log keeps the order the model produced.
    if (!isDelta(body)) this.kickDelta();
    const run = this.queue.then(async () => {
      if (!when(this.head)) return null;
      const seq = (this.head.lastSeq + 1) as Seq;
      const ev = { seq, ts: new Date().toISOString(), ...(typeof body === "function" ? body(seq) : body) } as ThreadEvent;
      const line = Buffer.from(JSON.stringify(ev) + "\n");
      try {
        await appendFile(this.path, line);
      } catch (err) {
        // Whatever landed is a tear nobody was told about; take it back so the next append starts clean.
        await truncate(this.path, this.bytes).catch(() => undefined);
        throw err;
      }
      this.bytes += line.length;
      this.head = advance(this.head, ev);
      for (const { listener } of this.listeners) {
        try {
          listener(ev);
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
    this.append(p.body).catch((err) => console.error(`[log] ${this.threadId}: delta append failed`, err));
  }

  /**
   * Move the log to its next generation with every completed turn's delta
   * runs merged (I6). Runs on the serial queue so no append interleaves, and
   * refuses while a viewer is attached: a viewer's cursor would die with the
   * generation. Nothing is emitted; projections are generation-aware and
   * rebuild when they notice the head's generation moved.
   */
  compact(): Promise<CompactResult> {
    this.kickDelta();
    const run = this.queue.then(async (): Promise<CompactResult> => {
      if (this.viewerCount() > 0) return { ok: false, reason: "viewer" };
      const { events } = scan(await readFile(this.path));
      const generation = (this.head.generation + 1) as Generation;
      const compacted = compactEvents(events, generation, new Date().toISOString());
      if (compacted.removed === 0) return { ok: false, reason: "nothing" };
      const text = compacted.events.map((ev) => JSON.stringify(ev) + "\n").join("");
      const tmp = join(this.path, "..", COMPACTING);
      const fh = await fsOpen(tmp, "w");
      try {
        await fh.writeFile(text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
      let head = emptyHead;
      for (const ev of compacted.events) head = advance(head, ev);
      this.head = head;
      this.bytes = Buffer.byteLength(text);
      console.log(`[log] ${this.threadId}: compacted to generation ${generation}, removed ${compacted.removed} lines`);
      return { ok: true, removed: compacted.removed, generation };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Stream events with seq > after, from disk, in order. Scans forward from
   * BOF; a personal tool with logs in the low MB does not need an index.
   * A trailing partial line (a write in flight) is never yielded.
   */
  async *read(after: Cursor): AsyncIterable<ThreadEvent> {
    const stream = createReadStream(this.path, { encoding: "utf8" });
    let carry = "";
    for await (const chunk of stream) {
      carry += chunk as string;
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
  subscribe(kind: SubscriberKind, listener: (ev: ThreadEvent) => void): Unsubscribe {
    const entry = { kind, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Live viewer subscribers. Zero means nobody has this thread open. */
  viewerCount(): number {
    let n = 0;
    for (const { kind } of this.listeners) if (kind === "viewer") n++;
    return n;
  }
}

/**
 * Scan from BOF. Returns the events up to the first line that is
 * unterminated, unparseable, or not a ThreadEvent, and the byte length of
 * that clean prefix. Anything after the first bad line is a tear: the
 * writer could only have produced it by continuing past a failed write,
 * which append() prevents by truncating back.
 */
function scan(bytes: Buffer): { events: ThreadEvent[]; keep: number } {
  const events: ThreadEvent[] = [];
  const text = bytes.toString("utf8");
  let from = 0;
  let keepChars = 0;
  for (;;) {
    const nl = text.indexOf("\n", from);
    if (nl < 0) break;
    const line = text.slice(from, nl);
    if (line.length > 0) {
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        break;
      }
      if (typeof ev !== "object" || ev === null || typeof (ev as ThreadEvent).seq !== "number" || typeof (ev as ThreadEvent).kind !== "string") break;
      events.push(ev as ThreadEvent);
    }
    from = nl + 1;
    keepChars = from;
  }
  return { events, keep: Buffer.byteLength(text.slice(0, keepChars)) };
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
        for (const l of this.openListeners) {
          try {
            l(log);
          } catch (err) {
            console.error(`[log] ${threadId}: onOpen listener threw`, err);
          }
        }
        return log;
      });
      p.catch(() => this.logs.delete(threadId));
      this.logs.set(threadId, p);
    }
    return p;
  }

  /** Called for every log this registry opens, including ones opened after boot. Projections attach here. Returns a detach function. */
  onOpen(listener: (log: ThreadLog) => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
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
