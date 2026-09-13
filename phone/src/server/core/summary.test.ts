import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelId, ThreadConfig, ThreadId, ToolUseId, TurnId } from "../../shared/protocol";
import { threadSummary } from "./summary";
import type { ThreadHead } from "./log";

const config: ThreadConfig = {
  threadId: "th-1" as ThreadId,
  cwd: "/tmp",
  model: "claude-opus-5" as ModelId,
  effort: "high",
  title: null,
  createdAt: "2026-09-11T00:00:00.000Z",
  archivedAt: null,
};

const head = (over: Partial<ThreadHead>): ThreadHead => ({
  lastSeq: 0,
  sessionId: null,
  openTurn: null,
  queued: [],
  recentClientMsgIds: new Map(),
  lastTurnEndedAt: null,
  lastOutcome: null,
  contextTokens: null,
  activeTool: null,
  lastText: null,
  usageTotal: null,
  contextWindow: null,
  ...over,
});

const tool = (name: string, input: unknown): ThreadHead["activeTool"] => ({ toolUseId: "tu-1" as ToolUseId, name, input });

const doing = (over: Partial<ThreadHead>, session: Parameters<typeof threadSummary>[2]) => threadSummary(head(over), config, session).doing;

test("doing names an mcp tool the way the transcript does", () => {
  assert.deepEqual(doing({ activeTool: tool("mcp__claude-in-chrome__navigate", { url: "https://x" }) }, "running"), { kind: "tool", name: "claude-in-chrome:navigate", arg: "https://x" });
});

test("doing prefers a live tool, falls back to the text tail, and reports nothing when there is nothing", () => {
  const t = "t:4" as TurnId;
  assert.deepEqual(doing({ activeTool: tool("Bash", { command: "npm test" }), lastText: { turnId: t, text: "hi" } }, "running"), {
    kind: "tool",
    name: "Bash",
    arg: "npm test",
  });
  assert.deepEqual(doing({ lastText: { turnId: t, text: "  Done.  " } }, "running"), { kind: "text", tail: "Done." });
  assert.deepEqual(doing({ lastText: { turnId: t, text: "  " } }, "idle"), null);
  assert.deepEqual(doing({}, "cold"), null);
});

test("doing ignores a tool the session can no longer be running, and keeps the tail to the last 120 chars", () => {
  const t = "t:4" as TurnId;
  assert.deepEqual(doing({ activeTool: tool("Bash", { command: "npm test" }), lastText: { turnId: t, text: "earlier" } }, "parked"), { kind: "text", tail: "earlier" }, "a parked process is not running a tool");

  const d = doing({ lastText: { turnId: t, text: `${"a".repeat(200)}THE END` } }, "idle");
  assert.equal(d?.kind, "text");
  assert.equal(d.kind === "text" && d.tail.length, 120);
  assert.equal(d.kind === "text" && d.tail.endsWith("THE END"), true, "the tail is the end of the text, not the start");
});

test("a turn that produced no text keeps the previous turn's text", () => {
  const s = threadSummary(
    head({
      lastText: { turnId: "t:1" as TurnId, text: "Earlier answer" },
      lastTurnEndedAt: "2026-09-12T00:00:00.000Z",
      lastOutcome: "ok",
    }),
    config,
    "idle",
  );
  assert.equal(s.preview, "Earlier answer");
  assert.deepEqual(s.doing, { kind: "text", tail: "Earlier answer" });
});

test("preview keeps the first 120 chars and the tail keeps the last 120 of the same text", () => {
  const text = `START${"a".repeat(200)}END`;
  const s = threadSummary(head({ lastText: { turnId: "t:1" as TurnId, text } }), config, "idle");
  assert.equal(s.preview?.length, 120);
  assert.equal(s.preview?.startsWith("START"), true);
  assert.equal(s.doing?.kind === "text" && s.doing.tail.length, 120);
  assert.equal(s.doing?.kind === "text" && s.doing.tail.endsWith("END"), true);
});
