import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, ModelInfo, Options, PermissionResult, SDKMessage, SDKUserMessage, SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS } from "../../shared/protocol";
import type { AskId, MessageUuid, ModelId, TurnId, UploadId } from "../../shared/protocol";
import { killTree } from "../util/killTree";
import { Pushable } from "../util/pushable";
import { buildUserMessage, modelCatalog, parseModelId, toSlashCommands, SdkAgentFactory, PHONE_APPENDIX } from "./agent";
import type { AgentEvent, SdkDeps, SdkQuery, SpawnOptions } from "./agent";
import { FakeAgentFactory } from "./agent.fake";

const t = "t:7" as TurnId;
const sdkFrame = (m: unknown): SDKMessage => m as SDKMessage;
const init = sdkFrame({ type: "system", subtype: "init", session_id: "abc", uuid: "u", model: "m", terminal_slash_commands: ["exit"] });
const result = (extra: Record<string, unknown> = {}): SDKMessage =>
  sdkFrame({ type: "result", subtype: "success", is_error: false, session_id: "s1", duration_ms: 1234, total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300 }, result: "done", ...extra });
const textDelta = (text: string, index = 0): SDKMessage => sdkFrame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });

const spawnOpts: SpawnOptions = { cwd: "/tmp", model: "claude-opus-5" as ModelId, effort: "low", permissionMode: "ask", resume: null, forkAt: null, additionalDirectories: [], appendSystemPrompt: PHONE_APPENDIX, sendToPhone: () => Promise.reject(new Error("not in this test")) };

/** Poll until `pred` holds, with a real timeout, so the tests wait on a condition rather than a fixed number of ticks. */
async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

/**
 * A recorded stand-in for the SDK: the test pushes frames and the session
 * reads them through the same SdkQuery surface the real query() returns.
 * Like the SDK, interrupt() resolves with a receipt first and the
 * interrupted turn's result lands on the stream afterwards (sdk.d.ts,
 * SDKControlInterruptResponse "Ordering"). The child the spawner starts is a
 * real detached `sleep`, so pid is genuine; the injected killTree only
 * records the call and the abort signal reaps the child.
 */
function recorded() {
  const frames = new Pushable<SDKMessage>();
  const calls: string[] = [];
  const inputs: SDKUserMessage[] = [];
  /** The Options the session handed query(), so a test can drive its permission callback. */
  const spawned: { options: Options | null } = { options: null };
  const commands: SdkSlashCommand[] = [
    { name: "commit", description: "Commit", argumentHint: "" },
    { name: "exit", description: "Leave", argumentHint: "" },
  ];
  const models: ModelInfo[] = [{ value: "claude-opus-5", displayName: "Opus 5", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] }];
  const q: SdkQuery = {
    [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
    interrupt: async () => {
      calls.push("interrupt");
      setTimeout(() => frames.push(result({ subtype: "error_during_execution", is_error: true, errors: ["interrupted"] })), 5);
      return { still_queued: [] };
    },
    setModel: async (m) => void calls.push(`setModel:${m}`),
    applyFlagSettings: async (s) => void calls.push(`effort:${s.effortLevel}`),
    setPermissionMode: async (m) => void calls.push(`mode:${m}`),
    supportedCommands: async () => commands,
    supportedModels: async () => models,
    reloadSkills: async () => ({ skills: [{ name: "fresh", description: "", argumentHint: "" }] }),
    close: () => {
      calls.push("close");
      frames.end();
    },
  };
  const deps: SdkDeps = {
    env: {},
    query: ({ prompt, options }) => {
      spawned.options = options;
      const signal = options.abortController?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          calls.push("abort");
          frames.end();
        });
        options.spawnClaudeCodeProcess?.({ command: "sleep", args: ["60"], cwd: "/tmp", env: {}, signal })?.on("error", () => {});
      }
      void (async () => {
        for await (const m of prompt) inputs.push(m);
      })();
      return q;
    },
    killTree: async (pid) => void calls.push(`killTree:${pid}`),
  };
  return { frames, calls, inputs, deps, spawned };
}

