import { Offers } from "../core/offers";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMsgId, Cursor, ModelId, SyncFrame, ThreadEvent, ThreadId } from "../../shared/protocol";
import { FakeAgentFactory } from "../core/agent.fake";
import { LogRegistry } from "../core/log";
import { Supervisor } from "../core/supervisor";
import { ThreadStore } from "../core/thread-store";
import { cursorFrom, formatComment, formatControl, formatEvent, streamGlobal, streamThread, type SseSink } from "./sse";

const origin = { via: "pwa", label: "iphone" } as const;
const threadId = "0f0f0f0f-0000-4000-8000-0000000000ee" as ThreadId;

type Frame = { t: "event"; ev: ThreadEvent } | { t: "sync"; frame: SyncFrame } | { t: "comment"; text: string } | { t: "close" };

function capturingSink(): SseSink & { frames: Frame[]; disconnect(): void } {
  let resolveClosed = (): void => {};
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const frames: Frame[] = [];
  return {
    frames,
    closed,
    event: (ev) => frames.push({ t: "event", ev }),
    control: (_name, frame) => frames.push({ t: "sync", frame }),
    comment: (text) => frames.push({ t: "comment", text }),
    close: () => {
      frames.push({ t: "close" });
      resolveClosed();
    },
    disconnect: () => resolveClosed(),
  };
}

async function harness() {
  const home = await mkdtemp(join(tmpdir(), "helm2-sse-"));
  const logs = new LogRegistry(join(home, "threads"));
  const threads = new ThreadStore(join(home, "threads"));
  const sup = new Supervisor(logs, threads, new FakeAgentFactory(), { additionalDirectories: [], idleParkMs: 60_000, offers: new Offers(threads, logs) });
  const log = await logs.get(threadId);
  const queued = (i: number) => ({ kind: "input.queued" as const, clientMsgId: `m${i}` as ClientMsgId, text: `msg ${i}`, uploads: [], origin });
  return { home, logs, threads, sup, log, queued, cleanup: () => rm(home, { recursive: true }) };
}

test("streamThread: replay from cursor, then sync, then live, with appends racing the replay: gap-free and duplicate-free", async () => {
  const h = await harness();
  for (let i = 1; i <= 50; i++) await h.log.append(h.queued(i));

  const sink = capturingSink();
  const after = 10 as Cursor;
  const done = streamThread(h.log, h.sup, after, sink, { heartbeatMs: 60_000 });
  // Race: append while the replay is in flight.
  const racing = (async () => {
    for (let i = 51; i <= 70; i++) await h.log.append(h.queued(i));
  })();
  await racing;
  await new Promise((r) => setTimeout(r, 20));
  // Live phase.
  for (let i = 71; i <= 75; i++) await h.log.append(h.queued(i));
  sink.disconnect();
  await done;

  const seqs = sink.frames.filter((f): f is Extract<Frame, { t: "event" }> => f.t === "event").map((f) => f.ev.seq);
  assert.deepEqual(seqs, Array.from({ length: 65 }, (_, i) => i + 11));
  const syncIx = sink.frames.findIndex((f) => f.t === "sync");
  assert.ok(syncIx > 0, "sync frame present");
  const sync = sink.frames[syncIx] as Extract<Frame, { t: "sync" }>;
  const beforeSync = sink.frames.slice(0, syncIx).filter((f) => f.t === "event").length;
  assert.equal(sync.frame.headSeq, 10 + beforeSync, "sync headSeq equals the last replayed seq");
  assert.equal(sync.frame.session, "cold");
  assert.equal(sync.frame.openTurn, null);
  assert.equal(sync.frame.queuedCount, 10 + beforeSync);
  assert.equal(sink.frames.at(-1)?.t, "close");
  assert.equal(h.log.viewerCount(), 0, "listener detached after disconnect");
  await h.cleanup();
});

