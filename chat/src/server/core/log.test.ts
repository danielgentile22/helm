import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnIdFor } from "../../shared/protocol";
import { groupTurns, type Turn } from "../../shared/turns";
import type { ThreadHead } from "./log";
import { compactEvents, LogRegistry, renumber, ThreadLog, writeLogFile } from "./log";
import type {
  MessageUuid,
  AskId,
  ClaudeSessionId,
  ClientMsgId,
  FileId,
  Cursor,
  Generation,
  ModelId,
  Seq,
  ThreadConfig,
  ThreadEvent,
  ThreadEventBody,
  ThreadId,
  TurnId,
  Usage,
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

test("thread.forked drops the source session from the head and parks the fork point, which the next spawn boundary clears", async () => {
  const dir = await freshDir();
  const forked: ThreadEventBody = { kind: "thread.forked", from: threadId, fromTitle: "Source", atTurn: "t:4" as TurnId, resume: { sessionId, at: "msg-1" as MessageUuid } };
  const log = await writeLog(dir, [...completeTurn, forked]);

  assert.equal(log.getHead().sessionId, null, "a fork must never resume the source's session plainly, which would mutate the source's session file");
  assert.deepEqual(log.getHead().fork, { sessionId, at: "msg-1" as MessageUuid });

  await log.append({ kind: "session.bound", sessionId: "sess-fork" as ClaudeSessionId });
  assert.equal(log.getHead().sessionId, "sess-fork");
  assert.equal(log.getHead().fork, null, "the SDK minted a new session for the fork; there is nothing left to fork from");
});

test("a turn.ended clears the fork point too, so a resume the SDK refused is retried fresh rather than forever", async () => {
  const dir = await freshDir();
  const forked: ThreadEventBody = { kind: "thread.forked", from: threadId, fromTitle: null, atTurn: "t:4" as TurnId, resume: { sessionId, at: "msg-1" as MessageUuid } };
  const log = await writeLog(dir, [...completeTurn, forked, queued("m2"), started("t:11", "m2")]);
  await log.append(ended("t:11"));
  assert.equal(log.getHead().fork, null);
});

test("thread.forked with no resume leaves the head with nothing to resume at all", async () => {
  const dir = await freshDir();
  const log = await writeLog(dir, [...completeTurn, { kind: "thread.forked", from: threadId, fromTitle: null, atTurn: "t:4" as TurnId, resume: null }]);
  assert.equal(log.getHead().sessionId, null);
  assert.equal(log.getHead().fork, null);
});

test("renumber numbers a whole log from 1, remaps every turn id to its new seq, and keeps each body's own timestamp; writeLogFile writes it back readable", async () => {
  const dir = await freshDir();
  const stamped = renumber([
    { kind: "thread.created", config: config(), ts: "2026-09-14T00:00:00.000Z" },
    { ...queued("m1"), ts: "2026-09-11T00:00:02.000Z" },
    { ...started("t:9", "m1"), ts: "2026-09-11T00:00:03.000Z" },
    { kind: "assistant.text", turnId: "t:9" as TurnId, blockIx: 0, delta: "x", ts: "2026-09-11T00:00:03.500Z" },
    { ...ended("t:9"), ts: "2026-09-11T00:00:04.000Z" },
    { kind: "thread.forked.out", to: threadId, toTitle: "copy", atTurn: "t:9" as TurnId, ts: "2026-09-11T00:00:05.000Z" },
    { kind: "thread.forked", from: threadId, fromTitle: null, atTurn: "t:9" as TurnId, resume: null, ts: "2026-09-11T00:00:06.000Z" },
    { kind: "tool.finished", turnId: "t:77" as TurnId, toolUseId: "tu" as never, output: "", isError: false, ts: "2026-09-11T00:00:07.000Z" },
  ]);
  assert.deepEqual(stamped.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(stamped.map((e) => e.ts).slice(0, 4), ["2026-09-14T00:00:00.000Z", "2026-09-11T00:00:02.000Z", "2026-09-11T00:00:03.000Z", "2026-09-11T00:00:03.500Z"]);
  assert.deepEqual(stamped.map((e) => ("turnId" in e ? e.turnId : e.kind === "thread.forked.out" || e.kind === "thread.forked" ? e.atTurn : "")), ["", "", "t:3", "t:3", "t:3", "t:3", "t:9", "t:77"], "turn ids follow their turn.started; a source turn and an unknown id are left alone");

  await writeLogFile(dir, stamped);
  const reopened = await ThreadLog.open(threadId, dir);
  assert.deepEqual(await collect(reopened, 0), stamped, "a log written in one go reopens exactly as it was written");
  assert.equal(reopened.getHead().lastSeq, 8);
  const next = await reopened.append(queued("m2"));
  assert.equal(next.seq, 9, "append picks the seq run up where the written file left off");
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

const usage: Usage = { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.01, contextTokens: 110, contextWindow: 200_000, durationMs: 900 };
const text = (turnId: string, blockIx: number, delta: string): ThreadEventBody => ({ kind: "assistant.text", turnId: turnId as TurnId, blockIx, delta });
const thinking = (turnId: string, delta: string): ThreadEventBody => ({ kind: "assistant.thinking", turnId: turnId as TurnId, delta });
const at = (i: number): string => `2026-09-11T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`;

/**
 * Several turns with one of everything: text in two blocks, thinking on
 * both sides of a tool, an ask, an upload, an offered file, a config
 * change, both halves of a fork, a session binding, and a queued input
 * with no turn after the last turn.ended. Turn ids are placeholders that
 * renumber resolves to `t:<seq>`.
 */
function busyLog(): ThreadEvent[] {
  const bodies: ThreadEventBody[] = [
    { kind: "thread.created", config: config() },
    queued("m1", "first"),
    { kind: "session.bound", sessionId },
    started("A", "m1"),
    thinking("A", "let "),
    thinking("A", "me "),
    thinking("A", "see"),
    text("A", 0, "Hel"),
    text("A", 0, "lo "),
    text("A", 0, "there"),
    { kind: "tool.started", turnId: "A" as TurnId, toolUseId: "tu1" as never, name: "Read", input: { file_path: "/x" } },
    { kind: "tool.finished", turnId: "A" as TurnId, toolUseId: "tu1" as never, output: "contents", isError: false },
    thinking("A", "after "),
    thinking("A", "the tool"),
    text("A", 1, "Second "),
    text("A", 1, "block"),
    { kind: "turn.ended", turnId: "A" as TurnId, outcome: "ok", sessionId, usage, error: null, forkPoint: "msg-1" as MessageUuid },
    { kind: "thread.forked.out", to: "0f0f0f0f-0000-4000-8000-000000000009" as ThreadId, toTitle: "copy", atTurn: "A" as TurnId },
    { kind: "thread.config", patch: { model: "claude-sonnet-5" as ModelId }, origin },
    { kind: "upload.staged", upload: { uploadId: "u1" as never, path: "/tmp/u1", name: "a.png", mime: "image/png", bytes: 3 }, origin },
    queued("m2", "second"),
    started("B", "m2"),
    askOpened("B", "a1"),
    { kind: "ask.answered", turnId: "B" as TurnId, askId: "a1" as AskId, answer: { kind: "allow" }, by: { by: "user", origin } },
    text("B", 0, "one"),
    { kind: "file.offered", file: { fileId: "f1" as never, path: "/tmp/r.pdf", name: "r.pdf", mime: "application/pdf", bytes: 9, note: null }, origin },
    text("B", 0, "two"),
    text("B", 0, "three"),
    { kind: "turn.ended", turnId: "B" as TurnId, outcome: "ok", sessionId, usage: { ...usage, contextTokens: 300 }, error: null },
    { kind: "thread.forked", from: "0f0f0f0f-0000-4000-8000-000000000008" as ThreadId, fromTitle: "src", atTurn: "t:44" as TurnId, resume: null },
    queued("m3", "third"),
    started("C", "m3"),
    text("C", 0, "un"),
    text("C", 0, "finished"),
    { kind: "turn.ended", turnId: "C" as TurnId, outcome: "interrupted", sessionId, usage: null, error: null },
    queued("m4", "never started"),
  ];
  return renumber(bodies.map((b, i) => ({ ...b, ts: at(i) })));
}

/** A turn with every seq-bearing field mapped through `map`, so two generations of one log compare equal. */
function normalize(turns: readonly Turn[], map: ReadonlyMap<Seq, Seq>): unknown[] {
  const seq = (n: number): number => map.get(n as Seq) ?? -1;
  const turnId = (id: TurnId | null): string | null => (id ? turnIdFor(seq(Number(id.slice(2))) as Seq) : null);
  return turns.map((t) => ({
    ...t,
    key: t.key.startsWith("t:") ? `t:${turnId(t.turnId)}` : t.key.startsWith("n:") ? `n:${seq(Number(t.key.slice(2)))}` : t.key,
    turnId: turnId(t.turnId),
    end: t.end ? { ...t.end, seq: seq(t.end.seq) } : null,
  }));
}

const identity = (events: readonly ThreadEvent[]): ReadonlyMap<Seq, Seq> => new Map(events.map((e) => [e.seq, e.seq]));

function headFields(h: ThreadHead): unknown {
  const { sessionId: s, usageTotal, contextTokens, contextWindow, lastOutcome, lastText, lastTurnEndedAt, queued: q } = h;
  return { sessionId: s, usageTotal, contextTokens, contextWindow, lastOutcome, lastText: lastText?.text ?? null, lastTurnEndedAt, queued: q.map((e) => e.clientMsgId) };
}

async function headOf(events: readonly ThreadEvent[]): Promise<ThreadHead> {
  const dir = await freshDir();
  await writeLogFile(dir, events);
  return (await ThreadLog.open(threadId, dir)).getHead();
}

test("compactEvents merges only consecutive same-key delta runs of completed turns, keeps everything else verbatim, and folds the same", async () => {
  const original = busyLog();
  const { events, seqMap, removed } = compactEvents(original, 1 as Generation, "2026-09-14T00:00:00.000Z");

  assert.equal(events[0]?.kind, "log.generation");
  assert.equal(events[0]?.kind === "log.generation" && events[0].generation, 1);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seqs are 1..n");
  assert.equal(removed, 8, "A: 2 thinking, 2 text, 1 thinking, 1 text; B: 1 text, the file splits the other; C: 1 text");
  assert.equal(events.length, original.length - removed + 1);

  assert.deepEqual(normalize(groupTurns(events), identity(events)), normalize(groupTurns(original), seqMap), "the turn fold is unchanged");
  assert.deepEqual(headFields(await headOf(events)), headFields(await headOf(original)), "the head is unchanged");

  const lastEnd = original.findLastIndex((e) => e.kind === "turn.ended");
  const strip = (e: ThreadEvent): unknown => {
    const { seq: _s, ...rest } = e as ThreadEvent & { turnId?: TurnId; atTurn?: TurnId };
    return { ...rest, turnId: undefined, atTurn: rest.kind === "thread.forked" ? rest.atTurn : undefined };
  };
  const isDelta = (e: ThreadEvent): boolean => e.kind === "assistant.text" || e.kind === "assistant.thinking";
  assert.deepEqual(events.slice(1).filter((e) => !isDelta(e)).map(strip), original.filter((e) => !isDelta(e)).map(strip), "every non-delta event is kept in order, verbatim modulo seq and turn id");
  assert.deepEqual(events.slice(events.length - (original.length - 1 - lastEnd)).map(strip), original.slice(lastEnd + 1).map(strip), "everything after the last turn.ended is verbatim");

  const deltas = events.filter(isDelta).map((e) => (e.kind === "assistant.text" ? `text${e.blockIx}:${e.delta}@${e.ts}` : e.kind === "assistant.thinking" ? `think:${e.delta}@${e.ts}` : ""));
  assert.deepEqual(deltas, [`think:let me see@${at(4)}`, `text0:Hello there@${at(7)}`, `think:after the tool@${at(12)}`, `text1:Second block@${at(14)}`, `text0:one@${at(24)}`, `text0:twothree@${at(26)}`, `text0:unfinished@${at(32)}`], "each run is one event with the first delta's ts; the file between B's deltas splits the run");

  for (const e of original) {
    const to = seqMap.get(e.seq);
    if (to === undefined) continue;
    const moved = events[to - 1]!;
    assert.equal(moved.kind, e.kind, `seq ${e.seq} maps to its own kind`);
    assert.equal(moved.ts, e.ts, `seq ${e.seq} keeps its ts`);
  }
  const forkOut = events.find((e) => e.kind === "thread.forked.out");
  const startedA = original.find((e) => e.kind === "turn.started")!;
  assert.equal(forkOut?.kind === "thread.forked.out" && forkOut.atTurn, turnIdFor(seqMap.get(startedA.seq)!), "forked.out names the same turn through the mapping");
  const forked = events.find((e) => e.kind === "thread.forked");
  assert.equal(forked?.kind === "thread.forked" && forked.atTurn, "t:44", "the source turn of a fork is never remapped");
});

test("compactEvents on an already compact log returns it unchanged with removed 0", () => {
  const once = compactEvents(busyLog(), 1 as Generation, at(0)).events;
  const again = compactEvents(once, 2 as Generation, at(1));
  assert.equal(again.removed, 0);
  assert.deepEqual(again.events, once);
  assert.deepEqual([...again.seqMap].every(([a, b]) => a === b), true);
});

test("ThreadLog.compact rewrites the file one generation on, the fold and head survive a reopen, and a second compact has nothing to do", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  await log.append({ kind: "thread.created", config: config() });
  await log.append(queued("m1"));
  const start = await log.append((seq) => started(turnIdFor(seq), "m1"));
  const turnId = start.kind === "turn.started" ? start.turnId : ("" as TurnId);
  for (let i = 0; i < 30; i++) await log.append(text(turnId, 0, `w${i} `));
  await log.append({ kind: "tool.started", turnId, toolUseId: "tu" as never, name: "Bash", input: {} });
  for (let i = 0; i < 10; i++) await log.append(thinking(turnId, `t${i}`));
  await log.append({ kind: "turn.ended", turnId, outcome: "ok", sessionId, usage, error: null });
  await log.append(queued("m2", "waiting"));
  const before = await collect(log, 0);
  const headBefore = log.getHead();
  assert.equal(headBefore.generation, 0);
  assert.equal(headBefore.collapsible, 38);

  const r = await log.compact();
  assert.deepEqual(r, { ok: true, removed: 38, generation: 1 });
  const after = await collect(log, 0);
  assert.equal(after.length, before.length - 38 + 1);
  assert.equal(log.getHead().generation, 1);
  assert.equal(log.getHead().collapsible, 0);
  assert.equal(log.getHead().lastSeq, after.length);
  assert.deepEqual(headFields(log.getHead()), headFields(headBefore));
  assert.deepEqual(normalize(groupTurns(after), identity(after)), normalize(groupTurns(before), compactEvents(before, 1 as Generation, "").seqMap));

  const reopened = await ThreadLog.open(threadId, dir);
  assert.equal(reopened.getHead().generation, 1);
  const replayed = await collect(reopened, 0);
  assert.deepEqual(replayed.slice(0, after.length), after);
  assert.equal(replayed[after.length]?.kind, "input.dropped", "open still drops the unstarted input, after the compacted lines");
  const next = await reopened.append(queued("m3"));
  assert.equal(next.seq, after.length + 2);

  assert.deepEqual(await reopened.compact(), { ok: false, reason: "nothing" });
  assert.equal(reopened.getHead().generation, 1);
  await rm(dir, { recursive: true });
});

test("ThreadLog.compact refuses while a viewer is attached and leaves the file byte-identical", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  await log.append({ kind: "thread.created", config: config() });
  await log.append(text("t:1", 0, "a"));
  await log.append(text("t:1", 0, "b"));
  await log.append(ended("t:1"));
  const before = await readFile(join(dir, "events.jsonl"));
  const unsub = log.subscribe("viewer", () => {});
  assert.deepEqual(await log.compact(), { ok: false, reason: "viewer" });
  assert.equal((await readFile(join(dir, "events.jsonl"))).equals(before), true);
  assert.equal(log.getHead().generation, 0);
  unsub();
  assert.equal((await log.compact()).ok, true);
  await rm(dir, { recursive: true });
});

test("a crash before the rename leaves the old log; open deletes the stray temp file and reads generation 0", async () => {
  const dir = await freshDir();
  const original = busyLog();
  await writeLogFile(dir, original);
  const compacted = compactEvents(original, 1 as Generation, at(99)).events;
  await writeFile(join(dir, "events.jsonl.compacting"), compacted.map((e) => JSON.stringify(e) + "\n").join(""));

  const log = await ThreadLog.open(threadId, dir);
  assert.equal(await readFile(join(dir, "events.jsonl.compacting"), "utf8").then(() => true, (e: NodeJS.ErrnoException) => e.code), "ENOENT");
  assert.equal(log.getHead().generation, 0);
  assert.deepEqual((await collect(log, 0)).slice(0, original.length), original);
  await rm(dir, { recursive: true });
});

test("a crash after the rename leaves the new log; open reads generation 1 and folds the same", async () => {
  const dir = await freshDir();
  const original = busyLog();
  const { events, seqMap } = compactEvents(original, 1 as Generation, at(99));
  await writeLogFile(dir, events);

  const log = await ThreadLog.open(threadId, dir);
  assert.equal(log.getHead().generation, 1);
  assert.deepEqual(normalize(groupTurns((await collect(log, 0)).slice(0, events.length)), identity(events)), normalize(groupTurns(original), seqMap));
  assert.deepEqual(headFields(log.getHead()), headFields(await headOf(original)));
  await rm(dir, { recursive: true });
});

test("collapsible counts consecutive same-key deltas, resets on any other event, and is 0 after compaction", async () => {
  const dir = await freshDir();
  const log = await ThreadLog.open(threadId, dir);
  await log.append({ kind: "thread.created", config: config() });
  assert.equal(log.getHead().collapsible, 0);
  await log.append(text("t:1", 0, "a"));
  assert.equal(log.getHead().collapsible, 0, "the first delta of a run is kept");
  await log.append(text("t:1", 0, "b"));
  await log.append(text("t:1", 0, "c"));
  assert.equal(log.getHead().collapsible, 2);
  await log.append(text("t:1", 1, "d"));
  assert.equal(log.getHead().collapsible, 2, "a new block starts a new run");
  await log.append(thinking("t:1", "e"));
  await log.append(thinking("t:1", "f"));
  assert.equal(log.getHead().collapsible, 3);
  await log.append({ kind: "tool.started", turnId: "t:1" as TurnId, toolUseId: "x" as never, name: "Bash", input: {} });
  await log.append(thinking("t:1", "g"));
  assert.equal(log.getHead().collapsible, 3, "a tool between two thinking deltas splits the run");
  await log.append(ended("t:1"));
  assert.equal((await log.compact()).ok, true);
  assert.equal(log.getHead().collapsible, 0);
  await rm(dir, { recursive: true });
});

test("head.recorded flips on note.recorded and survives compaction, so a promoted thread stays promoted", async () => {
  const note = {
    file: { fileId: "n1" as FileId, path: "/v/Atlas/Decisions/backups.md", name: "backups.md", mime: "text/markdown", bytes: 9, note: null },
    rel: "Atlas/Decisions/backups.md",
    summary: "added the 2026-09-13 bullet",
  };
  const before = renumber([...busyLog().map(({ seq: _seq, ...b }) => b), { kind: "note.recorded" as const, note, origin, ts: at(99) }]);
  assert.equal((await headOf(busyLog())).recorded, false, "a log with no note is not recorded");
  assert.equal((await headOf(before)).recorded, true);

  const compacted = compactEvents(before, 1 as Generation, at(100)).events;
  assert.ok(compacted.some((e) => e.kind === "note.recorded"), "compaction keeps the event, since only deltas merge");
  assert.equal((await headOf(compacted)).recorded, true);
});
