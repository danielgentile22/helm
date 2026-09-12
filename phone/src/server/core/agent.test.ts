import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS } from "../../shared/protocol";
import type { ModelId, TurnId, UploadId } from "../../shared/protocol";
import { agentMessageToEvents, buildUserMessage, modelCatalog, parseModelId, toSlashCommands, truncateJson, truncateText, SdkAgentFactory, PHONE_APPENDIX } from "./agent";
import { FakeAgentFactory } from "./agent.fake";

const t = "t:7" as TurnId;

test("system init maps to session.bound", () => {
  const evs = agentMessageToEvents(t, { type: "system", subtype: "init", session_id: "abc", uuid: "u", model: "m" });
  assert.deepEqual(evs, [{ kind: "session.bound", sessionId: "abc" }]);
  assert.deepEqual(agentMessageToEvents(t, { type: "system", subtype: "status", session_id: "abc" }), []);
});

test("stream deltas map to text and thinking with the block index", () => {
  const text = agentMessageToEvents(t, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "hi" } } });
  assert.deepEqual(text, [{ kind: "assistant.text", turnId: t, blockIx: 2, delta: "hi" }]);
  const think = agentMessageToEvents(t, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } });
  assert.deepEqual(think, [{ kind: "assistant.thinking", turnId: t, delta: "hmm" }]);
  assert.deepEqual(agentMessageToEvents(t, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0 } }), []);
});

test("subagent frames (parent_tool_use_id set) are ignored", () => {
  const evs = agentMessageToEvents(t, { type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
  assert.deepEqual(evs, []);
});

test("assistant tool_use blocks map to tool.started with truncated input", () => {
  const big = "x".repeat(LIMITS.TOOL_INPUT_MAX + 100);
  const evs = agentMessageToEvents(t, {
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "ignored here" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } }, { type: "tool_use", id: "toolu_2", name: "Bash", input: { cmd: big } }] },
  });
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { kind: "tool.started", turnId: t, toolUseId: "toolu_1", name: "Read", input: { path: "/a" } });
  const second = evs[1]!;
  assert.equal(second.kind, "tool.started");
  if (second.kind === "tool.started") {
    const inp = second.input as { truncated: boolean; bytes: number; head: string };
    assert.equal(inp.truncated, true);
    assert.ok(inp.bytes > LIMITS.TOOL_INPUT_MAX);
    assert.equal(inp.head.length, LIMITS.TOOL_INPUT_MAX);
  }
});

test("user tool_result blocks map to tool.finished, string or block content, with error flag and truncation", () => {
  const big = "y".repeat(LIMITS.TOOL_OUTPUT_MAX + 10);
  const evs = agentMessageToEvents(t, {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
        { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }], is_error: true },
        { type: "tool_result", tool_use_id: "toolu_3", content: big },
      ],
    },
  });
  assert.deepEqual(evs[0], { kind: "tool.finished", turnId: t, toolUseId: "toolu_1", output: "ok", isError: false });
  assert.deepEqual(evs[1], { kind: "tool.finished", turnId: t, toolUseId: "toolu_2", output: "a\n[image]\nb", isError: true });
  const third = evs[2]!;
  if (third.kind === "tool.finished") {
    assert.ok(third.output.endsWith(`[truncated, ${LIMITS.TOOL_OUTPUT_MAX + 10} bytes]`));
  }
});

test("result maps to turn.ended with per-turn cost and context size", () => {
  const msg = {
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    duration_ms: 1234,
    total_cost_usd: 0.5,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 },
    result: "done",
  };
  const [ev] = agentMessageToEvents(t, msg, { interrupted: false, prevCostUsd: 0.2 });
  assert.deepEqual(ev, {
    kind: "turn.ended",
    turnId: t,
    outcome: "ok",
    sessionId: "s1",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, cacheWriteTokens: 300, costUsd: 0.3, contextTokens: 4400, durationMs: 1234 },
    error: null,
  });
  const [interrupted] = agentMessageToEvents(t, msg, { interrupted: true, prevCostUsd: 0 });
  assert.equal(interrupted?.kind === "turn.ended" && interrupted.outcome, "interrupted");
});

test("error result maps to turn.ended {error} with scrubbed message", () => {
  const [ev] = agentMessageToEvents(t, {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    session_id: "s1",
    errors: ["boom at /Users/danielgentile/x\n    at fn (file.js:1:1)"],
    usage: {},
  });
  assert.equal(ev?.kind, "turn.ended");
  if (ev?.kind === "turn.ended") {
    assert.equal(ev.outcome, "error");
    assert.equal(ev.error, "boom at ~/x");
  }
});

