import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS } from "../../shared/protocol";
import type { ModelId, TurnId, UploadId } from "../../shared/protocol";
import { Pushable } from "../util/pushable";
import { buildUserMessage, modelCatalog, parseModelId, toSlashCommands, SdkAgentFactory, PHONE_APPENDIX } from "./agent";
import type { AgentEvent, QueryFn, SdkDeps, SdkQuery, SpawnOptions } from "./agent";
import { FakeAgentFactory } from "./agent.fake";

const t = "t:7" as TurnId;
const frame = (m: unknown): SDKMessage => m as SDKMessage;
const init = frame({ type: "system", subtype: "init", session_id: "abc", uuid: "u", model: "m", terminal_slash_commands: ["exit"] });
const result = (extra: Record<string, unknown> = {}): SDKMessage =>
  frame({ type: "result", subtype: "success", is_error: false, session_id: "s1", duration_ms: 1234, total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 }, result: "done", ...extra });
const textDelta = (text: string, index = 0): SDKMessage => frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });

const spawnOpts: SpawnOptions = { cwd: "/tmp", model: "claude-opus-5" as ModelId, effort: "low", resume: null, additionalDirectories: [], appendSystemPrompt: PHONE_APPENDIX, sendToPhone: () => Promise.reject(new Error("not in this test")) };

/**
 * A recorded stand-in for the SDK: the test pushes frames, the session reads
 * them through the same SdkQuery surface the real query() returns. Process
 * handling is recorded rather than done, so kill() never signals a real pid.
 */