async function liveSession() {
  const r = recorded();
  const session = await new SdkAgentFactory(r.deps).spawn(spawnOpts);
  const seen: AgentEvent[] = [];
  const drained = (async () => {
    for await (const ev of session.events()) seen.push(ev);
  })();
  r.frames.push(init);
  await until(() => seen.length === 1, "session.bound");
  return { ...r, session, seen, drained };
}

/** Push frames under one turn, end it with a result, and return the events that turn produced. */
async function turnEvents(frames: readonly SDKMessage[], end: SDKMessage = result()): Promise<readonly AgentEvent[]> {
  const s = await liveSession();
  const before = s.seen.length;
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message to reach the SDK");
  for (const f of [...frames, end]) s.frames.push(f);
  await done;
  await until(() => s.seen.at(-1)?.kind === "turn.ended", "turn.ended on the event stream");
  return s.seen.slice(before);
}

/** Drive the permission callback the way the CLI would: one call per tool use, blocked until the session answers. */
function permissionDriver(s: Awaited<ReturnType<typeof liveSession>>) {
  const canUseTool = s.spawned.options?.canUseTool;
  assert.ok(canUseTool, "the session registered canUseTool");
  let n = 0;
  return (toolName: string, input: Record<string, unknown>, extra: Partial<Parameters<CanUseTool>[2]> = {}): Promise<PermissionResult> =>
    canUseTool(toolName, input, { ...extra, signal: extra.signal ?? new AbortController().signal, toolUseID: `tu-${++n}`, requestId: `req-${n}` }) as Promise<PermissionResult>;
}

const lastAsk = (s: { seen: AgentEvent[] }) => {
  const ev = s.seen.findLast((e) => e.kind === "ask.opened");
  assert.ok(ev && ev.kind === "ask.opened");
  return ev;
};

test("permission callback: ask.opened carries the tool and the SDK title, and the result matches the answer verbatim", async () => {
  const s = await liveSession();
  assert.equal(s.spawned.options?.permissionMode, "default", "ask mode spawns with the CLI's default rules");
  void s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message");
  const permit = permissionDriver(s);

  const first = permit("Bash", { command: "rm -rf build" }, { title: "Claude wants to run rm -rf build" });
  await until(() => s.seen.some((e) => e.kind === "ask.opened"), "ask.opened");
  const opened = lastAsk(s);
  assert.deepEqual(opened.ask, { kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "tu-1", title: "Claude wants to run rm -rf build", description: null });
  assert.equal(opened.turnId, t);
  s.session.answer(opened.askId, { kind: "allow" });
  assert.deepEqual(await first, { behavior: "allow", updatedInput: { command: "rm -rf build" } });

  const second = permit("Bash", { command: "git push" });
  await until(() => s.seen.filter((e) => e.kind === "ask.opened").length === 2, "a second ask: plain allow does not cover the next call");
  s.session.answer(lastAsk(s).askId, { kind: "deny", reason: "not yet" });
  assert.deepEqual(await second, { behavior: "deny", message: "not yet" });

  const third = permit("Bash", { command: "git push" });
  await until(() => s.seen.filter((e) => e.kind === "ask.opened").length === 3, "third ask");
  s.session.answer(lastAsk(s).askId, { kind: "deny", reason: null });
  assert.deepEqual(await third, { behavior: "deny", message: "Denied from the phone" });
  s.session.answer("nope" as AskId, { kind: "allow" });
  assert.equal(s.seen.filter((e) => e.kind === "ask.answered").length, 0, "a person's answer is logged by the supervisor, never echoed by the adapter");
});