test("garbage and unknown message types map to nothing", () => {
  assert.deepEqual(agentMessageToEvents(t, null), []);
  assert.deepEqual(agentMessageToEvents(t, "str"), []);
  assert.deepEqual(agentMessageToEvents(t, { type: "task_notification" }), []);
});

test("truncate helpers respect byte limits", () => {
  assert.equal(truncateText("abc", 10), "abc");
  assert.ok(truncateText("héllo wörld", 5).startsWith("héll"));
  assert.deepEqual(truncateJson({ a: 1 }, 100), { a: 1 });
});

test("buildUserMessage lists uploads by absolute path and returns image paths", () => {
  const { text, imagePaths } = buildUserMessage({
    turnId: t,
    text: "look",
    uploads: [
      { uploadId: "u1" as UploadId, path: "/x/a.png", name: "a.png", mime: "image/png", bytes: 10 },
      { uploadId: "u2" as UploadId, path: "/x/b.pdf", name: "b.pdf", mime: "application/pdf", bytes: 20 },
    ],
  });
  assert.equal(text, "look\n\nAttached files (absolute paths on this Mac):\n- /x/a.png (image/png, 10 B)\n- /x/b.pdf (application/pdf, 20 B)");
  assert.deepEqual(imagePaths, ["/x/a.png"]);
  assert.equal(buildUserMessage({ turnId: t, text: "plain", uploads: [] }).text, "plain");
});

test("modelCatalog drops Haiku and the opaque default alias, and passes through every effort level the SDK reports; parseModelId validates against it", async () => {
  const factory = new FakeAgentFactory();
  const catalog = await modelCatalog(factory);
  assert.deepEqual(catalog, [
    { id: "claude-opus-5", label: "Opus 5", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh"] },
  ]);
  assert.equal(parseModelId("claude-opus-5", catalog), "claude-opus-5");
  assert.equal(parseModelId("claude-haiku-4-5-20251001", catalog), null);
  assert.equal(parseModelId(42, catalog), null);
});

test("real SDK: spawn, one short turn, interrupt a long one, kill-tree", { skip: !process.env.HELM_SDK_TEST && "set HELM_SDK_TEST=1 (spends money, needs a login)" }, async () => {
  const factory = new SdkAgentFactory({ env: process.env });
  const catalog = await modelCatalog(factory);
  assert.ok(catalog.length > 0, "catalog is empty");
  const model = catalog.find((c) => /sonnet/.test(c.id))?.id ?? catalog[0]!.id;

  const session = await factory.spawn({ cwd: process.cwd(), model, effort: "low", resume: null, additionalDirectories: [], appendSystemPrompt: PHONE_APPENDIX });
  const seen: string[] = [];
  const reader = (async () => {
    for await (const ev of session.events()) {
      seen.push(ev.kind === "turn.ended" ? `${ev.kind}:${ev.outcome}` : ev.kind);
      if (ev.kind === "turn.ended" && ev.outcome === "interrupted") break;
    }
  })();

  await session.send({ turnId: "t:1" as TurnId, text: "Reply with the single word: pong", uploads: [] });
  assert.ok(seen.includes("session.bound"));
  assert.ok(seen.includes("assistant.text"));
  assert.equal(seen.at(-1), "turn.ended:ok");
  assert.ok(session.sessionId);

  const second = session.send({ turnId: "t:2" as TurnId, text: "Count slowly from 1 to 200, one number per line, using a Bash sleep 1 between each.", uploads: [] });
  await new Promise((r) => setTimeout(r, 4000));
  await session.interrupt();
  await second;
  await reader;
  assert.equal(seen.at(-1), "turn.ended:interrupted");

  const pid = session.pid!;
  await session.kill();
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "claude process still alive after kill");
});

test("catalog model id type is branded at the boundary only", () => {
  const id: ModelId = "claude-opus-5" as ModelId;
  assert.equal(typeof id, "string");
});

test("toSlashCommands parses the SDK list, drops terminal entries, and defaults missing strings", () => {
  const raw = [
    { name: "commit", description: "Commit staged work", argumentHint: "" },
    { name: "exit", description: "Leave", argumentHint: "" },
    { name: "grill", aliases: ["g"] },
    { name: "", description: "nameless" },
    "not an object",
  ];
  assert.deepEqual(toSlashCommands(raw, new Set(["exit"])), [
    { name: "commit", description: "Commit staged work", argumentHint: "" },
    { name: "grill", description: "", argumentHint: "" },
  ]);
  assert.deepEqual(toSlashCommands(null, new Set()), []);
  assert.deepEqual(toSlashCommands([{ name: "a" }], new Set(["a"])), []);
});