test("streamThread from cursor 0 on an empty log sends only sync, then live events", async () => {
  const h = await harness();
  const sink = capturingSink();
  const done = streamThread(h.log, h.sup, 0, sink, { heartbeatMs: 60_000 });
  await new Promise((r) => setTimeout(r, 10));
  await h.log.append(h.queued(1));
  sink.disconnect();
  await done;
  assert.deepEqual(sink.frames.map((f) => f.t), ["sync", "event", "close"]);
  await h.cleanup();
});

test("streamThread heartbeats while idle", async () => {
  const h = await harness();
  const sink = capturingSink();
  const done = streamThread(h.log, h.sup, 0, sink, { heartbeatMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  sink.disconnect();
  await done;
  assert.ok(sink.frames.filter((f) => f.t === "comment").length >= 3);
  await h.cleanup();
});

test("streamThread with a cursor beyond the head reports the true head so the client can reset", async () => {
  const h = await harness();
  await h.log.append(h.queued(1));
  const sink = capturingSink();
  const done = streamThread(h.log, h.sup, 99 as Cursor, sink, { heartbeatMs: 60_000 });
  await new Promise((r) => setTimeout(r, 10));
  sink.disconnect();
  await done;
  const sync = sink.frames.find((f): f is Extract<Frame, { t: "sync" }> => f.t === "sync");
  assert.equal(sync?.frame.headSeq, 1);
  await h.cleanup();
});

test("streamGlobal forwards only thread and turn boundary events, tagged by thread", async () => {
  const h = await harness();
  const other = "0f0f0f0f-0000-4000-8000-0000000000ff" as ThreadId;
  const otherLog = await h.logs.get(other);
  const got: string[] = [];
  let resolveClosed = (): void => {};
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const done = streamGlobal(h.logs, { event: (id, ev) => got.push(`${id.slice(-2)}:${ev.kind}`), comment: () => {}, closed }, { heartbeatMs: 60_000 });
  await new Promise((r) => setTimeout(r, 5));
  await h.log.append(h.queued(1));
  await h.log.append({ kind: "assistant.text", turnId: "t:1" as never, blockIx: 0, delta: "x" });
  await otherLog.append({ kind: "thread.config", patch: { title: "T" }, origin });
  await h.log.append({ kind: "turn.ended", turnId: "t:1" as never, outcome: "ok", sessionId: null, usage: null, error: null });
  // A log opened after attach is covered too.
  const late = "0f0f0f0f-0000-4000-8000-000000000011" as ThreadId;
  const lateLog = await h.logs.get(late);
  await lateLog.append({ kind: "thread.archived" });
  resolveClosed();
  await done;
  assert.deepEqual(got, ["ee:input.queued", "ff:thread.config", "ee:turn.ended", "11:thread.archived"]);
  assert.equal(h.log.viewerCount(), 0);
  await h.cleanup();
});

test("cursorFrom: Last-Event-ID wins over ?after, bad values are rejected", () => {
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5"), null), { ok: true, after: 5 });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=5"), "9"), { ok: true, after: 9 });
  assert.deepEqual(cursorFrom(new URL("http://x/e"), null), { ok: true, after: 0 });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=-1"), null), { ok: false });
  assert.deepEqual(cursorFrom(new URL("http://x/e?after=abc"), null), { ok: false });
});

test("wire formatting: id is the seq, control frames carry no id, comments are comments", () => {
  const ev = { seq: 7, ts: "t", kind: "thread.archived" } as ThreadEvent;
  assert.equal(formatEvent(ev), 'id: 7\ndata: {"seq":7,"ts":"t","kind":"thread.archived"}\n\n');
  const sync: SyncFrame = { headSeq: 7 as Cursor, session: "idle", openTurn: null, queuedCount: 0 };
  assert.equal(formatControl("sync", sync), 'event: sync\ndata: {"headSeq":7,"session":"idle","openTurn":null,"queuedCount":0}\n\n');
  assert.equal(formatComment("hb"), ": hb\n\n");
  const model: ModelId = "m" as ModelId;
  assert.equal(typeof model, "string");
});
