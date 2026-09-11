import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogRegistry, ThreadLog, lastAssistantText } from "./log";
import type {
  ClaudeSessionId,
  ClientMsgId,
  Cursor,
  ModelId,
  Seq,
  ThreadConfig,
  ThreadEvent,
  ThreadEventBody,
  ThreadId,
  TurnId,
} from "../../shared/protocol";

const threadId = "0f0f0f0f-0000-4000-8000-000000000001" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
const sessionId = "sess-1" as ClaudeSessionId;

function config(): ThreadConfig {
  return {
    threadId,
    cwd: "/tmp",
    model: "claude-opus-5" as ModelId,
    effort: "high",
    title: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    archivedAt: null,
  };
}

function queued(id: string, text = "hello"): ThreadEventBody {
  return { kind: "input.queued", clientMsgId: id as ClientMsgId, text, uploads: [], origin };
}

function started(turnId: string, id: string): ThreadEventBody {
  return { kind: "turn.started", turnId: turnId as TurnId, clientMsgId: id as ClientMsgId, model: "claude-opus-5" as ModelId, effort: "high", spawned: true };
}

function ended(turnId: string): ThreadEventBody {
  return { kind: "turn.ended", turnId: turnId as TurnId, outcome: "ok", sessionId, usage: null, error: null };
}

/** A complete turn: 8 events, the last one is turn.ended. */
const completeTurn: readonly ThreadEventBody[] = [
  { kind: "thread.created", config: config() },
  queued("m1", "first message"),
  { kind: "session.bound", sessionId },
  started("t:4", "m1"),
  { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "Hel" },
  { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "lo" },
  { kind: "tool.started", turnId: "t:4" as TurnId, toolUseId: "tu1" as never, name: "Read", input: { path: "/x" } },
  ended("t:4"),
];

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "helm2-log-"));
}

async function collect(log: ThreadLog, after: Cursor): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for await (const ev of log.read(after)) out.push(ev);
  return out;
}

async function writeLog(dir: string, bodies: readonly ThreadEventBody[]): Promise<ThreadLog> {
  const log = await ThreadLog.open(threadId, dir);
  for (const b of bodies) await log.append(b);
  return log;
}

test("append mints contiguous seq and read(after) replays exactly seq > after", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, completeTurn);
  const all = await collect(log, 0);
  assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (let c = 0; c <= 8; c++) {
    const got = await collect(log, c as Cursor);
    assert.deepEqual(got.map((e) => e.seq), all.slice(c).map((e) => e.seq), `cursor ${c}`);
  }
  assert.equal(log.getHead().lastSeq, 8);
  assert.equal(log.getHead().sessionId, sessionId);
  assert.equal(log.getHead().openTurn, null);
  assert.equal(log.getHead().queued.length, 0);
  assert.equal(log.getHead().recentClientMsgIds.get("m1" as ClientMsgId), 2);
  await rm(dir, { recursive: true });
});

test("torn tail: truncating at every byte of the last line repairs on open, replay is gap-free and duplicate-free", async () => {
  const src = await freshDir();
  await writeLog(src, completeTurn);
  const file = join(src, "events.jsonl");
  const bytes = await readFile(file);
  const lastNl = bytes.lastIndexOf(0x0a, bytes.length - 2);
  const lastLineStart = lastNl + 1;
  assert.ok(lastLineStart > 0 && lastLineStart < bytes.length - 1);

  for (let cut = lastLineStart; cut < bytes.length; cut++) {
    const dir = await freshDir();
    await writeFile(join(dir, "events.jsonl"), bytes.subarray(0, cut));
    const log = await ThreadLog.open(threadId, dir);

    const events = await collect(log, 0);
    const seqs = events.map((e) => e.seq);
    // 7 intact lines survive; the torn turn.ended is replaced by an orphaned one (I3 + I4).
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8], `cut=${cut}`);
    const last = events[7]!;
    assert.equal(last.kind, "turn.ended", `cut=${cut}`);
    if (last.kind === "turn.ended") {
      assert.equal(last.outcome, "orphaned", `cut=${cut}`);
      assert.equal(last.sessionId, sessionId, `cut=${cut}`);
      assert.equal(last.turnId, "t:4", `cut=${cut}`);
    }
    for (let c = 0; c <= 8; c++) {
      const got = await collect(log, c as Cursor);
      assert.deepEqual(got.map((e) => e.seq), seqs.slice(c), `cut=${cut} cursor=${c}`);
    }
    assert.equal(log.getHead().lastSeq, 8);
    assert.equal(log.getHead().openTurn, null);

    // Open twice is a no-op: same bytes, same head.
    const before = await readFile(join(dir, "events.jsonl"));
    const again = await ThreadLog.open(threadId, dir);
    const after = await readFile(join(dir, "events.jsonl"));
    assert.equal(after.equals(before), true, `cut=${cut} second open changed the file`);
    assert.equal(again.getHead().lastSeq, 8);
    await rm(dir, { recursive: true });
  }
  await rm(src, { recursive: true });
});

