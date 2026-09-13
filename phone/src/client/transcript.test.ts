import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, ThreadEvent, ThreadId, TurnId } from "../shared/protocol";
import { applySync, emptyView, foldAll, type ThreadView } from "./fold";
import { categoryOf, diffLines, jumpCount, summarize, toBlocks, toolDiff, type Block } from "./transcript";

const threadId = "t-1" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
const T = "t:3" as TurnId;

let seq = 0;
let clock = 0;
const at = (s: number): string => new Date(Date.UTC(2026, 8, 11, 10, 0, s)).toISOString();
const ev = (body: object): ThreadEvent => ({ seq: ++seq as Seq, ts: at(clock++), ...body }) as ThreadEvent;

const started = (turnId: TurnId = T): ThreadEvent[] => {
  seq = 0;
  clock = 0;
  return [
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [], origin }),
    ev({ kind: "turn.started", turnId, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
  ];
};

const tool = (name: string, input: unknown = {}): ThreadEvent[] => {
  const id = `tu${seq + 1}`;
  return [ev({ kind: "tool.started", turnId: T, toolUseId: id as never, name, input }), ev({ kind: "tool.finished", turnId: T, toolUseId: id as never, output: "ok", isError: false })];
};

const ended = (outcome = "ok", durationMs = 42_000, error: string | null = null): ThreadEvent =>
  ev({
    kind: "turn.ended",
    turnId: T,
    outcome,
    sessionId: "s" as never,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.1, contextTokens: 4, contextWindow: 200_000, durationMs },
    error,
  });

/** Fold the events, then mark the stream live with the turn left open or closed. */
function build(events: ThreadEvent[], openTurn: TurnId | null): ThreadView {
  const view = foldAll(emptyView(threadId), events);
  return applySync(view, { headSeq: view.headSeq, session: openTurn ? "running" : "idle", openTurn, queuedCount: 0 });
}

const kinds = (blocks: readonly Block[]): string[] => blocks.map((b) => b.kind);
const activity = (blocks: readonly Block[]): Extract<Block, { kind: "activity" }>[] => blocks.filter((b): b is Extract<Block, { kind: "activity" }> => b.kind === "activity");

test("consecutive tool lines of one turn coalesce into one activity block", () => {
  const blocks = toBlocks(build([...started(), ...tool("Read"), ...tool("Bash"), ...tool("Edit"), ended()], null));
  assert.deepEqual(kinds(blocks), ["prompt", "activity"]);
  const [act] = activity(blocks);
  assert.equal(act!.tools.length, 3);
  assert.deepEqual(act!.counts, { read: 1, run: 1, edit: 1, other: 0 });
  assert.equal(summarize(act!.counts), "read 1 file, ran 1 command, edited 1 file");
});

test("a text block between two tools splits the activity in two", () => {
  const events = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash"), ended()];
  const blocks = toBlocks(build(events, null));
  assert.deepEqual(kinds(blocks), ["prompt", "activity", "text", "activity"]);
  const acts = activity(blocks);
  assert.notEqual(acts[0]!.key, acts[1]!.key);
});

test("only the turn's last activity block is running; an earlier one closed off by text stops its clock", () => {
  const events = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash")];
  const acts = activity(toBlocks(build(events, T)));
  assert.equal(acts[0]!.running, false);
  assert.equal(acts[0]!.durationMs, 1000);
  assert.equal(acts[1]!.running, true);
  assert.equal(acts[1]!.durationMs, null);
});

test("current is the last unfinished tool while the turn is open and null once it ends", () => {
  const open = [...started(), ...tool("Read"), ev({ kind: "tool.started", turnId: T, toolUseId: "tu9" as never, name: "Bash", input: { command: "npm test" } })];
  const live = activity(toBlocks(build(open, T)))[0]!;
  assert.equal(live.running, true);
  assert.equal(live.current?.name, "Bash");
  assert.equal(live.durationMs, null);

  const done = activity(toBlocks(build(open, null)))[0]!;
  assert.equal(done.running, false);
  assert.equal(done.current, null);
});

test("a lone activity block reports the turn's own duration; several time themselves from their stamps", () => {
  const one = activity(toBlocks(build([...started(), ...tool("Read"), ended("ok", 42_000)], null)))[0]!;
  assert.equal(one.durationMs, 42_000);

  const split = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash"), ended("ok", 42_000)];
  const acts = activity(toBlocks(build(split, null)));
  assert.equal(acts.length, 2);
  assert.equal(acts[0]!.durationMs, 1000, "one second between its own start and end stamps");
  assert.equal(acts[1]!.durationMs, 1000);
});