test("allowTurn covers later calls of the same tool in the same turn, not another tool, and not the next turn", async () => {
  const s = await liveSession();
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message");
  const permit = permissionDriver(s);
  const asks = () => s.seen.filter((e) => e.kind === "ask.opened").length;

  const first = permit("Edit", { file_path: "/a" });
  await until(() => asks() === 1, "first ask");
  s.session.answer(lastAsk(s).askId, { kind: "allowTurn" });
  assert.equal((await first).behavior, "allow");
  assert.deepEqual(await permit("Edit", { file_path: "/b" }), { behavior: "allow", updatedInput: { file_path: "/b" } });
  assert.equal(asks(), 1, "the second Edit did not ask");

  const other = permit("Bash", { command: "ls" });
  await until(() => asks() === 2, "a different tool still asks");
  s.session.answer(lastAsk(s).askId, { kind: "allow" });
  await other;

  s.frames.push(result());
  await done;
  const next = s.session.send({ turnId: "t:8" as TurnId, text: "again", uploads: [] });
  await until(() => s.inputs.length === 2, "the second turn");
  const again = permit("Edit", { file_path: "/c" });
  await until(() => asks() === 3, "the allowlist reset with the turn");
  s.session.answer(lastAsk(s).askId, { kind: "deny", reason: null });
  assert.equal((await again).behavior, "deny");
  s.frames.push(result());
  await next;
});

test("a question ask round-trips the answers into updatedInput.answers keyed by question text", async () => {
  const s = await liveSession();
  void s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message");
  const permit = permissionDriver(s);
  const input = {
    questions: [
      { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon" }], multiSelect: false },
      { question: "Which features?", header: "Features", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: true },
      { question: 42 },
    ],
  };
  const pending = permit("AskUserQuestion", input);
  await until(() => s.seen.some((e) => e.kind === "ask.opened"), "ask.opened");
  const opened = lastAsk(s);
  assert.deepEqual(opened.ask, {
    kind: "question",
    questions: [
      { question: "Which library?", header: "Library", options: [{ label: "date-fns", description: "small" }, { label: "luxon", description: "" }], multiSelect: false },
      { question: "Which features?", header: "Features", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: true },
    ],
  });
  s.session.answer(opened.askId, { kind: "answers", answers: [{ kind: "text", text: "dayjs" }, { kind: "options", labels: ["A", "B"] }] });
  assert.deepEqual(await pending, { behavior: "allow", updatedInput: { ...input, answers: { "Which library?": "dayjs", "Which features?": "A, B" } } });

  const denied = permit("AskUserQuestion", input);
  await until(() => s.seen.filter((e) => e.kind === "ask.opened").length === 2, "second question");
  s.session.answer(lastAsk(s).askId, { kind: "allow" });
  assert.deepEqual(await denied, { behavior: "deny", message: "No answer" }, "allow is not an answer to a question");

  const malformed = permit("AskUserQuestion", { questions: "?" });
  await until(() => s.seen.filter((e) => e.kind === "ask.opened").length === 3, "third ask");
  assert.equal(lastAsk(s).ask.kind, "tool", "an AskUserQuestion with no parseable question is a plain tool ask");
  s.session.answer(lastAsk(s).askId, { kind: "deny", reason: null });
  await malformed;
});

test("the turn's end denies whatever is still pending, so the SDK callback never hangs", async () => {
  const s = await liveSession();
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message");
  const permit = permissionDriver(s);
  const pending = permit("Bash", { command: "ls" });
  await until(() => s.seen.some((e) => e.kind === "ask.opened"), "ask.opened");
  s.frames.push(result());
  await done;
  assert.deepEqual(await pending, { behavior: "deny", message: "turn ended" });

  const aborter = new AbortController();
  const next = s.session.send({ turnId: "t:8" as TurnId, text: "again", uploads: [] });
  await until(() => s.inputs.length === 2, "the second turn");
  const cancelled = permit("Bash", { command: "ls" }, { signal: aborter.signal });
  await until(() => s.seen.filter((e) => e.kind === "ask.opened").length === 2, "second ask");
  aborter.abort();
  assert.deepEqual(await cancelled, { behavior: "deny", message: "cancelled" });
  s.frames.push(result());
  await next;
  assert.deepEqual(await permit("Bash", { command: "ls" }), { behavior: "deny", message: "turn ended" }, "no turn in flight");
});

test("a permission_denied frame maps to an opened-and-answered pair with the rule as the answerer; subagent denials are ignored", async () => {
  const denied = (extra: Record<string, unknown> = {}) => sdkFrame({ type: "system", subtype: "permission_denied", tool_name: "Bash", tool_use_id: "toolu_9", message: "Bash(rm:*) is denied by a rule", decision_reason_type: "rule", session_id: "abc", uuid: "u9", ...extra });
  const evs = await turnEvents([denied(), denied({ agent_id: "sub-1", tool_use_id: "toolu_10" })]);
  assert.deepEqual(evs.slice(0, -1), [
    { kind: "ask.opened", turnId: t, askId: "rule:toolu_9", ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "toolu_9", title: null, description: null } },
    { kind: "ask.answered", turnId: t, askId: "rule:toolu_9", answer: { kind: "deny", reason: "Bash(rm:*) is denied by a rule" }, by: { by: "system", reason: "rule" } },
  ]);
});

