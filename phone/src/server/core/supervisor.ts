/**
 * Supervisor: per-thread session state machine. Owns the AgentSession
 * handles and the "one turn at a time" rule. Writes only to ThreadLog.
 *
 * State per thread (memory only; resets to cold on restart, which is the
 * truthful state after a crash and is why there is no lock to clean up):
 *
 *   cold ──send──> warming ──init──> idle ──turn──> running ──result──> idle
 *    ▲                                 │                       │
 *    │                              idle 30m                 crash
 *    └──────── parked <──────────────┘ (process killed,   ──> cold (turn.ended
 *                 (sessionId kept)      sessionId kept)         {error} appended)
 *
 * Invariants
 *   S1. At most one turn is open per thread (log I4 plus `running` here).
 *   S2. send() always appends `input.queued` first, so a message is on disk
 *       before anything can act on it, and is visible to every viewer.
 *   S3. A turn starts only from the head of the queue, in order. A message
 *       that arrives mid-turn runs as the next turn on the same process.
 *   S4. Config changes (model/effort) take effect at the next turn boundary.
 *   S5. interrupt() is idempotent; on a non-running thread it does nothing.
 */

import type {
  ClientMsgId,
  Effort,
  ModelId,
  Origin,
  SendResponse,
  StagedUpload,
  SyncFrame,
  ThreadConfig,
  ThreadConfigPatch,
  ThreadEvent,
  ThreadId,
  TurnId,
} from "../../shared/protocol";
import type { AgentEvent, AgentFactory, AgentSession } from "./agent";
import { PHONE_APPENDIX } from "./agent";
import { turnIdFor } from "./ids";
import type { LogRegistry, ThreadLog } from "./log";
import type { ThreadStore } from "./thread-store";

/** One process: the session plus the single iterator over its event stream. */
interface Live {
  readonly agent: AgentSession;
  readonly iter: AsyncIterator<AgentEvent>;
  /** What the process was spawned with, so a config change during warming can be applied after. */
  readonly spawnedWith: { model: ModelId; effort: Effort };
}

export type SessionState =
  | { tag: "cold" }
  | { tag: "warming" }
  | { tag: "idle"; live: Live; parkTimer: NodeJS.Timeout }
  | { tag: "running"; live: Live; turnId: TurnId; clientMsgId: ClientMsgId }
  | { tag: "parked" };

export interface SendArgs {
  readonly clientMsgId: ClientMsgId;
  readonly text: string;
  readonly uploads: readonly StagedUpload[];
  readonly origin: Origin;
}

const COLD: SessionState = { tag: "cold" };

