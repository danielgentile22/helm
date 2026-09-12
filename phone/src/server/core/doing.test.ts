import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import type { ToolUseId, TurnId } from "../../shared/protocol";
import { doingNow, toolArg } from "./doing";
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

test("toolArg picks the identifying field per tool", () => {
  assert.equal(toolArg("Bash", { command: "npm test", timeout: 5 }), "npm test");
  assert.equal(toolArg("Read", { file_path: "/etc/hosts", offset: 1 }), "/etc/hosts");
  assert.equal(toolArg("Grep", { pattern: "TODO", path: "/src" }), "TODO");
  assert.equal(toolArg("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(toolArg("Agent", { description: "Audit the parser", prompt: "long" }), "Audit the parser");
  assert.equal(toolArg("WebFetch", { url: "https://example.com" }), "https://example.com");
  assert.equal(toolArg("WebSearch", { query: "hono sse" }), "hono sse");
  assert.equal(toolArg("Skill", { skill: "unslop" }), "unslop");
});

test("toolArg falls back to the first string field, tidies the value, and gives up gracefully", () => {
  assert.equal(toolArg("mcp__thing__do", { count: 3, target: "a thing" }), "a thing");
  assert.equal(toolArg("Bash", { command: "  git   log\n  --oneline " }), "git log --oneline");
  assert.equal(toolArg("Read", { file_path: `${homedir()}/Projects/helm2/src/a.ts` }), "~/Projects/helm2/src/a.ts");
  assert.equal(toolArg("Bash", { command: "x".repeat(200) }).length, 80);
  assert.equal(toolArg("Bash", { timeout: 5 }), "");
  assert.equal(toolArg("Bash", "not a record"), "");
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