test("crash inside a turn: open appends turn.ended {orphaned} and input.dropped {restart} for unstarted inputs", async () => {
  const dir = await freshDir();
  const bodies: ThreadEventBody[] = [
    { kind: "thread.created", config: config() },
    queued("m1"),
    { kind: "session.bound", sessionId },
    started("t:4", "m1"),
    { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "partial" },
    queued("m2", "second"),
    queued("m3", "third"),
  ];
  await writeLog(dir, bodies);

  const reopened = await ThreadLog.open(threadId, dir);
  const events = await collect(reopened, 0);
  const tail = events.slice(7).map((e) => (e.kind === "turn.ended" ? `${e.kind}:${e.outcome}:${e.sessionId}` : e.kind === "input.dropped" ? `${e.kind}:${e.clientMsgId}:${e.reason}` : e.kind));
  assert.deepEqual(tail, ["turn.ended:orphaned:sess-1", "input.dropped:m2:restart", "input.dropped:m3:restart"]);
  assert.equal(reopened.getHead().openTurn, null);
  assert.equal(reopened.getHead().queued.length, 0);
  assert.equal(reopened.getHead().lastSeq, 10);

  const bytesBefore = await readFile(join(dir, "events.jsonl"));
  await ThreadLog.open(threadId, dir);
  const bytesAfter = await readFile(join(dir, "events.jsonl"));
  assert.equal(bytesAfter.equals(bytesBefore), true, "second open must not repair again");
  await rm(dir, { recursive: true });
});

test("a torn line that is also the only input.queued after turn.ended leaves a clean idle head", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [...completeTurn, queued("m9", "never made it")]);
  const file = join(dir, "events.jsonl");
  const bytes = await readFile(file);
  await truncate(file, bytes.length - 5);
  const reopened = await ThreadLog.open(threadId, dir);
  assert.equal(reopened.getHead().lastSeq, 8);
  assert.equal(reopened.getHead().queued.length, 0);
  assert.equal(log.threadId, reopened.threadId);
  await rm(dir, { recursive: true });
});

test("I2: a subscriber sees an event only once it is on disk; subscribe-before-read handoff has no gap and no dup", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  await log.append({ kind: "thread.created", config: config() });

  const seen: ThreadEvent[] = [];
  const onDiskAtEmit: boolean[] = [];
  const unsub = log.subscribe((ev) => {
    seen.push(ev);
    // Synchronous check that the line is already in the file.
    const text = readFileSync(join(dir, "events.jsonl"), "utf8");
    onDiskAtEmit.push(text.includes(`"seq":${ev.seq},`));
  });

  // Appends racing a replay from cursor 0.
  const appends = Promise.all([log.append(queued("a")), log.append(queued("b")), log.append(queued("c"))]);
  const replayed = await collect(log, 0);
  await appends;
  unsub();
  await log.append(queued("d")); // after unsubscribe: must not be seen

  assert.deepEqual(onDiskAtEmit, [true, true, true], "emitted before on disk");
  assert.deepEqual(seen.map((e) => e.seq), [2, 3, 4]);

  // Merge the way sse.ts does: replay then buffered minus already-sent.
  const lastSent = replayed.at(-1)?.seq ?? 0;
  const merged = [...replayed, ...seen.filter((e) => e.seq > lastSent)];
  assert.deepEqual(merged.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(log.subscriberCount(), 0);
  await rm(dir, { recursive: true });
});

test("appendDelta coalesces same-block deltas and flushDeltas preserves model order before a non-delta append", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  const t = "t:1" as TurnId;
  log.appendDelta({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "a" });
  log.appendDelta({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "b" });
  log.appendDelta({ kind: "assistant.thinking", turnId: t, delta: "th" });
  log.appendDelta({ kind: "assistant.text", turnId: t, blockIx: 1, delta: "c" });
  await log.flushDeltas();
  await log.append({ kind: "tool.started", turnId: t, toolUseId: "x" as never, name: "Bash", input: {} });
  const events = await collect(log, 0);
  assert.deepEqual(
    events.map((e) => (e.kind === "assistant.text" ? `text${e.blockIx}:${e.delta}` : e.kind === "assistant.thinking" ? `think:${e.delta}` : e.kind)),
    ["text0:ab", "think:th", "text1:c", "tool.started"],
  );
  await rm(dir, { recursive: true });
});

test("LogRegistry returns one instance per thread, recovers every thread dir at boot, and notifies onOpen", async () => {
  const root = await freshDir();
  const other = "0f0f0f0f-0000-4000-8000-000000000002" as ThreadId;
  await mkdir(join(root, other));
  await writeFile(join(root, other, "events.jsonl"), JSON.stringify({ seq: 1, ts: "x", ...started("t:1", "m") }) + "\n");
  await writeFile(join(root, "not-a-thread.txt"), "");

  const reg = new LogRegistry(root);
  const opened: ThreadId[] = [];
  reg.onOpen((log) => opened.push(log.threadId));
  const ids = await reg.recoverAll();
  assert.deepEqual([...ids].sort(), [other]);
  const otherLog = await reg.get(other);
  assert.equal(otherLog.getHead().lastSeq, 2);
  assert.equal(otherLog.getHead().openTurn, null);

  const [a, b] = await Promise.all([reg.get(threadId), reg.get(threadId)]);
  assert.equal(a, b);
  assert.equal(await reg.get(threadId), a);
  assert.deepEqual(opened, [other, threadId]);
  await rm(root, { recursive: true });
});

test("lastAssistantText returns the tail of the last turn's text, capped", () => {
  const t = "t:1" as TurnId;
  const evs = [
    { seq: 1 as Seq, ts: "", kind: "assistant.text", turnId: t, blockIx: 0, delta: "Hello " },
    { seq: 2 as Seq, ts: "", kind: "assistant.text", turnId: t, blockIx: 0, delta: "world" },
    { seq: 3 as Seq, ts: "", kind: "assistant.text", turnId: "t:2" as TurnId, blockIx: 0, delta: "Second turn reply" },
  ] as ThreadEvent[];
  assert.equal(lastAssistantText(evs, 120), "Second turn reply");
  assert.equal(lastAssistantText(evs, 6), "Second");
  assert.equal(lastAssistantText([], 10), null);
});
