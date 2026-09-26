import { Offers } from "../core/offers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_GENERATION } from "../../shared/protocol";
import type { ClientMsgId, Cursor, Generation, ThreadId, TurnId } from "../../shared/protocol";
import { FakeAgentFactory } from "../core/agent.fake";
import { LogRegistry } from "../core/log";
import { Supervisor } from "../core/supervisor";
import { ThreadStore } from "../core/thread-store";
import { cursorFrom, globalStream, threadStream } from "./sse";
import { parseFrame, type Frame } from "./testkit";

const origin = { via: "pwa", label: "iphone" } as const;
const threadId = "0f0f0f0f-0000-4000-8000-0000000000ee" as ThreadId;

/** Consume wire chunks until the stream ends. disconnect() is the client going away. */
function reader(open: (signal: AbortSignal) => AsyncIterable<string>): { chunks: string[]; frames: Frame[]; done: Promise<void>; disconnect(): void } {
  const gone = new AbortController();
  const chunks: string[] = [];
  const frames: Frame[] = [];
  const done = (async () => {
    for await (const chunk of open(gone.signal)) {
      chunks.push(chunk);
      const f = parseFrame(chunk.replace(/\n\n$/, ""));
      if (f) frames.push(f);
    }
  })();
  return { chunks, frames, done, disconnect: () => gone.abort() };
}

async function harness() {
  const home = await mkdtemp(join(tmpdir(), "helm2-sse-"));
  const logs = new LogRegistry(join(home, "threads"));
  const threads = new ThreadStore(join(home, "threads"));
  const sup = new Supervisor(logs, threads, new FakeAgentFactory(), { additionalDirectories: [], idleParkMs: 60_000, offers: new Offers(threads, logs, home), vaultRoot: home });
  const log = await logs.get(threadId);
  const queued = (i: number) => ({ kind: "input.queued" as const, clientMsgId: `m${i}` as ClientMsgId, text: `msg ${i}`, uploads: [], origin });
  return { home, logs, threads, sup, log, queued, cleanup: () => rm(home, { recursive: true }) };
}

const ev = (f: Frame): f is Extract<Frame, { kind: "event" }> => f.kind === "event";

test("threadStream: replay from cursor, then sync, then live, with appends racing the replay: gap-free and duplicate-free", async () => {
  const h = await harness();
  for (let i = 1; i <= 50; i++) await h.log.append(h.queued(i));

  const r = reader((signal) => threadStream(h.log, h.sup, 10 as Cursor, FIRST_GENERATION, { heartbeatMs: 60_000, signal }));
  // Race: append while the replay is in flight.
  for (let i = 51; i <= 70; i++) await h.log.append(h.queued(i));
  await new Promise((r) => setTimeout(r, 20));
  // Live phase.
  for (let i = 71; i <= 75; i++) await h.log.append(h.queued(i));
  r.disconnect();
  await r.done;

  assert.equal(r.chunks[0], "retry: 1000\n\n", "the retry hint opens the stream");
  assert.deepEqual(r.frames.filter(ev).map((f) => f.ev.seq), Array.from({ length: 65 }, (_, i) => i + 11));
  assert.deepEqual(r.frames.filter(ev).map((f) => f.id), Array.from({ length: 65 }, (_, i) => i + 11), "id is the seq, so Last-Event-ID resumes exactly");
  const syncIx = r.frames.findIndex((f) => f.kind === "sync");
  assert.ok(syncIx > 0, "sync frame present");
  const sync = r.frames[syncIx] as Extract<Frame, { kind: "sync" }>;
  const beforeSync = r.frames.slice(0, syncIx).filter(ev).length;
  assert.equal(sync.frame.headSeq, 10 + beforeSync, "sync headSeq equals the last replayed seq");
  assert.equal(sync.frame.session, "cold");
  assert.equal(sync.frame.openTurn, null);
  assert.equal(sync.frame.queuedCount, 10 + beforeSync);
  assert.equal(h.log.viewerCount(), 0, "listener detached after disconnect");
  await h.cleanup();
});

test("threadStream from cursor 0 on an empty log sends only sync, then live events", async () => {
  const h = await harness();
  const r = reader((signal) => threadStream(h.log, h.sup, 0, FIRST_GENERATION, { heartbeatMs: 60_000, signal }));
  await new Promise((r) => setTimeout(r, 10));
  await h.log.append(h.queued(1));
  r.disconnect();
  await r.done;
  assert.deepEqual(r.frames.map((f) => f.kind), ["sync", "event"]);
  await h.cleanup();
});