test("thinking collapses once the turn speaks or ends, and streams only as the last open line", () => {
  const thinkOnly = [...started(), ev({ kind: "assistant.thinking", turnId: T, delta: "hm" })];
  const live = toBlocks(build(thinkOnly, T)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([live.collapsed, live.streaming], [false, true]);

  const spoke = [...thinkOnly, ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "Hello" })];
  const afterText = toBlocks(build(spoke, T)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([afterText.collapsed, afterText.streaming], [true, false]);

  const closed = toBlocks(build(thinkOnly, null)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([closed.collapsed, closed.streaming], [true, false]);
});

test("text streams only as the last line of an open turn", () => {
  const events = [...started(), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "one" }), ev({ kind: "assistant.text", turnId: T, blockIx: 1, delta: "two" })];
  const live = toBlocks(build(events, T)).filter((b) => b.kind === "text");
  assert.deepEqual(live.map((b) => b.streaming), [false, true]);
  assert.deepEqual(toBlocks(build(events, null)).filter((b) => b.kind === "text").map((b) => b.streaming), [false, false]);
});

test("an ok end leaves no block; interrupted, error and orphaned each leave one", () => {
  assert.deepEqual(kinds(toBlocks(build([...started(), ended("ok")], null))), ["prompt"]);
  for (const outcome of ["interrupted", "error", "orphaned"] as const) {
    const blocks = toBlocks(build([...started(), ended(outcome, 1, "the SDK closed the stream")], null));
    assert.deepEqual(kinds(blocks), ["prompt", "end"]);
    const end = blocks[1]!;
    assert.equal(end.kind === "end" && end.outcome, outcome);
  }
});

test("summarize omits empty categories, keeps singulars, and names an empty block", () => {
  assert.equal(summarize({ read: 6, run: 2, edit: 3, other: 1 }), "read 6 files, ran 2 commands, edited 3 files, 1 other");
  assert.equal(summarize({ read: 1, run: 0, edit: 0, other: 0 }), "read 1 file");
  assert.equal(summarize({ read: 0, run: 0, edit: 0, other: 0 }), "working");
});

test("tool names fall back to other, mcp tools included", () => {
  assert.equal(categoryOf("Read"), "read");
  assert.equal(categoryOf("Bash"), "run");
  assert.equal(categoryOf("NotebookEdit"), "edit");
  assert.equal(categoryOf("mcp__claude-in-chrome__navigate"), "other");
  assert.equal(categoryOf("Task"), "other");
});

test("diffLines keeps common lines and marks removals before the additions that replace them", () => {
  const d = diffLines("a\nb\nc", "a\nx\ny\nc");
  assert.deepEqual(d.map((l) => `${l.op}${l.text}`), [" a", "-b", "+x", "+y", " c"]);
  assert.deepEqual(diffLines("same", "same").map((l) => l.op), [" "]);
});

test("toolDiff reads an Edit as a diff, a Write as all additions, and anything else as nothing", () => {
  const line = (name: string, input: unknown): Parameters<typeof toolDiff>[0] => ({ kind: "tool", turnId: T, toolUseId: "x", name, input, output: null, isError: null, startedAt: at(0), endedAt: null });
  const edit = toolDiff(line("Edit", { file_path: "/v/a.ts", old_string: "one\ntwo", new_string: "one\nthree" }));
  assert.equal(edit?.file, "/v/a.ts");
  assert.deepEqual(edit?.lines.map((l) => `${l.op}${l.text}`), [" one", "-two", "+three"]);

  const write = toolDiff(line("Write", { file_path: "/v/b.ts", content: "x\ny" }));
  assert.deepEqual(write?.lines.map((l) => `${l.op}${l.text}`), ["+x", "+y"]);

  assert.equal(toolDiff(line("MultiEdit", { file_path: "/v/c.ts", edits: [] })), null);
  assert.equal(toolDiff(line("Bash", { command: "ls" })), null);
});

test("jumpCount counts blocks past what the reader has seen and never goes negative", () => {
  const blocks = toBlocks(build([...started(), ...tool("Read"), ended()], null));
  assert.equal(blocks.length, 2);
  assert.equal(jumpCount(blocks, 0), 2);
  assert.equal(jumpCount(blocks, 1), 1);
  assert.equal(jumpCount(blocks, 5), 0);
});

test("config changes and the archive marker survive as note blocks", () => {
  seq = 0;
  clock = 0;
  const view = build([ev({ kind: "thread.config", patch: { model: "claude-opus-5" as never }, origin }), ev({ kind: "thread.archived" })], null);
  assert.deepEqual(kinds(toBlocks(view)), ["note", "note"]);
});

test("a file line is its own block and does not split or join the activity around it", () => {
  const file = { fileId: "f1", path: "/x/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 10, note: null };
  const evs = [...started(), ...tool("Bash"), ev({ kind: "file.offered", file, origin: { via: "key", label: "model" } }), ...tool("Read"), ended()];
  const blocks = toBlocks(build(evs, null));
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["prompt", "activity", "file", "activity"],
  );
  const f = blocks[2];
  assert.ok(f?.kind === "file" && f.line.fileId === "f1" && f.line.name === "report.pdf");
});
