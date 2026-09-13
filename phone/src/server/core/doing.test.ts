import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolUseId, TurnId } from "../../shared/protocol";
import { doingNow } from "./doing";
import type { ThreadHead } from "./log";

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

test("doingNow names an mcp tool the way the transcript does", () => {
  assert.deepEqual(doingNow(head({ activeTool: tool("mcp__claude-in-chrome__navigate", { url: "https://x" }) }), "running"), { kind: "tool", name: "claude-in-chrome:navigate", arg: "https://x" });
});

test("doingNow prefers a live tool, falls back to the text tail, and reports nothing when there is nothing", () => {
  const t = "t:4" as TurnId;
  assert.deepEqual(doingNow(head({ activeTool: tool("Bash", { command: "npm test" }), lastText: { turnId: t, text: "hi" } }), "running"), {
    kind: "tool",
    name: "Bash",
    arg: "npm test",
  });
  assert.deepEqual(doingNow(head({ lastText: { turnId: t, text: "  Done.  " } }), "running"), { kind: "text", tail: "Done." });
  assert.deepEqual(doingNow(head({ lastText: { turnId: t, text: "  " } }), "idle"), null);
  assert.deepEqual(doingNow(head({}), "cold"), null);
});

test("doingNow ignores a tool the session can no longer be running, and keeps the tail to the last 120 chars", () => {
  const t = "t:4" as TurnId;
  const stale = head({ activeTool: tool("Bash", { command: "npm test" }), lastText: { turnId: t, text: "earlier" } });
  assert.deepEqual(doingNow(stale, "parked"), { kind: "text", tail: "earlier" }, "a parked process is not running a tool");

  const long = head({ lastText: { turnId: t, text: `${"a".repeat(200)}THE END` } });
  const d = doingNow(long, "idle");
  assert.equal(d?.kind, "text");
  assert.equal(d.kind === "text" && d.tail.length, 120);
  assert.equal(d.kind === "text" && d.tail.endsWith("THE END"), true, "the tail is the end of the text, not the start");
});
