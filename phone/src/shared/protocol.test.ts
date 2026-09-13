import { test } from "node:test";
import assert from "node:assert/strict";
import { toolSummary } from "./protocol";

test("every tool in the table names its own argument field and category", () => {
  assert.deepEqual(toolSummary("Bash", { command: "npm test", timeout: 5 }), { label: "Bash", arg: "npm test", category: "run" });
  assert.deepEqual(toolSummary("Read", { file_path: "/etc/hosts", offset: 1 }), { label: "Read", arg: "/etc/hosts", category: "read" });
  assert.deepEqual(toolSummary("Edit", { file_path: "/etc/hosts", old_string: "a" }), { label: "Edit", arg: "/etc/hosts", category: "edit" });
  assert.deepEqual(toolSummary("Write", { file_path: "/etc/hosts", content: "a" }), { label: "Write", arg: "/etc/hosts", category: "edit" });
  assert.deepEqual(toolSummary("MultiEdit", { file_path: "/etc/hosts", edits: [] }), { label: "MultiEdit", arg: "/etc/hosts", category: "edit" });
  assert.deepEqual(toolSummary("NotebookEdit", { notebook_path: "/nb.ipynb" }), { label: "NotebookEdit", arg: "/nb.ipynb", category: "edit" });
  assert.deepEqual(toolSummary("Grep", { pattern: "TODO", path: "/src" }), { label: "Grep", arg: "TODO", category: "read" });
  assert.deepEqual(toolSummary("Glob", { pattern: "**/*.ts" }), { label: "Glob", arg: "**/*.ts", category: "read" });
  assert.deepEqual(toolSummary("LS", { path: "/src" }), { label: "LS", arg: "/src", category: "read" });
  assert.deepEqual(toolSummary("ToolSearch", { query: "select:Read" }), { label: "ToolSearch", arg: "select:Read", category: "read" });
  assert.deepEqual(toolSummary("WebFetch", { url: "https://example.com" }), { label: "WebFetch", arg: "https://example.com", category: "read" });
  assert.deepEqual(toolSummary("WebSearch", { query: "hono sse" }), { label: "WebSearch", arg: "hono sse", category: "read" });
  assert.deepEqual(toolSummary("Agent", { description: "Audit the parser", prompt: "long" }), { label: "Agent", arg: "Audit the parser", category: "other" });
  assert.deepEqual(toolSummary("Skill", { skill: "unslop" }), { label: "Skill", arg: "unslop", category: "other" });
});

test("an unknown tool falls back to the first string field and to nothing at all", () => {
  assert.equal(toolSummary("mcp__thing__do", { count: 3, target: "a thing" }).arg, "a thing");
  assert.equal(toolSummary("Task", { count: 3 }).arg, "");
  assert.equal(toolSummary("Bash", "not a record").arg, "");
  assert.equal(toolSummary("Bash", null).arg, "");
  assert.equal(toolSummary("Bash", { timeout: 5 }).arg, "");
  assert.equal(toolSummary("Task", {}).category, "other");
});

test("a known tool whose named field is missing still falls back to a string field", () => {
  assert.equal(toolSummary("Read", { offset: 1, note: "no path here" }).arg, "no path here");
});

test("the argument is collapsed, home-shortened and cut to 80 chars", () => {
  assert.equal(toolSummary("Bash", { command: "  git   log\n  --oneline " }).arg, "git log --oneline");
  assert.equal(toolSummary("Read", { file_path: "/Users/daniel/Projects/helm2/src/a.ts" }).arg, "~/Projects/helm2/src/a.ts");
  assert.equal(toolSummary("Read", { file_path: "/home/daniel/src/a.ts" }).arg, "~/src/a.ts");
  assert.equal(toolSummary("Bash", { command: "cp /Users/a/x /home/b/y" }).arg, "cp ~/x ~/y");
  assert.equal(toolSummary("Bash", { command: "x".repeat(200) }).arg.length, 80);
});

test("an mcp name reads as server:tool, and an ordinary name is left alone", () => {
  assert.equal(toolSummary("mcp__claude-in-chrome__navigate", {}).label, "claude-in-chrome:navigate");
  assert.equal(toolSummary("mcp__claude_ai_Gmail__send_message", {}).label, "claude_ai_Gmail:send_message");
  assert.equal(toolSummary("Read", {}).label, "Read");
  assert.equal(toolSummary("mcp__lonely", {}).label, "mcp__lonely");
});