test("threadStream heartbeats while idle and stops on disconnect", async () => {
  const h = await harness();
  const r = reader((signal) => threadStream(h.log, h.sup, 0, FIRST_GENERATION, { heartbeatMs: 5, signal }));
  await new Promise((r) => setTimeout(r, 40));
  r.disconnect();
  await r.done;
  const beats = r.chunks.filter((c) => c === ": hb\n\n").length;
  assert.ok(beats >= 3, `heartbeats: ${beats}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(r.chunks.filter((c) => c === ": hb\n\n").length, beats, "no heartbeats after the stream ended");
  await h.cleanup();
});

test("threadStream with a cursor beyond the head reports the true head so the client can reset", async () => {
  const h = await harness();
  await h.log.append(h.queued(1));
  const r = reader((signal) => threadStream(h.log, h.sup, 99 as Cursor, FIRST_GENERATION, { heartbeatMs: 60_000, signal }));
  await new Promise((r) => setTimeout(r, 10));
  r.disconnect();
  await r.done;
  const sync = r.frames.find((f): f is Extract<Frame, { kind: "sync" }> => f.kind === "sync");
  assert.equal(sync?.frame.headSeq, 1);
  await h.cleanup();
});

test("a consumer that stops iterating detaches the listener too", async () => {
  const h = await harness();
  const it = threadStream(h.log, h.sup, 0, null, { heartbeatMs: 60_000 })[Symbol.asyncIterator]();
  await it.next();
  assert.equal(h.log.viewerCount(), 1);
  await it.return?.();
  assert.equal(h.log.viewerCount(), 0);
  await h.cleanup();
});

test("globalStream forwards only thread and turn boundary events, tagged by thread", async () => {
  const h = await harness();
  const other = "0f0f0f0f-0000-4000-8000-0000000000ff" as ThreadId;
  const otherLog = await h.logs.get(other);
  const r = reader((signal) => globalStream(h.logs, { heartbeatMs: 60_000, signal }));
  await new Promise((r) => setTimeout(r, 5));
  await h.log.append(h.queued(1));
  await h.log.append({ kind: "assistant.text", turnId: "t:1" as never, blockIx: 0, delta: "x" });
  await otherLog.append({ kind: "thread.config", patch: { title: "T" }, origin });
  await h.log.append({ kind: "turn.ended", turnId: "t:1" as never, outcome: "ok", sessionId: null, usage: null, error: null });
  // A log opened after attach is covered too.
  const late = "0f0f0f0f-0000-4000-8000-000000000011" as ThreadId;
  const lateLog = await h.logs.get(late);
  await lateLog.append({ kind: "thread.archived" });
  r.disconnect();
  await r.done;
  const got = r.frames.filter(ev).map((f) => `${f.ev.threadId?.slice(-2)}:${f.ev.kind}`);
  assert.deepEqual(got, ["ee:input.queued", "ff:thread.config", "ee:turn.ended", "11:thread.archived"]);
  assert.equal(r.frames.filter(ev).every((f) => f.id === -1), true, "global events carry no id: there is no cursor to resume from");
  assert.equal(h.log.viewerCount(), 0);
  await h.cleanup();
});

test("cursorFrom: Last-Event-ID wins over ?after, gen rides alongside, bad values are rejected", () => {
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5"), null), { ok: true, after: 5, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5"), "9"), { ok: true, after: 9, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e"), null), { ok: true, after: 0, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=-1"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=abc"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after="), null), { ok: true, after: 0, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=1.5"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=99999999999999999999"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e"), ""), { ok: true, after: 0, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5&gen=2"), null), { ok: true, after: 5, generation: 2 });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5&gen=0"), "7"), { ok: true, after: 7, generation: 0 });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5&gen="), null), { ok: true, after: 5, generation: null });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5&gen=-1"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5&gen=x"), null), { ok: false });
});

/** A completed turn of many small deltas, so the log has something to compact. */
async function compactableTurn(h: Awaited<ReturnType<typeof harness>>): Promise<void> {
  await h.log.append({ kind: "thread.created", config: (await h.threads.create({ threadId, cwd: h.home, model: "claude-opus-5" as never, effort: "high", permissionMode: "bypass" })) });
  await h.log.append(h.queued(1));
  const start = await h.log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m1" as ClientMsgId, model: "claude-opus-5" as never, effort: "high" as const, spawned: true }));
  for (let i = 0; i < 20; i++) await h.log.append({ kind: "assistant.text", turnId: start.turnId, blockIx: 0, delta: `w${i} ` });
  await h.log.append({ kind: "turn.ended", turnId: start.turnId, outcome: "ok", sessionId: null, usage: null, error: null });
}

test("a cursor from an older generation gets exactly one sync frame naming the new generation, no events, and the stream ends", async () => {
  const h = await harness();
  await compactableTurn(h);
  const oldHead = h.log.getHead().lastSeq;
  assert.equal((await h.log.compact()).ok, true);
  assert.equal(h.log.getHead().generation, 1);

  for (const gen of [FIRST_GENERATION, null]) {
    const r = reader((signal) => threadStream(h.log, h.sup, oldHead, gen, { heartbeatMs: 60_000, signal }));
    await r.done;
    assert.deepEqual(r.frames.map((f) => f.kind), ["sync"], `gen ${gen}: one sync and nothing else`);
    const sync = r.frames[0] as Extract<Frame, { kind: "sync" }>;
    assert.equal(sync.frame.generation, 1);
    assert.equal(sync.frame.headSeq, h.log.getHead().lastSeq);
    assert.equal(h.log.viewerCount(), 0, "the listener is detached when the stream ends on its own");
  }

  const fresh = reader((signal) => threadStream(h.log, h.sup, 0, FIRST_GENERATION, { heartbeatMs: 60_000, signal }));
  await new Promise((r) => setTimeout(r, 20));
  fresh.disconnect();
  await fresh.done;
  assert.equal(fresh.frames.filter(ev).length, h.log.getHead().lastSeq, "a cursor of 0 replays whatever generation it names");
  assert.equal(fresh.frames.filter(ev)[0]?.ev.kind, "log.generation");

  const current = reader((signal) => threadStream(h.log, h.sup, 2 as Cursor, 1 as Generation, { heartbeatMs: 60_000, signal }));
  await new Promise((r) => setTimeout(r, 20));
  current.disconnect();
  await current.done;
  assert.equal(current.frames.filter(ev).length, h.log.getHead().lastSeq - 2, "a cursor in the current generation resumes exactly");
  await h.cleanup();
});