function recorded() {
  const frames = new Pushable<SDKMessage>();
  const calls: string[] = [];
  const inputs: SDKUserMessage[] = [];
  const q: SdkQuery = {
    [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
    interrupt: async () => {
      calls.push("interrupt");
      frames.push(result({ subtype: "error_during_execution", is_error: true, errors: ["interrupted"] }));
      return undefined;
    },
    setModel: async (m) => void calls.push(`setModel:${m}`),
    applyFlagSettings: async (s) => void calls.push(`effort:${s.effortLevel}`),
    supportedCommands: async () => [{ name: "commit", description: "Commit", argumentHint: "" }, { name: "exit", description: "Leave", argumentHint: "" }] as never,
    supportedModels: async () => [{ value: "claude-opus-5", displayName: "Opus 5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] }] as never,
    reloadSkills: async () => ({ skills: [{ name: "fresh", description: "", argumentHint: "" }] }) as never,
    close: () => {
      calls.push("close");
      frames.end();
    },
  };
  const deps: SdkDeps = {
    env: {},
    query: ({ prompt, options }) => {
      options.abortController?.signal.addEventListener("abort", () => {
        calls.push("abort");
        frames.end();
      });
      options.spawnClaudeCodeProcess?.({ command: "claude", args: [], cwd: "/tmp", env: {}, signal: options.abortController!.signal } as never);
      void (async () => {
        for await (const m of prompt) inputs.push(m);
      })();
      return q;
    },
    spawn: (() => ({ pid: 4242, stderr: null })) as unknown as SdkDeps["spawn"],
    killTree: async (pid) => void calls.push(`killTree:${pid}`),
  };
  return { frames, calls, inputs, deps };
}

async function liveSession() {
  const r = recorded();
  const session = await new SdkAgentFactory(r.deps).spawn(spawnOpts);
  const seen: AgentEvent[] = [];
  const drained = (async () => {
    for await (const ev of session.events()) seen.push(ev);
  })();
  r.frames.push(init);
  await tick();
  return { ...r, session, seen, drained };
}

/** Push frames under one turn, end it with a result, and return the events that turn produced. */
async function turn(frames: readonly SDKMessage[], end: SDKMessage = result()): Promise<readonly AgentEvent[]> {
  const s = await liveSession();
  const before = s.seen.length;
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await tick();
  for (const f of [...frames, end]) s.frames.push(f);
  await done;
  await tick();
  return s.seen.slice(before);
}

test("system init binds the session before any turn; stray frames with no turn in flight are dropped", async () => {
  const s = await liveSession();
  assert.equal(s.session.sessionId, "abc");
  assert.deepEqual(s.seen, [{ kind: "session.bound", sessionId: "abc" }]);
  s.frames.push(textDelta("stray"));
  s.frames.push(result());
  await tick();
  assert.deepEqual(s.seen, [{ kind: "session.bound", sessionId: "abc" }]);
  assert.deepEqual(await turn([textDelta("hi", 2)]), [{ kind: "assistant.text", turnId: t, blockIx: 2, delta: "hi" }, { kind: "turn.ended", turnId: t, outcome: "ok", sessionId: "s1", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, cacheWriteTokens: 300, costUsd: 0.5, contextTokens: 4400, durationMs: 1234 }, error: null }]);
});

test("a turn settles exactly once even when the stream carries two results", async () => {
  const s = await liveSession();
  let settled = 0;
  const done = s.session.send({ turnId: t, text: "go", uploads: [] }).then(() => settled++);
  await tick();
  s.frames.push(result());
  s.frames.push(result());
  await done;
  await tick();
  assert.equal(settled, 1);
  assert.deepEqual(s.seen.filter((e) => e.kind === "turn.ended").length, 1);
});

test("the user turn reaches the SDK as a text block and cost is reported per turn", async () => {
  const s = await liveSession();
  const first = s.session.send({ turnId: t, text: "first", uploads: [] });
  await tick();
  s.frames.push(result({ total_cost_usd: 0.2 }));
  await first;
  const second = s.session.send({ turnId: "t:8" as TurnId, text: "second", uploads: [] });
  await tick();
  s.frames.push(result({ total_cost_usd: 0.5 }));
  await second;
  await tick();
  assert.deepEqual(s.inputs.map((m) => m.message.content), [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]);
  const costs = s.seen.flatMap((e) => (e.kind === "turn.ended" ? [e.usage?.costUsd] : []));
  assert.deepEqual(costs, [0.2, 0.3]);
});

test("interrupt resolves the pending send as interrupted and is a no-op with nothing in flight", async () => {
  const s = await liveSession();
  await s.session.interrupt();
  assert.deepEqual(s.calls, []);
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await tick();
  await s.session.interrupt();
  await done;
  await tick();
  assert.deepEqual(s.calls, ["interrupt"]);
  const ended = s.seen.at(-1);
  assert.equal(ended?.kind === "turn.ended" && ended.outcome, "interrupted");
  assert.equal(ended?.kind === "turn.ended" && ended.error, null);
});

test("kill aborts, then kills the process group, then closes the query, and fails the pending turn", async () => {
  const s = await liveSession();
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await tick();
  assert.equal(s.session.pid, 4242);
  await s.session.kill();
  await s.session.kill();
  await done;
  await s.drained;
  assert.deepEqual(s.calls, ["abort", "killTree:4242", "close"]);
  assert.equal(s.session.alive, false);
  const ended = s.seen.at(-1);
  assert.equal(ended?.kind === "turn.ended" && ended.outcome, "error");
  assert.equal(ended?.kind === "turn.ended" && ended.error, "Claude Code session exited");
  await assert.rejects(s.session.send({ turnId: t, text: "late", uploads: [] }), /dead/);
  assert.deepEqual(await s.session.commands(), []);
});

test("commands hide the entries init tagged as terminal-only; reloadSkills returns the fresh list; model and effort go to the query", async () => {
  const s = await liveSession();
  assert.deepEqual(await s.session.commands(), [{ name: "commit", description: "Commit", argumentHint: "" }]);
  assert.deepEqual(await s.session.reloadSkills(), [{ name: "fresh", description: "", argumentHint: "" }]);
  await s.session.setModel("claude-sonnet-5" as ModelId);
  await s.session.setEffort("high");
  assert.deepEqual(s.calls, ["setModel:claude-sonnet-5", "effort:high"]);
});

test("the factory probes the catalog and cold command menu through a throwaway query and closes it", async () => {
  const r = recorded();
  const factory = new SdkAgentFactory(r.deps);
  assert.deepEqual(await factory.models(), [{ id: "claude-opus-5", label: "Opus 5", supportsEffort: true, efforts: ["low", "high"] }]);
  assert.deepEqual(await factory.commands("/tmp"), [{ name: "commit", description: "Commit", argumentHint: "" }, { name: "exit", description: "Leave", argumentHint: "" }]);
  assert.deepEqual(r.calls, ["close", "close"]);
});

test("stream deltas map to text and thinking with the block index", async () => {
  const evs = await turn([textDelta("hi", 2), frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }), frame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0 } })]);
  assert.deepEqual(evs.slice(0, -1), [
    { kind: "assistant.text", turnId: t, blockIx: 2, delta: "hi" },
    { kind: "assistant.thinking", turnId: t, delta: "hmm" },
  ]);
});

