import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogRegistry, ThreadLog, turnIdFor } from "./log";
import type {
  AskId,
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
    permissionMode: "bypass",
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

test("turnIdFor names a turn by the seq of its turn.started, so a TurnId is always derivable from the log", async () => {
  assert.equal(turnIdFor(4 as Seq), "t:4");
  const log = await writeLog(await freshDir(), [{ kind: "thread.created", config: config() }]);
  const ev = await log.append((seq) => started(turnIdFor(seq), "m1"));
  assert.equal(ev.kind === "turn.started" && ev.turnId, `t:${ev.seq}`);
});

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

const askOpened = (turnId: string, askId: string): ThreadEventBody => ({ kind: "ask.opened", turnId: turnId as TurnId, askId: askId as AskId, ask: { kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "tu9" as never, title: null, description: null } });

test("asks: the pending set is opened minus answered, cleared by turn.ended, and recent ids outlive it", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [{ kind: "thread.created", config: config() }, queued("m1"), started("t:3", "m1"), askOpened("t:3", "a1"), askOpened("t:3", "a2")]);
  assert.deepEqual(log.getHead().pendingAsks.map((a) => a.askId), ["a1", "a2"]);
  await log.append({ kind: "ask.answered", turnId: "t:3" as TurnId, askId: "a1" as AskId, answer: { kind: "allow" }, by: { by: "user", origin } });
  assert.deepEqual(log.getHead().pendingAsks.map((a) => a.askId), ["a2"]);
  await log.append(ended("t:3"));
  assert.deepEqual(log.getHead().pendingAsks, []);
  assert.deepEqual([...log.getHead().recentAskIds], ["a1", "a2"]);
  await log.append(askOpened("t:3", "a3"));
  assert.deepEqual(log.getHead().pendingAsks, [], "an ask for a turn that is not open is never pending");
  await rm(dir, { recursive: true });
});

test("crash with asks pending: open seals each as {system: restart} before the orphaned turn.ended, and only once", async () => {
  const dir = await freshDir();
  await writeLog(dir, [{ kind: "thread.created", config: config() }, queued("m1"), started("t:3", "m1"), askOpened("t:3", "a1"), askOpened("t:3", "a2")]);
  const reopened = await ThreadLog.open(threadId, dir);
  const tail = (await collect(reopened, 5 as Cursor)).map((e) => (e.kind === "ask.answered" ? `${e.kind}:${e.askId}:${e.answer.kind}:${e.by.by === "system" ? e.by.reason : "?"}` : e.kind === "turn.ended" ? `${e.kind}:${e.outcome}` : e.kind));
  assert.deepEqual(tail, ["ask.answered:a1:deny:restart", "ask.answered:a2:deny:restart", "turn.ended:orphaned"]);
  assert.deepEqual(reopened.getHead().pendingAsks, []);
  assert.equal(reopened.getHead().recentAskIds.has("a2" as AskId), true);
  const before = await readFile(join(dir, "events.jsonl"));
  await ThreadLog.open(threadId, dir);
  assert.equal((await readFile(join(dir, "events.jsonl"))).equals(before), true, "second open must not seal again");
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
  const unsub = log.subscribe("viewer", (ev) => {
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
  assert.equal(log.viewerCount(), 0);
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


test("hardening: multi-byte text survives replay across read chunk boundaries", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [{ kind: "thread.created", config: config() }]);
  const delta = "héllo wörld ünïcödé 日本語 🚀 ".repeat(40);
  const live: string[] = [];
  log.subscribe("projection", (ev) => ev.kind === "assistant.text" && live.push(ev.delta));
  for (let i = 0; i < 150; i++) await log.append({ kind: "assistant.text", turnId: "t:1" as TurnId, blockIx: 0, delta });
  const replayed = (await collect(log, 1 as Cursor)).map((e) => (e.kind === "assistant.text" ? e.delta : ""));
  assert.deepEqual(replayed, live);
  await rm(dir, { recursive: true });
});

test("hardening: degenerate files (a lone newline, blank lines, garbage) open cleanly and empty", async () => {
  for (const content of ["\n", "\n\n", "garbage\n", "garbage", "{}\n\n"]) {
    const dir = await freshDir();
    await writeFile(join(dir, "events.jsonl"), content);
    const log = await Promise.race([ThreadLog.open(threadId, dir), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`open hung on ${JSON.stringify(content)}`)), 2000))]);
    assert.equal(log.getHead().lastSeq, content === "{}\n\n" ? 0 : 0, JSON.stringify(content));
    await log.append(queued("a"));
    assert.deepEqual((await collect(log, 0)).map((e) => e.seq), [1], JSON.stringify(content));
    await rm(dir, { recursive: true });
  }
});

test("hardening: a torn line in the middle of the file is treated as the tear point", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, completeTurn);
  const file = join(dir, "events.jsonl");
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  await writeFile(file, [...lines.slice(0, 3), lines[3]!.slice(0, 10), ...lines.slice(4)].join("\n") + "\n");
  const reopened = await ThreadLog.open(log.threadId, dir);
  const evs = await collect(reopened, 0);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4]);
  assert.equal(evs[3]?.kind, "input.dropped", "the queued input from before the tear is dropped by the repair");
  await rm(dir, { recursive: true });
});

test("hardening: a failed append leaves no stray bytes and the next append reuses the seq cleanly", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [{ kind: "thread.created", config: config() }]);
  const file = join(dir, "events.jsonl");
  const before = await readFile(file);
  const { chmod } = await import("node:fs/promises");
  await chmod(file, 0o444);
  await assert.rejects(log.append(queued("x")));
  await chmod(file, 0o644);
  assert.equal((await readFile(file)).equals(before), true, "no stray bytes after a failed write");
  const ev = await log.append(queued("y"));
  assert.equal(ev.seq, 2);
  assert.deepEqual((await collect(log, 0)).map((e) => e.seq), [1, 2]);
  await rm(dir, { recursive: true });
});

test("hardening: appendIf checks its predicate inside the serial queue, so concurrent duplicates cannot both pass", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [{ kind: "thread.created", config: config() }]);
  const results = await Promise.all(Array.from({ length: 5 }, () => log.appendIf((h) => !h.recentClientMsgIds.has("dup" as ClientMsgId), queued("dup"))));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(log.getHead().queued.length, 1);
  await rm(dir, { recursive: true });
});

test("hardening: a non-delta append flushes pending deltas first, so the log keeps model order without call-site discipline", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  log.appendDelta({ kind: "assistant.text", turnId: "t:1" as TurnId, blockIx: 0, delta: "already produced" });
  await log.append(queued("late"));
  assert.deepEqual((await collect(log, 0)).map((e) => e.kind), ["assistant.text", "input.queued"]);
  await rm(dir, { recursive: true });
});
