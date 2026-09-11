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
 *   S3. A turn starts only from the head of the queue, in order.
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
  ThreadConfigPatch,
  ThreadId,
  TurnId,
} from "../../shared/protocol";
import type { AgentFactory, AgentSession } from "./agent";
import type { LogRegistry } from "./log";
import type { ThreadStore } from "./thread-store";

export type SessionState =
  | { tag: "cold" }
  | { tag: "warming"; spawn: Promise<AgentSession> }
  | { tag: "idle"; agent: AgentSession; parkTimer: NodeJS.Timeout }
  | { tag: "running"; agent: AgentSession; turnId: TurnId; clientMsgId: ClientMsgId }
  | { tag: "parked" };

export interface SendArgs {
  readonly clientMsgId: ClientMsgId;
  readonly text: string;
  readonly uploads: readonly StagedUpload[];
  readonly origin: Origin;
}

export class Supervisor {
  private readonly states = new Map<ThreadId, SessionState>();

  constructor(
    private readonly logs: LogRegistry,
    private readonly threads: ThreadStore,
    private readonly agents: AgentFactory,
    private readonly opts: { additionalDirectories: readonly string[]; idleParkMs: number },
  ) {}

  /**
   * Accept a message. Idempotent on clientMsgId: a duplicate returns the seq
   * of the original `input.queued` and does nothing else. Never blocks on the
   * model; returns as soon as the input is on disk.
   */
  send(threadId: ThreadId, args: SendArgs): Promise<SendResponse> {
    // TODO: log = await logs.get(threadId); if head.recentClientMsgIds.has(args.clientMsgId) or queued has it -> duplicate
    //       ev = await log.append({kind: "input.queued", ...args})
    //       state = states.get(threadId) ?? cold
    //       if state.tag in (cold, parked, idle): void this.drain(threadId); return {accepted, state: "running", seq}
    //       else return {accepted, state: "queued", seq}
    throw new Error("not implemented");
  }

  /** S5. Also flushes pending deltas so the log reads in model order. */
  interrupt(threadId: ThreadId): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Persist the patch to thread.json, append `thread.config`, and apply to a
   * live agent if the SDK supports it; otherwise mark for respawn at the next
   * turn boundary (S4).
   */
  reconfigure(threadId: ThreadId, patch: ThreadConfigPatch, origin: Origin): Promise<void> {
    throw new Error("not implemented");
  }

  /** Kill the process if any, keep the session id, append `thread.archived`, drop queued inputs. */
  archive(threadId: ThreadId): Promise<void> {
    throw new Error("not implemented");
  }

  /** For SyncFrame and ThreadSummary. Pure read of memory. */
  status(threadId: ThreadId): Pick<SyncFrame, "session" | "openTurn"> {
    throw new Error("not implemented");
  }

  /** Kill every live process (SIGTERM group, SIGKILL after 10 s). Called on SIGTERM/launchd stop. */
  shutdown(): Promise<void> {
    throw new Error("not implemented");
  }

  /**
   * Run turns from the head of the queue until it is empty. Re-entrant-safe:
   * a second call while one is draining returns immediately.
   */
  private drain(threadId: ThreadId): Promise<void> {
    // TODO: loop:
    //   head = log.getHead(); if head.queued.length === 0 -> set idle (start parkTimer) and return
    //   input = head.queued[0]
    //   agent, spawned = await this.ensureAgent(threadId)   // cold/parked -> warming -> idle
    //   turnId = ... minted from the seq that turn.started will get: append turn.started first, then use its seq
    //   set state running
    //   consume agent.events() for this turn concurrently:
    //     deltas -> log.appendDelta; other kinds -> await log.flushDeltas(); await log.append(ev)
    //     turn.ended -> break
    //   await agent.send({turnId, text, uploads})
    //   if the agent died mid-turn (events() ended without turn.ended): append turn.ended {outcome: "error", error: "session exited"}, set cold
    //   maybe title the thread from the first turn (thread-store.setTitle) if config.title === null
    throw new Error("not implemented");
  }

  private ensureAgent(threadId: ThreadId): Promise<{ agent: AgentSession; spawned: boolean }> {
    // TODO: config = threads.get(threadId); head = log.getHead()
    //       spawn with resume: head.sessionId; on session.bound append it; clear parkTimer if idle
    throw new Error("not implemented");
  }

  private park(threadId: ThreadId): Promise<void> {
    // TODO: only from idle; agent.kill(); state = parked. Session id stays in the log; next send resumes.
    throw new Error("not implemented");
  }
}

/** Derive a title from the first user text: first line, <= 60 chars, no trailing punctuation. Pure. */
export function titleFrom(text: string): string {
  throw new Error("not implemented");
}