test("permission mode: bypass spawns with bypassPermissions and a live switch reaches the query", async () => {
  const r = recorded();
  await new SdkAgentFactory(r.deps).spawn({ ...spawnOpts, permissionMode: "bypass" });
  assert.equal(r.spawned.options?.permissionMode, "bypassPermissions");
  assert.equal(r.spawned.options?.allowDangerouslySkipPermissions, true);
  const s = await liveSession();
  await s.session.setPermissionMode("bypass");
  await s.session.setPermissionMode("ask");
  assert.deepEqual(s.calls, ["mode:bypassPermissions", "mode:default"]);
});

test("system init binds the session before any turn; stray frames with no turn in flight are dropped", async () => {
  const s = await liveSession();
  assert.equal(s.session.sessionId, "abc");
  assert.deepEqual(s.seen, [{ kind: "session.bound", sessionId: "abc" }]);
  s.frames.push(textDelta("stray"));
  s.frames.push(result());
  await tick();
  await tick();
  assert.deepEqual(s.seen, [{ kind: "session.bound", sessionId: "abc" }]);
  assert.deepEqual(await turnEvents([textDelta("hi", 2)]), [{ kind: "assistant.text", turnId: t, blockIx: 2, delta: "hi" }, { kind: "turn.ended", turnId: t, outcome: "ok", sessionId: "s1", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, cacheWriteTokens: 300, costUsd: 0.5, contextTokens: 4400, durationMs: 1234 }, error: null }]);
});

test("a turn settles exactly once even when the stream carries two results", async () => {
  const s = await liveSession();
  let settled = 0;
  const done = s.session.send({ turnId: t, text: "go", uploads: [] }).then(() => settled++);
  await until(() => s.inputs.length === 1, "the user message");
  s.frames.push(result());
  s.frames.push(result());
  await done;
  s.frames.push(sdkFrame({ type: "system", subtype: "init", session_id: "abc2", uuid: "u2", model: "m" }));
  await until(() => s.session.sessionId === "abc2", "the stream to drain past both results");
  assert.equal(settled, 1);
  assert.deepEqual(s.seen.filter((e) => e.kind === "turn.ended").length, 1);
});

test("the user turn reaches the SDK as a text block and cost is reported per turn", async () => {
  const s = await liveSession();
  const first = s.session.send({ turnId: t, text: "first", uploads: [] });
  await until(() => s.inputs.length === 1, "the first message");
  s.frames.push(result({ total_cost_usd: 0.2 }));
  await first;
  const second = s.session.send({ turnId: "t:8" as TurnId, text: "second", uploads: [] });
  await until(() => s.inputs.length === 2, "the second message");
  s.frames.push(result({ total_cost_usd: 0.5 }));
  await second;
  await until(() => s.seen.filter((e) => e.kind === "turn.ended").length === 2, "both turn.ended events");
  assert.deepEqual(s.inputs.map((m) => m.message.content), [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]]);
  const costs = s.seen.flatMap((e) => (e.kind === "turn.ended" ? [e.usage?.costUsd] : []));
  assert.deepEqual(costs, [0.2, 0.3]);
});

