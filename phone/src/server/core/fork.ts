/**
 * Forking a thread at a completed turn. The fork is a new thread whose log is
 * a projection of the source's: `thread.created`, then every source event up
 * to and including the chosen `turn.ended`, then `thread.forked`. The source
 * gets one live `thread.forked.out`. Both are facts, not commands.
 *
 * The copy is written in one go and renamed into place (F1 below), so a crash
 * leaves either a whole fork or nothing. Staging lives under <home>/forking/,
 * a sibling of <home>/threads, so a leftover is never listed as a thread.
 *
 * Invariants
 *   F1. A directory appears under threads/ only when its thread.json and its
 *       events.jsonl are both complete on disk.
 *   F2. Copied events keep their original `ts` and take fresh contiguous seqs
 *       from 2. Because a TurnId is `t:<seq of its turn.started>`, every
 *       copied turn id is remapped to its new seq, so no id dangles.
 *   F3. Forking is not idempotent by design: two calls make two forks.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { turnIdFor } from "../../shared/protocol";
import type { ClaudeSessionId, ClientMsgId, ForkResume, Seq, ThreadConfig, ThreadEvent, ThreadEventBody, ThreadId, TurnId } from "../../shared/protocol";
import { atomicWrite } from "../util/atomicWrite";
import type { LogRegistry } from "./log";
import { stampEvents, writeLogFile } from "./log";
import type { ThreadStore } from "./thread-store";

/** Never copied into the fork: the source's own identity, its generation, its archive, and its outbound fork links. */
const SKIPPED: ReadonlySet<ThreadEvent["kind"]> = new Set(["thread.created", "log.generation", "thread.archived", "thread.forked.out"]);

export type ForkResult = { ok: true; config: ThreadConfig } | { ok: false; reason: "no-thread" | "no-turn" | "turn-open" };

/**
 * Pure. The fork's whole log, or null when `atTurn` has no `turn.ended` here,
 * or when the source log has no `thread.created` to name its own thread by.
 * `config` is the fork's own config; everything else is read out of the source
 * events, including which thread this forked from.
 */
export function forkedEvents(source: readonly ThreadEvent[], atTurn: TurnId, config: ThreadConfig, now: string): ThreadEvent[] | null {
  const endIx = source.findIndex((ev) => ev.kind === "turn.ended" && ev.turnId === atTurn);
  if (endIx < 0) return null;
  const range = source.slice(0, endIx + 1);
  const created = range.find((ev) => ev.kind === "thread.created");
  if (!created) return null;

  const started = new Set<ClientMsgId>();
  for (const ev of range) if (ev.kind === "turn.started") started.add(ev.clientMsgId);

  const bodies: (ThreadEventBody & { ts: string })[] = [{ kind: "thread.created", config, ts: now }];
  const turnIds = new Map<TurnId, TurnId>();
  for (const ev of range) {
    if (SKIPPED.has(ev.kind)) continue;
    if (ev.kind === "input.queued" && !started.has(ev.clientMsgId)) continue;
    const { seq: _seq, ...body } = ev;
    if (body.kind === "turn.started") {
      const turnId = turnIdFor((bodies.length + 1) as Seq);
      turnIds.set(body.turnId, turnId);
      bodies.push({ ...body, turnId });
    } else if ("turnId" in body) {
      const turnId = turnIds.get(body.turnId);
      if (!turnId) throw new Error(`fork: ${body.kind} at seq ${ev.seq} names ${body.turnId}, which has no turn.started in the copied range`);
      bodies.push({ ...body, turnId });
    } else {
      bodies.push(body);
    }
  }

  bodies.push({
    kind: "thread.forked",
    from: created.config.threadId,
    fromTitle: titleOf(range, created.config.title),
    atTurn,
    resume: resumeFrom(range, source[endIx] as Extract<ThreadEvent, { kind: "turn.ended" }>),
    ts: now,
  });
  return stampEvents(bodies);
}

/** The source's title as it stood at the fork point, which is what the divider should name. */
function titleOf(range: readonly ThreadEvent[], initial: string | null): string | null {
  let title = initial;
  for (const ev of range) if (ev.kind === "thread.config" && ev.patch.title !== undefined) title = ev.patch.title;
  return title;
}

/**
 * Where the fork's first spawn picks the conversation up: the session the
 * source head was on at the fork point, and the uuid of that turn's last
 * message. Null when either is missing, which is a turn logged before forking
 * existed or one that produced no message; Claude then starts fresh there.
 */
function resumeFrom(range: readonly ThreadEvent[], end: Extract<ThreadEvent, { kind: "turn.ended" }>): ForkResume | null {
  let sessionId: ClaudeSessionId | null = null;
  for (const ev of range) {
    if (ev.kind === "session.bound") sessionId = ev.sessionId;
    if (ev.kind === "turn.ended" && ev.sessionId) sessionId = ev.sessionId;
  }
  return sessionId && end.forkPoint ? { sessionId, at: end.forkPoint } : null;
}

/**
 * Pure. The fork's title, so a list of retries reads in order:
 * "X" -> "X (fork)" -> "X (fork 2)" -> "X (fork 3)".
 */
export function forkTitle(title: string | null): string {
  const base = title ?? "Untitled";
  const m = base.match(/^(.*) \(fork(?: (\d+))?\)$/u);
  if (!m) return `${base} (fork)`;
  return `${m[1]} (fork ${m[2] ? Number(m[2]) + 1 : 2})`;
}

export class Forks {
  private readonly threadsRoot: string;
  private readonly stagingRoot: string;

  constructor(home: string, private readonly threads: ThreadStore, private readonly logs: LogRegistry) {
    this.threadsRoot = join(home, "threads");
    this.stagingRoot = join(home, "forking");
  }

  /** Copy a source thread up to a completed turn into a new thread (F1, F3). Works on an archived source. */
  async fork(sourceId: ThreadId, atTurn: TurnId): Promise<ForkResult> {
    const source = await this.threads.get(sourceId);
    if (!source) return { ok: false, reason: "no-thread" };
    const log = await this.logs.get(sourceId);
    const events: ThreadEvent[] = [];
    for await (const ev of log.read(0)) events.push(ev);
    if (!events.some((ev) => ev.kind === "turn.started" && ev.turnId === atTurn)) return { ok: false, reason: "no-turn" };
    if (!events.some((ev) => ev.kind === "turn.ended" && ev.turnId === atTurn)) return { ok: false, reason: "turn-open" };

    const now = new Date().toISOString();
    const forkId = randomUUID() as ThreadId;
    const title = forkTitle(source.title);
    const config: ThreadConfig = {
      threadId: forkId,
      cwd: source.cwd,
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode,
      title,
      createdAt: now,
      archivedAt: null,
    };
    const forked = forkedEvents(events, atTurn, config, now);
    if (!forked) throw new Error(`cannot fork ${sourceId}: its log has no thread.created`);

    const staging = join(this.stagingRoot, forkId);
    await mkdir(staging, { recursive: true });
    await atomicWrite(join(staging, "thread.json"), JSON.stringify(config, null, 2) + "\n");
    await writeLogFile(staging, forked);
    await mkdir(this.threadsRoot, { recursive: true });
    await rename(staging, join(this.threadsRoot, forkId));

    await this.logs.get(forkId);
    await log.append({ kind: "thread.forked.out", to: forkId, toTitle: title, atTurn });
    return { ok: true, config };
  }
}