export class Supervisor {
  private readonly states = new Map<ThreadId, SessionState>();
  private readonly draining = new Map<ThreadId, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly logs: LogRegistry,
    private readonly threads: ThreadStore,
    private readonly agents: AgentFactory,
    private readonly opts: { additionalDirectories: readonly string[]; idleParkMs: number },
  ) {}

  private state(threadId: ThreadId): SessionState {
    return this.states.get(threadId) ?? COLD;
  }

  /**
   * Accept a message. Idempotent on clientMsgId: a duplicate returns the seq
   * of the original `input.queued` and does nothing else. Never blocks on the
   * model; returns as soon as the input is on disk.
   */
  async send(threadId: ThreadId, args: SendArgs): Promise<SendResponse> {
    const config = await this.threads.get(threadId);
    if (!config) return { accepted: false, error: "no such thread" };
    if (config.archivedAt) return { accepted: false, error: "thread is archived" };
    const log = await this.logs.get(threadId);
    const ev = await log.appendIf((h) => !h.recentClientMsgIds.has(args.clientMsgId), { kind: "input.queued", clientMsgId: args.clientMsgId, text: args.text, uploads: args.uploads, origin: args.origin });
    if (!ev) return { accepted: true, state: "duplicate", seq: log.getHead().recentClientMsgIds.get(args.clientMsgId)! };
    const tag = this.state(threadId).tag;
    const behind = log.getHead().queued.length > 1 || tag === "running";
    if (tag === "cold" || tag === "parked") this.states.set(threadId, { tag: "warming" });
    void this.drain(threadId);
    return { accepted: true, state: behind ? "queued" : "running", seq: ev.seq };
  }

  /** S5. The agent's own turn.ended {interrupted} flows through the normal event path. */
  async interrupt(threadId: ThreadId): Promise<void> {
    const s = this.state(threadId);
    if (s.tag !== "running") return;
    await s.live.agent.interrupt();
  }

  /**
   * Persist the patch to thread.json, append `thread.config`, and apply to a
   * live agent; the SDK applies model and effort at the next turn (S4).
   */
  async reconfigure(threadId: ThreadId, patch: ThreadConfigPatch, origin: Origin): Promise<void> {
    await this.threads.patch(threadId, patch);
    const log = await this.logs.get(threadId);
    await log.append({ kind: "thread.config", patch, origin });
    const s = this.state(threadId);
    if (s.tag !== "idle" && s.tag !== "running") return;
    if (patch.model !== undefined) await s.live.agent.setModel(patch.model);
    if (patch.effort !== undefined) await s.live.agent.setEffort(patch.effort);
  }

  /** Kill the process if any, keep the session id, drop queued inputs, append `thread.archived`. */
  async archive(threadId: ThreadId): Promise<void> {
    const log = await this.logs.get(threadId);
    await this.threads.archive(threadId);
    const s = this.state(threadId);
    if (s.tag === "running") await s.live.agent.interrupt();
    await this.draining.get(threadId);
    await this.killLive(threadId);
    for (const q of log.getHead().queued) {
      await log.append({ kind: "input.dropped", clientMsgId: q.clientMsgId, reason: "archived" });
    }
    await log.append({ kind: "thread.archived" });
  }

  /** For SyncFrame and ThreadSummary. Pure read of memory. */
  status(threadId: ThreadId): Pick<SyncFrame, "session" | "openTurn"> {
    const s = this.state(threadId);
    return { session: s.tag, openTurn: s.tag === "running" ? s.turnId : null };
  }

  /** Kill every live process (SIGTERM group, SIGKILL after 10 s) and wait for every drain loop to settle, so no append follows. Called on SIGTERM/launchd stop. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.states.keys()].map((id) => this.killLive(id)));
    await Promise.all([...this.draining.values()]);
    await Promise.all([...this.states.keys()].map((id) => this.killLive(id)));
  }

  private async killLive(threadId: ThreadId): Promise<void> {
    const s = this.state(threadId);
    this.states.set(threadId, COLD);
    if (s.tag === "idle") clearTimeout(s.parkTimer);
    if (s.tag === "idle" || s.tag === "running") await s.live.agent.kill();
  }

  /**
   * Run turns from the head of the queue until it is empty. Re-entrant-safe:
   * a second call while one is draining returns the same promise.
   */
  private drain(threadId: ThreadId): Promise<void> {
    let p = this.draining.get(threadId);
    if (!p) {
      p = this.runQueue(threadId)
        .catch((err) => console.error(`[supervisor ${threadId}] drain failed`, err))
        .finally(() => this.draining.delete(threadId));
      this.draining.set(threadId, p);
    }
    return p;
  }

  private async runQueue(threadId: ThreadId): Promise<void> {
    const log = await this.logs.get(threadId);
    for (;;) {
      const config = await this.threads.get(threadId);
      const input = log.getHead().queued[0];
      if (this.stopped || !config || config.archivedAt || !input) {
        this.settleIdle(threadId);
        return;
      }
      await this.runTurn(threadId, log, config, input);
    }
  }

  /** Leave the thread idle with the park timer armed, if a process is live. */
  private settleIdle(threadId: ThreadId): void {
    const s = this.state(threadId);
    if (s.tag !== "running" && s.tag !== "idle") return;
    if (s.tag === "idle") clearTimeout(s.parkTimer);
    const parkTimer = setTimeout(() => void this.park(threadId), this.opts.idleParkMs);
    parkTimer.unref();
    this.states.set(threadId, { tag: "idle", live: s.live, parkTimer });
  }

  /** Exception boundary: whatever throws inside a turn, the turn is sealed and the thread is cold, never wedged. */
  private async runTurn(threadId: ThreadId, log: ThreadLog, config: ThreadConfig, input: Extract<ThreadEvent, { kind: "input.queued" }>): Promise<void> {
    try {
      await this.runTurnInner(threadId, log, config, input);
    } catch (err) {
      console.error(`[supervisor ${threadId}] turn failed`, err);
      const s = this.state(threadId);
      const openTurn = log.getHead().openTurn;
      if (openTurn) await log.append({ kind: "turn.ended", turnId: openTurn, outcome: "error", sessionId: log.getHead().sessionId, usage: null, error: `turn failed: ${err instanceof Error ? err.message : String(err)}` });
      if (!openTurn && s.tag === "warming") {
        // Nothing started; the queued input must still be consumed or the queue never drains.
        const started = await log.append((seq) => ({ kind: "turn.started" as const, turnId: turnIdFor(seq), clientMsgId: input.clientMsgId, model: config.model, effort: config.effort, spawned: true }));
        await log.append({ kind: "turn.ended", turnId: started.turnId, outcome: "error", sessionId: log.getHead().sessionId, usage: null, error: `turn failed: ${err instanceof Error ? err.message : String(err)}` });
      }
      await this.killLive(threadId);
    }
  }

  private async runTurnInner(threadId: ThreadId, log: ThreadLog, initial: ThreadConfig, input: Extract<ThreadEvent, { kind: "input.queued" }>): Promise<void> {
    let config = initial;
    if (config.title === null) {
      const title = titleFrom(input.text);
      await this.threads.patch(threadId, { title });
      await log.append({ kind: "thread.config", patch: { title }, origin: input.origin });
    }

    let live: Live;
    let spawned: boolean;
    try {
      ({ live, spawned } = await this.ensureLive(threadId, config, log));
    } catch (err) {
      const started = await log.append((seq) => ({ kind: "turn.started" as const, turnId: turnIdFor(seq), clientMsgId: input.clientMsgId, model: config.model, effort: config.effort, spawned: true }));
      await log.append({ kind: "turn.ended", turnId: started.turnId, outcome: "error", sessionId: log.getHead().sessionId, usage: null, error: `could not start Claude Code: ${String(err)}` });
      this.states.set(threadId, COLD);
      return;
    }

    // Config may have changed while warming; the turn runs with the current values (S4).
    const fresh = (await this.threads.get(threadId)) ?? config;
    if (spawned && fresh.model !== live.spawnedWith.model) await live.agent.setModel(fresh.model);
    if (spawned && fresh.effort !== live.spawnedWith.effort) await live.agent.setEffort(fresh.effort);
    config = fresh;

    // The turn id is the seq of its own turn.started, minted inside the log's serial queue.
    const started = await log.append((seq) => ({ kind: "turn.started" as const, turnId: turnIdFor(seq), clientMsgId: input.clientMsgId, model: config.model, effort: config.effort, spawned }));
    const turnId = started.turnId;
    this.states.set(threadId, { tag: "running", live, turnId, clientMsgId: input.clientMsgId });

    const sent = live.agent.send({ turnId, text: input.text, uploads: input.uploads }).catch(() => undefined);
    let ended = false;
    for (;;) {
      const r = await live.iter.next();
      if (r.done) break;
      const ev = r.value;
      if (ev.kind === "assistant.text" || ev.kind === "assistant.thinking") {
        log.appendDelta({ ...ev, turnId });
        continue;
      }
      await log.append(ev.kind === "session.bound" ? ev : { ...ev, turnId });
      if (ev.kind === "turn.ended") {
        ended = true;
        break;
      }
    }
    await sent;
    if (ended) this.settleIdle(threadId);
    if (!ended) {
      await log.append({ kind: "turn.ended", turnId, outcome: "error", sessionId: live.agent.sessionId ?? log.getHead().sessionId, usage: null, error: "Claude Code session exited" });
      await live.agent.kill();
      this.states.set(threadId, COLD);
    }
  }

  private async ensureLive(threadId: ThreadId, config: ThreadConfig, log: ThreadLog): Promise<{ live: Live; spawned: boolean }> {
    const s = this.state(threadId);
    if (s.tag === "idle") {
      clearTimeout(s.parkTimer);
      if (s.live.agent.alive) return { live: s.live, spawned: false };
      // The process died while idle; replace it rather than burn the next message on a dead one.
      await s.live.agent.kill();
    }
    if (s.tag === "running") return { live: s.live, spawned: false };
    this.states.set(threadId, { tag: "warming" });
    try {
      const agent = await this.agents.spawn({
        cwd: config.cwd,
        model: config.model,
        effort: config.effort,
        resume: log.getHead().sessionId,
        additionalDirectories: this.opts.additionalDirectories,
        appendSystemPrompt: PHONE_APPENDIX,
      });
      if (this.stopped) {
        await agent.kill();
        throw new Error("shutting down");
      }
      return { live: { agent, iter: agent.events()[Symbol.asyncIterator](), spawnedWith: { model: config.model, effort: config.effort } }, spawned: true };
    } catch (err) {
      this.states.set(threadId, COLD);
      throw err;
    }
  }

  private async park(threadId: ThreadId): Promise<void> {
    const s = this.state(threadId);
    if (s.tag !== "idle") return;
    this.states.set(threadId, { tag: "parked" });
    await s.live.agent.kill();
  }
}

/** Derive a title from the first user text: first line, <= 60 chars, no trailing punctuation. Pure. */
export function titleFrom(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "Untitled";
  return line.slice(0, 60).replace(/[\s.,;:!?]+$/u, "") || "Untitled";
}