test("interrupt resolves the pending send as interrupted once the result lands, and is a no-op with nothing in flight", async () => {
  const s = await liveSession();
  await s.session.interrupt();
  assert.deepEqual(s.calls, []);
  let settled = false;
  const done = s.session.send({ turnId: t, text: "go", uploads: [] }).then(() => (settled = true));
  await until(() => s.inputs.length === 1, "the user message");
  await s.session.interrupt();
  assert.equal(settled, false, "send settles on the result frame, not on the interrupt receipt");
  await done;
  await until(() => s.seen.at(-1)?.kind === "turn.ended", "turn.ended");
  assert.deepEqual(s.calls, ["interrupt"]);
  const ended = s.seen.at(-1)!;
  assert.equal(ended.kind, "turn.ended");
  if (ended.kind !== "turn.ended") return;
  assert.equal(ended.outcome, "interrupted");
  assert.equal(ended.error, null);
});

test("kill aborts, then kills the process group, then closes the query, and fails the pending turn", async () => {
  const s = await liveSession();
  const done = s.session.send({ turnId: t, text: "go", uploads: [] });
  await until(() => s.inputs.length === 1, "the user message");
  const pid = s.session.pid;
  assert.ok(pid, "the spawner reported a pid");
  try {
    await s.session.kill();
    await s.session.kill();
    await done;
    await s.drained;
  } finally {
    await killTree(pid, "group", 100);
  }
  assert.deepEqual(s.calls, ["abort", `killTree:${pid}`, "close"]);
  assert.equal(s.session.alive, false);
  const ended = s.seen.at(-1)!;
  assert.equal(ended.kind, "turn.ended");
  if (ended.kind !== "turn.ended") return;
  assert.equal(ended.outcome, "error");
  assert.equal(ended.error, "Claude Code session exited");
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
  const evs = await turnEvents([textDelta("hi", 2), sdkFrame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } }), sdkFrame({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0 } })]);
  assert.deepEqual(evs.slice(0, -1), [
    { kind: "assistant.text", turnId: t, blockIx: 2, delta: "hi" },
    { kind: "assistant.thinking", turnId: t, delta: "hmm" },
  ]);
});

test("subagent frames (parent_tool_use_id set) are ignored", async () => {
  const evs = await turnEvents([sdkFrame({ type: "stream_event", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })]);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]?.kind, "turn.ended");
});

test("assistant tool_use blocks map to tool.started with truncated input", async () => {
  const big = "x".repeat(LIMITS.TOOL_INPUT_MAX + 100);
  const evs = await turnEvents([
    sdkFrame({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "ignored here" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } }, { type: "tool_use", id: "toolu_2", name: "Bash", input: { cmd: big } }] },
    }),
  ]);
  assert.equal(evs.length, 3);
  assert.deepEqual(evs[0], { kind: "tool.started", turnId: t, toolUseId: "toolu_1", name: "Read", input: { path: "/a" } });
  const second = evs[1]!;
  assert.equal(second.kind, "tool.started");
  if (second.kind !== "tool.started") return;
  const inp = second.input as { truncated: boolean; bytes: number; head: string };
  assert.equal(inp.truncated, true);
  assert.ok(inp.bytes > LIMITS.TOOL_INPUT_MAX);
  assert.equal(inp.head.length, LIMITS.TOOL_INPUT_MAX);
});