test("subagent frames (parent_tool_use_id set) are ignored", async () => {
  const evs = await turn([frame({ type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "turn.ended");
});

test("assistant tool_use blocks map to tool.started with truncated input", async () => {
  const big = "x".repeat(LIMITS.TOOL_INPUT_MAX + 100);
  const evs = await turn([
    frame({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "ignored here" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } }, { type: "tool_use", id: "toolu_2", name: "Bash", input: { cmd: big } }] },
    }),
  ]);
  assert.equal(evs.length, 3);
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

test("user tool_result blocks map to tool.finished, string or block content, with error flag and byte truncation", async () => {
  const big = "y".repeat(LIMITS.TOOL_OUTPUT_MAX + 10);
  const evs = await turn([
    frame({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
          { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }], is_error: true },
          { type: "tool_result", tool_use_id: "toolu_3", content: big },
          { type: "tool_result", tool_use_id: "toolu_4", content: "héllo wörld".repeat(LIMITS.TOOL_OUTPUT_MAX) },
        ],
      },
    }),
  ]);
  assert.deepEqual(evs[0], { kind: "tool.finished", turnId: t, toolUseId: "toolu_1", output: "ok", isError: false });
  assert.deepEqual(evs[1], { kind: "tool.finished", turnId: t, toolUseId: "toolu_2", output: "a\n[image]\nb", isError: true });
  const third = evs[2]!;
  if (third.kind === "tool.finished") {
    assert.ok(third.output.endsWith(`[truncated, ${LIMITS.TOOL_OUTPUT_MAX + 10} bytes]`));
  }
  const fourth = evs[3]!;
  if (fourth.kind === "tool.finished") {
    assert.ok(Buffer.byteLength(fourth.output.split("\n... [truncated")[0]!) <= LIMITS.TOOL_OUTPUT_MAX, "cut at a byte limit, not a character count");
  }
});

test("error result maps to turn.ended {error} with scrubbed message", async () => {
  const [ev] = await turn([], result({ subtype: "error_during_execution", is_error: true, errors: ["boom at /Users/danielgentile/x\n    at fn (file.js:1:1)"], usage: {} }));
  assert.equal(ev?.kind, "turn.ended");
  if (ev?.kind === "turn.ended") {
    assert.equal(ev.outcome, "error");
    assert.equal(ev.error, "boom at ~/x");
  }
});

test("unknown message types produce nothing", async () => {
  const evs = await turn([frame({ type: "task_notification" }), frame({ type: "system", subtype: "status", session_id: "abc" })]);
  assert.equal(evs.length, 1);
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
  const factory = new SdkAgentFactory({ query, env: process.env });
  const catalog = await modelCatalog(factory);
  assert.ok(catalog.length > 0, "catalog is empty");
  const model = catalog.find((c) => /sonnet/.test(c.id))?.id ?? catalog[0]!.id;

  const session = await factory.spawn({ cwd: process.cwd(), model, effort: "low", resume: null, additionalDirectories: [], appendSystemPrompt: PHONE_APPENDIX, sendToPhone: () => Promise.reject(new Error("not in this test")) });
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

test("usage carries the context window of the model that did the most of the turn", async () => {
  const ended = async (modelUsage: unknown) => (await turn([], result({ modelUsage }))).at(-1);

  const busiest = await ended({
    "claude-haiku-4-5": { inputTokens: 10, cacheReadInputTokens: 5, contextWindow: 100_000 },
    "claude-opus-5": { inputTokens: 100, cacheReadInputTokens: 4000, contextWindow: 1_000_000 },
  });
  assert.equal(busiest?.kind === "turn.ended" && busiest.usage?.contextWindow, 1_000_000);

  const zero = await ended({ m: { inputTokens: 5, contextWindow: 0 } });
  assert.equal(zero?.kind === "turn.ended" && "contextWindow" in (zero.usage ?? {}), false, "a zero window is not a window");
  const none = await ended(undefined);
  assert.equal(none?.kind === "turn.ended" && "contextWindow" in (none.usage ?? {}), false, "the field is absent, not zero");
});