test("user tool_result blocks map to tool.finished, string or block content, with error flag and byte truncation", async () => {
  const big = "y".repeat(LIMITS.TOOL_OUTPUT_MAX + 10);
  const evs = await turnEvents([
    sdkFrame({
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
  assert.equal(third.kind, "tool.finished");
  if (third.kind !== "tool.finished") return;
  assert.ok(third.output.endsWith(`[truncated, ${LIMITS.TOOL_OUTPUT_MAX + 10} bytes]`));
  const fourth = evs[3]!;
  assert.equal(fourth.kind, "tool.finished");
  if (fourth.kind !== "tool.finished") return;
  assert.ok(Buffer.byteLength(fourth.output.split("\n... [truncated")[0]!) <= LIMITS.TOOL_OUTPUT_MAX, "cut at a byte limit, not a character count");
});

test("error result maps to turn.ended {error} with scrubbed message", async () => {
  const [ev] = await turnEvents([], result({ subtype: "error_during_execution", is_error: true, errors: ["boom at /Users/danielgentile/x\n    at fn (file.js:1:1)"], usage: {} }));
  assert.equal(ev?.kind, "turn.ended");
  if (ev?.kind !== "turn.ended") return;
  assert.equal(ev.outcome, "error");
  assert.equal(ev.error, "boom at ~/x");
});

test("unknown message types produce nothing", async () => {
  const evs = await turnEvents([sdkFrame({ type: "task_notification" }), sdkFrame({ type: "system", subtype: "status", session_id: "abc" })]);
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
  const factory = new SdkAgentFactory({ query, killTree: (pid) => killTree(pid, "group"), env: process.env });
  const catalog = await modelCatalog(factory);
  assert.ok(catalog.length > 0, "catalog is empty");
  const model = catalog.find((c) => /sonnet/.test(c.id))?.id ?? catalog[0]!.id;

  const session = await factory.spawn({ cwd: process.cwd(), model, effort: "low", permissionMode: "bypass", resume: null, forkAt: null, additionalDirectories: [], appendSystemPrompt: PHONE_APPENDIX, sendToPhone: () => Promise.reject(new Error("not in this test")) });
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
  const ended = async (modelUsage: unknown) => (await turnEvents([], result({ modelUsage }))).at(-1);

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

test("turn.ended carries the uuid of the turn's last main-thread message, which is where the SDK forks a kept turn", async () => {
  const chain = (type: "assistant" | "user", uuid: string, parent: string | null = null): SDKMessage =>
    sdkFrame({ type, uuid, parent_tool_use_id: parent, message: { role: type, content: [] } });
  const evs = await turnEvents([chain("assistant", "u-1"), chain("user", "u-2"), chain("assistant", "u-3"), chain("assistant", "sub-1", "toolu_1")]);
  const end = evs.at(-1)!;
  assert.ok(end.kind === "turn.ended");
  assert.equal(end.forkPoint, "u-3", "the LAST chain entry of the kept turn, not the prompt and not the first reply");

  const bare = (await turnEvents([textDelta("hi")])).at(-1)!;
  assert.ok(bare.kind === "turn.ended");
  assert.equal(bare.forkPoint, undefined, "a turn that produced no chain message has no fork point and forks fresh");
});

test("spawning with forkAt asks the SDK to fork the resumed session; a plain resume continues it", async () => {
  const forked = recorded();
  await new SdkAgentFactory(forked.deps).spawn({ ...spawnOpts, resume: "sess-1" as never, forkAt: "u-3" as MessageUuid });
  assert.equal(forked.spawned.options?.resume, "sess-1");
  assert.equal(forked.spawned.options?.forkSession, true);
  assert.equal(forked.spawned.options?.resumeSessionAt, "u-3");

  const plain = recorded();
  await new SdkAgentFactory(plain.deps).spawn({ ...spawnOpts, resume: "sess-1" as never });
  assert.equal(plain.spawned.options?.resume, "sess-1");
  assert.equal(plain.spawned.options?.forkSession, undefined, "forkSession on an ordinary resume would branch the thread's own session every spawn");
  assert.equal(plain.spawned.options?.resumeSessionAt, undefined);
});
