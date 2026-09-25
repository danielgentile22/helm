/**
 * Adapter over @anthropic-ai/claude-agent-sdk. The rest of the server talks
 * to AgentSession and consumes ThreadEventBody; only main.ts touches the SDK,
 * to hand query() in as a dependency.
 *
 * One AgentSession = one long-lived Claude Code process in streaming-input
 * mode (query() with an AsyncIterable prompt), so successive turns reuse the
 * process, MCP servers stay warm, and interrupt() has a target between
 * SDK messages. Memory across process restarts comes from `resume`.
 *
 * VERIFIED against @anthropic-ai/claude-agent-sdk@0.3.268 (docs/SDK-FINDINGS.md):
 *   query({ prompt: AsyncIterable<SDKUserMessage> })         sdk.d.ts:2973
 *   Query.interrupt()                                       sdk.d.ts:2625
 *   Query.setModel(model?)                                  sdk.d.ts:2659
 *   Query.applyFlagSettings({ effortLevel })                sdk.d.ts:2706
 *   Query.supportedModels() -> ModelInfo[]                  sdk.d.ts:2763
 *   Query.supportedCommands() -> SlashCommand[]             sdk.d.ts:2757
 *   Query.reloadSkills() -> { skills: SlashCommand[] }      sdk.d.ts:2845
 *   Options.settingSources?: SettingSource[]                sdk.d.ts:2096
 *   Options.spawnClaudeCodeProcess?: (o) => SpawnedProcess  sdk.d.ts:2288
 *   Options.canUseTool: CanUseTool                          sdk.d.ts:209
 *   Query.setPermissionMode(mode)                           sdk.d.ts:2632
 *   system.permission_denied                                sdk.d.ts:4922
 *   Options.forkSession?: boolean                           sdk.d.ts:1580
 *   Options.resumeSessionAt?: string                        sdk.d.ts:1951
 *
 * supportedCommands() tracks the `commands_changed` system message the CLI
 * pushes mid-session, so there is nothing to cache or invalidate here.
 *
 * spawnClaudeCodeProcess lets us spawn the child ourselves with
 * `detached: true`, so it leads its own process group and killTree keeps
 * its real guarantee (grandchildren, MCP servers, shell tools, die with it).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { CanUseTool, ModelInfo, Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { answerPhrase, EFFORTS, LIMITS, MODEL_POLICY_DENY } from "../../shared/protocol";
import type {
  AskAnswer,
  AskId,
  AskPayload,
  AskQuestion,
  ClaudeSessionId,
  Effort,
  ModelId,
  MessageUuid,
  ModelChoice,
  OfferedFile,
  RecordedNote,
  PermissionMode,
  SlashCommand,
  StagedUpload,
  ThreadEventBody,
  ToolUseId,
  TurnId,
  Usage,
} from "../../shared/protocol";
import { Pushable } from "../util/pushable";
import { isImageMime } from "./files";

export interface SpawnOptions {
  readonly cwd: string;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly permissionMode: PermissionMode;
  /** Present when we have a session to resume; absent on a brand-new thread. */
  readonly resume: ClaudeSessionId | null;
  /** With `resume`: fork the resumed session at this message uuid into a new session instead of continuing it. */
  readonly forkAt: MessageUuid | null;
  /** `--add-dir` equivalents; from config, default ~/Projects ~/Desktop ~/Documents. */
  readonly additionalDirectories: readonly string[];
  /** Short phone-context appendix; never the vault. */
  readonly appendSystemPrompt: string;
  /**
   * Backs the `send_to_phone` tool: offer a file on the Mac to the phone.
   * Throws with a sentence the model can relay when the path is refused.
   */
  readonly sendToPhone: (path: string, note: string | null) => Promise<OfferedFile>;
  /** Backs the `record_note` tool: report one vault note a save wrote. Throws the same way sendToPhone does. */
  readonly recordNote: (path: string, summary: string) => Promise<RecordedNote>;
}

/** What the supervisor hands the adapter for one turn. */
export interface TurnInput {
  readonly turnId: TurnId;
  readonly text: string;
  readonly uploads: readonly StagedUpload[];
}

/**
 * Events the adapter produces, already in log vocabulary. `session.bound`
 * appears once per spawn; `turn.ended` exactly once per TurnInput, even on
 * error or interrupt (settle-exactly-once, carried over from the old route).
 * `ask.opened` is yielded when the SDK's permission callback blocks; the
 * adapter never yields the matching `ask.answered` for a person's answer
 * (the supervisor logs that before forwarding it), only for a decision
 * Claude Code made on its own, as an opened-and-answered pair.
 */
export type AgentEvent = Extract<
  ThreadEventBody,
  {
    kind:
      | "session.bound"
      | "assistant.text"
      | "assistant.thinking"
      | "tool.started"
      | "tool.finished"
      | "ask.opened"
      | "ask.answered"
      | "turn.ended";
  }
>;

export interface AgentSession {
  readonly pid: number | null;
  readonly sessionId: ClaudeSessionId | null;
  /** False once the process has exited or been killed. */
  readonly alive: boolean;
  /**
   * Push a user turn onto the streaming input. Resolves when the turn's
   * `turn.ended` has been yielded on events(). Rejects only if the session is
   * dead; a model error is a `turn.ended {outcome: "error"}`, not a rejection.
   */
  send(input: TurnInput): Promise<void>;
  /** Stop the running turn. Idempotent, and a no-op when no turn is in flight. */
  interrupt(): Promise<void>;
  setModel(model: ModelId): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  /** Live switch; takes effect at the next permission decision. */
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Settle a pending ask. The adapter forwards the answer to the SDK exactly
   * as given and never decides; an unknown or already-settled id is a no-op.
   */
  answer(askId: AskId, answer: AskAnswer): void;
  /** Ordered stream of AgentEvent for the life of the process. Ends when the process exits. */
  events(): AsyncIterable<AgentEvent>;
  /** The live slash-command menu, terminal-only entries removed. Empty when the session is dead. */
  commands(): Promise<readonly SlashCommand[]>;
  /** Rediscover skills from disk, then return the refreshed menu. Empty when the session is dead. */
  reloadSkills(): Promise<readonly SlashCommand[]>;
  /** SIGTERM the group, SIGKILL after 10 s, settle once. Idempotent. */
  kill(): Promise<void>;
}

/** One row of the SDK catalog before policy is applied. */
export interface RawModel {
  readonly id: string;
  readonly label: string;
  readonly supportsEffort: boolean;
  readonly efforts: readonly string[];
}

export interface AgentFactory {
  spawn(opts: SpawnOptions): Promise<AgentSession>;
  /** The SDK's live catalog, unfiltered. */
  models(): Promise<readonly RawModel[]>;
  /**
   * The command menu a session in `cwd` would see, without spawning a real
   * one. Uncached: the supervisor owns the cache, because only it knows
   * whether a reload was asked for.
   */
  commands(cwd: string): Promise<readonly SlashCommand[]>;
}

// ---------------------------------------------------------------------------
// Pure mapping from SDK messages to log vocabulary
// ---------------------------------------------------------------------------

interface MapContext {
  /** Set when interrupt() was called during this turn, so the result maps to `interrupted`. */
  readonly interrupted: boolean;
  /** Cumulative cost reported by the previous result; the SDK reports cost cumulatively per process. */
  readonly prevCostUsd: number;
  /**
   * The uuid of the turn's last main-thread message, which is where a fork of
   * this thread resumes. The SDK forks at the kept turn's LAST chain entry
   * (sdk.d.ts resumeDropsTurn), not at the prompt or the first reply.
   */
  readonly lastUuid: MessageUuid | null;
}

/** Truncate a JSON-able value to at most `max` bytes of its JSON text. */
function truncateJson(value: unknown, max: number): unknown {
  const text = JSON.stringify(value) ?? "null";
  if (Buffer.byteLength(text) <= max) return value;
  return { truncated: true, bytes: Buffer.byteLength(text), head: text.slice(0, max) };
}

/** Truncate text to `max` bytes, appending a byte-count note the client renders. */
function truncateText(text: string, max: number): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= max) return text;
  return `${Buffer.from(text).subarray(0, max).toString("utf8")}\n... [truncated, ${bytes} bytes]`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : isRecord(b) && b.type === "image" ? "[image]" : ""))
    .join("\n");
}

/**
 * The context window of the model that carried the turn. `modelUsage` is
 * keyed by model and a turn can touch several (a subagent on a small model,
 * say), so the busiest entry by prompt tokens is the one whose window the
 * meter should be read against.
 */
function contextWindowFrom(modelUsage: unknown): number | null {
  if (!isRecord(modelUsage)) return null;
  let best: { prompt: number; window: number } | null = null;
  for (const entry of Object.values(modelUsage)) {
    if (!isRecord(entry)) continue;
    const num = (k: string): number => (typeof entry[k] === "number" ? (entry[k] as number) : 0);
    const prompt = num("inputTokens") + num("cacheReadInputTokens");
    const window = num("contextWindow");
    if (window > 0 && (!best || prompt > best.prompt)) best = { prompt, window };
  }
  return best?.window ?? null;
}

function usageFrom(msg: Record<string, unknown>, ctx: MapContext): Usage | null {
  const u = msg.usage;
  if (!isRecord(u)) return null;
  const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const input = n("input_tokens");
  const cacheRead = n("cache_read_input_tokens");
  const cacheWrite = n("cache_creation_input_tokens");
  const total = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
  const contextWindow = contextWindowFrom(msg.modelUsage);
  return {
    inputTokens: input,
    outputTokens: n("output_tokens"),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    costUsd: total === null ? null : Math.max(0, total - ctx.prevCostUsd),
    contextTokens: input + cacheRead + cacheWrite,
    ...(contextWindow === null ? {} : { contextWindow }),
    durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : 0,
  };
}

/**
 * Parse an SDK command list into the wire shape, dropping the terminal-bound
 * entries (`/exit`, `/statusline` and friends). This is the only place a raw
 * SDK command becomes a SlashCommand, per boundary-discipline; both the live
 * session and the throwaway probe go through it.
 */
export function toSlashCommands(raw: unknown, hide: ReadonlySet<string>): readonly SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommand[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.name !== "string" || c.name === "" || hide.has(c.name)) continue;
    out.push({
      name: c.name,
      description: typeof c.description === "string" ? c.description : "",
      argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : "",
    });
  }
  return out;
}

/** Strip absolute home paths and stack frames from an error string before it reaches the phone. */
function scrubError(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s+at\s/.test(l))
    .join("\n")
    .replaceAll(homedir(), "~")
    .trim()
    .slice(0, 500);
}

/**
 * Pure mapper from an SDK message to zero or more AgentEvents. This is the
 * boundary where the SDK's shape is parsed and trusted types begin. Kept pure
 * so the session tests can replay recorded SDK frames with no API spend.
 *
 * Mapping
 *   system.init                                  -> session.bound
 *   system.permission_denied                     -> ask.opened + ask.answered {system: rule} (Claude Code decided alone)
 *   stream_event content_block_delta text_delta  -> assistant.text (blockIx from the event index)
 *   stream_event content_block_delta thinking_delta -> assistant.thinking
 *   assistant message tool_use block             -> tool.started (input truncated)
 *   user message tool_result block               -> tool.finished (output truncated)
 *   result                                       -> turn.ended (outcome from subtype; usage mapped)
 *   everything else, and anything from a subagent (parent_tool_use_id set) -> []
 */
function agentMessageToEvents(turnId: TurnId, sdkMessage: unknown, ctx: MapContext): readonly AgentEvent[] {
  if (!isRecord(sdkMessage)) return [];
  const m = sdkMessage;
  if (typeof m.parent_tool_use_id === "string") return [];

  switch (m.type) {
    case "system": {
      if (m.subtype === "init" && typeof m.session_id === "string") return [{ kind: "session.bound", sessionId: m.session_id as ClaudeSessionId }];
      if (m.subtype === "permission_denied" && typeof m.tool_name === "string" && typeof m.tool_use_id === "string" && typeof m.agent_id !== "string") {
        const askId = `rule:${m.tool_use_id}` as AskId;
        return [
          { kind: "ask.opened", turnId, askId, ask: { kind: "tool", toolName: m.tool_name, input: {}, toolUseId: m.tool_use_id as ToolUseId, title: null, description: null } },
          { kind: "ask.answered", turnId, askId, answer: { kind: "deny", reason: typeof m.message === "string" ? m.message : null }, by: { by: "system", reason: "rule" } },
        ];
      }
      return [];
    }

    case "stream_event": {
      const ev = m.event;
      if (!isRecord(ev) || ev.type !== "content_block_delta" || !isRecord(ev.delta)) return [];
      const blockIx = typeof ev.index === "number" ? ev.index : 0;
      if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") return [{ kind: "assistant.text", turnId, blockIx, delta: ev.delta.text }];
      if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") return [{ kind: "assistant.thinking", turnId, delta: ev.delta.thinking }];
      return [];
    }

    case "assistant": {
      const content = isRecord(m.message) ? m.message.content : null;
      if (!Array.isArray(content)) return [];
      const out: AgentEvent[] = [];
      for (const b of content) {
        if (isRecord(b) && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          out.push({ kind: "tool.started", turnId, toolUseId: b.id as ToolUseId, name: b.name, input: truncateJson(b.input, LIMITS.TOOL_INPUT_MAX) });
        }
      }
      return out;
    }

    case "user": {
      const content = isRecord(m.message) ? m.message.content : null;
      if (!Array.isArray(content)) return [];
      const out: AgentEvent[] = [];
      for (const b of content) {
        if (isRecord(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") {
          out.push({
            kind: "tool.finished",
            turnId,
            toolUseId: b.tool_use_id as ToolUseId,
            output: truncateText(toolResultText(b.content), LIMITS.TOOL_OUTPUT_MAX),
            isError: b.is_error === true,
          });
        }
      }
      return out;
    }

    case "result": {
      const ok = m.subtype === "success" && m.is_error !== true;
      const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === "string") : [];
      const errorText = ok ? null : scrubError(errors.join("\n") || (typeof m.result === "string" ? m.result : "") || String(m.subtype));
      return [
        {
          kind: "turn.ended",
          turnId,
          outcome: ctx.interrupted ? "interrupted" : ok ? "ok" : "error",
          sessionId: typeof m.session_id === "string" ? (m.session_id as ClaudeSessionId) : null,
          usage: usageFrom(m, ctx),
          error: ctx.interrupted ? null : errorText,
          ...(ctx.lastUuid === null ? {} : { forkPoint: ctx.lastUuid }),
        },
      ];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Asks: the permission callback's input and output in log vocabulary
// ---------------------------------------------------------------------------

const optionalString = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parse an AskUserQuestion input (sdk-tools.d.ts AskUserQuestionInput). Malformed entries are dropped; an empty list means "not a question". */
function questionsFrom(input: Record<string, unknown>): readonly AskQuestion[] {
  if (!Array.isArray(input.questions)) return [];
  const out: AskQuestion[] = [];
  for (const q of input.questions) {
    if (!isRecord(q) || typeof q.question !== "string") continue;
    const options = Array.isArray(q.options) ? q.options.flatMap((o) => (isRecord(o) && typeof o.label === "string" ? [{ label: o.label, description: optionalString(o.description) ?? "" }] : [])) : [];
    out.push({ question: q.question, header: optionalString(q.header) ?? "", options, multiSelect: q.multiSelect === true });
  }
  return out;
}

/** The boundary where an SDK permission request becomes an AskPayload. */
export function askPayloadFrom(toolName: string, input: Record<string, unknown>, opts: { toolUseID: string; title?: string; description?: string }): AskPayload {
  if (toolName === "AskUserQuestion") {
    const questions = questionsFrom(input);
    if (questions.length > 0) return { kind: "question", questions };
  }
  return { kind: "tool", toolName, input: truncateJson(input, LIMITS.TOOL_INPUT_MAX), toolUseId: opts.toolUseID as ToolUseId, title: opts.title ?? null, description: opts.description ?? null };
}

/**
 * Pure: the SDK result an answer maps to. A question ask is answered through
 * `updatedInput.answers` keyed by question text, the documented convention
 * for AskUserQuestion; anything but an `answers` answer to a question, or an
 * `answers` answer to a tool, is a mismatch the route rejects, so here it is a
 * denial rather than a guess.
 */
export function permissionResultFor(ask: AskPayload, answer: AskAnswer, input: Record<string, unknown>): PermissionResult {
  if (ask.kind === "question") {
    if (answer.kind !== "answers") return { behavior: "deny", message: (answer.kind === "deny" && answer.reason) || "No answer" };
    const answers = Object.fromEntries(ask.questions.map((q, i) => [q.question, answer.answers[i] ? answerPhrase(answer.answers[i]) : ""]));
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  switch (answer.kind) {
    case "allow":
    case "allowTurn":
      return { behavior: "allow", updatedInput: input };
    case "deny":
      return { behavior: "deny", message: answer.reason ?? "Denied from the phone" };
    case "answers":
      return { behavior: "deny", message: "No answer" };
  }
}

/**
 * Build the SDK user message text for a turn. Images become image content
 * blocks so the model sees them; every upload (images included) is also
 * listed by absolute path in a trailing line so the model can Read/mv it.
 */
export function buildUserMessage(input: TurnInput): { text: string; imagePaths: readonly string[] } {
  let text = input.text;
  if (input.uploads.length) {
    text += "\n\nAttached files (absolute paths on this Mac):\n" + input.uploads.map((u) => `- ${u.path} (${u.mime}, ${u.bytes} B)`).join("\n");
  }
  return { text, imagePaths: input.uploads.filter((u) => isImageMime(u.mime)).map((u) => u.path) };
}

/** The only system-prompt addition Helm makes. Deliberately short; no vault preload. */
export const PHONE_APPENDIX =
  "You are being driven from a phone via Helm. Reply tightly; prefer doing the task over narrating it. " +
  "Paths you mention should be absolute. Do not paste large files back; say what you changed. " +
  "When the user asks for a file on their phone (to see it, save it, share it), call the send_to_phone tool with its absolute path " +
  "rather than printing the path; it appears on the phone as a tappable card. One file per call. If the tool refuses, tell the user why.";

/**
 * The one MCP server Helm adds: in-process, two tools. The handlers run inside
 * the Helm process, so what the model hands over is logged directly rather
 * than parsed back out of its text.
 */
export function helmToolServer(sendToPhone: SpawnOptions["sendToPhone"], recordNote: SpawnOptions["recordNote"]) {
  return createSdkMcpServer({
    name: "helm",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "send_to_phone",
        "Send one file on this Mac to the user's phone, where it appears as a tappable card with save and share options. Use when the user asks to see, save, or share a file on their phone.",
        { path: z.string().describe("Absolute path of the file on this Mac"), note: z.string().optional().describe("One short line on what this file is, shown on the card") },
        async ({ path, note }) => {
          try {
            const f = await sendToPhone(path, note ?? null);
            return { content: [{ type: "text", text: `Sent ${f.name} (${f.mime}, ${f.bytes} bytes) to the phone.` }] };
          } catch (err) {
            return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
          }
        },
      ),
      tool(
        "record_note",
        "Report one vault note you created or changed while saving this conversation to the vault. Call it once per note, after the note is written. Only used during a Save to vault turn.",
        { path: z.string().describe("Absolute path of the note inside the vault"), summary: z.string().describe("One line on what changed in this note") },
        async ({ path, summary }) => {
          try {
            const n = await recordNote(path, summary);
            return { content: [{ type: "text", text: `Recorded ${n.rel}: ${n.summary}` }] };
          } catch (err) {
            return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
          }
        },
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Real SDK session
// ---------------------------------------------------------------------------

/** The slice of the SDK's Query the session drives. A recorded adapter implements this in tests. */
export type SdkQuery = AsyncIterable<SDKMessage> & Pick<Query, "interrupt" | "setModel" | "applyFlagSettings" | "setPermissionMode" | "supportedCommands" | "supportedModels" | "reloadSkills" | "close">;

const SDK_MODE: Record<PermissionMode, "default" | "bypassPermissions"> = { ask: "default", bypass: "bypassPermissions" };

export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => SdkQuery;

/**
 * What the adapter reaches outside its own process: the SDK entry point and
 * the process-group killer. Production passes the real ones (main.ts); tests
 * pass a recorded query and a killTree that only records the call.
 */
export interface SdkDeps {
  readonly query: QueryFn;
  readonly killTree: (pid: number) => Promise<void>;
  readonly env: NodeJS.ProcessEnv;
  readonly claudeBin?: string;
}

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: ImageMime; data: string } };

async function contentFor(input: TurnInput): Promise<ContentBlock[]> {
  const { text, imagePaths } = buildUserMessage(input);
  const blocks: ContentBlock[] = [];
  for (const p of imagePaths) {
    const up = input.uploads.find((u) => u.path === p)!;
    try {
      blocks.push({ type: "image", source: { type: "base64", media_type: up.mime as ImageMime, data: (await readFile(p)).toString("base64") } });
    } catch {
      // The path is still listed in the text; the model can Read it.
    }
  }
  blocks.push({ type: "text", text });
  return blocks;
}

class SdkSession implements AgentSession {
  pid: number | null = null;
  sessionId: ClaudeSessionId | null = null;
  private readonly input = new Pushable<SDKUserMessage>();
  private readonly out = new Pushable<AgentEvent>();
  private readonly q: SdkQuery;
  private readonly abort = new AbortController();
  private turn: { turnId: TurnId; interrupted: boolean; settle: () => void } | null = null;
  /** Resolvers the SDK's permission callback is blocked on, by ask id. Emptied with a denial whenever the turn ends. */
  private readonly asks = new Map<AskId, (answer: AskAnswer) => void>();
  /** Tool names an `allowTurn` answer covered; the callback allows them without asking until the turn settles. */
  private allowedThisTurn = new Set<string>();
  /** Command names the CLI tags as terminal-only; the phone menu hides them. */
  private terminalCommands: ReadonlySet<string> = new Set();
  private prevCostUsd = 0;
  /** The last main-thread message uuid of the turn in flight; the fork point turn.ended carries. */
  private lastUuid: MessageUuid | null = null;
  private dead = false;
  private killing: Promise<void> | null = null;

  get alive(): boolean {
    return !this.dead;
  }

  constructor(
    opts: SpawnOptions,
    private readonly deps: SdkDeps,
  ) {
    const options: Options = {
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      resume: opts.resume ?? undefined,
      // forkSession is set only for a fork: on a plain resume it would branch the thread's own session every spawn.
      ...(opts.forkAt === null ? {} : { forkSession: true, resumeSessionAt: opts.forkAt }),
      permissionMode: SDK_MODE[opts.permissionMode],
      // A consent flag, not a behavior: it lets a live setPermissionMode reach bypass in a session spawned in ask.
      allowDangerouslySkipPermissions: true,
      canUseTool: (toolName, input, o) => this.ask(toolName, input, o),
      settingSources: ["user", "project", "local"],
      additionalDirectories: [...opts.additionalDirectories],
      mcpServers: { helm: helmToolServer(opts.sendToPhone, opts.recordNote) },
      systemPrompt: { type: "preset", preset: "claude_code", append: opts.appendSystemPrompt },
      includePartialMessages: true,
      abortController: this.abort,
      env: Object.fromEntries(Object.entries(deps.env).filter((e): e is [string, string] => typeof e[1] === "string")),
      pathToClaudeCodeExecutable: deps.claudeBin,
      spawnClaudeCodeProcess: (o) => {
        const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true, signal: o.signal });
        this.pid = child.pid ?? null;
        child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[claude ${this.pid}] ${d}`));
        return child as unknown as SpawnedProcess;
      },
    };
    this.q = deps.query({ prompt: this.input, options });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      if (!this.killing) console.error(`[agent ${this.pid}] stream ended with error`, err);
    } finally {
      this.dead = true;
      if (this.turn) {
        this.out.push({ kind: "turn.ended", turnId: this.turn.turnId, outcome: "error", sessionId: this.sessionId, usage: null, error: "Claude Code session exited" });
        this.settleTurn();
      }
      this.out.end();
      this.input.end();
    }
  }

  private handle(msg: SDKMessage): void {
    if (msg.type === "system" && msg.subtype === "init" && Array.isArray(msg.terminal_slash_commands)) {
      this.terminalCommands = new Set(msg.terminal_slash_commands);
    }
    if ((msg.type === "assistant" || msg.type === "user") && msg.parent_tool_use_id === null && typeof msg.uuid === "string") this.lastUuid = msg.uuid as MessageUuid;
    const turnId = this.turn?.turnId ?? ("t:0" as TurnId);
    const events = agentMessageToEvents(turnId, msg, { interrupted: this.turn?.interrupted ?? false, prevCostUsd: this.prevCostUsd, lastUuid: this.lastUuid });
    if (msg.type === "result") this.prevCostUsd = msg.total_cost_usd;
    for (const ev of events) {
      if (ev.kind === "session.bound") this.sessionId = ev.sessionId;
      if (!this.turn && ev.kind !== "session.bound") continue; // nothing in flight; a stray frame has no home
      this.out.push(ev);
      if (ev.kind === "turn.ended") this.settleTurn();
    }
  }

  private settleTurn(): void {
    const t = this.turn;
    this.turn = null;
    this.allowedThisTurn = new Set();
    // Whatever the callback is still waiting on gets a denial, so the SDK never hangs on a turn that is over.
    for (const id of [...this.asks.keys()]) this.answer(id, { kind: "deny", reason: "turn ended" });
    t?.settle();
  }

  /** The SDK's permission callback: emit `ask.opened`, block until answer() or the turn's end, and forward the verdict verbatim. */
  private async ask(toolName: string, input: Record<string, unknown>, o: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const turn = this.turn;
    if (!turn) return { behavior: "deny", message: "turn ended" };
    const ask = askPayloadFrom(toolName, input, o);
    if (ask.kind === "tool" && this.allowedThisTurn.has(toolName)) return { behavior: "allow", updatedInput: input };
    const askId = randomUUID() as AskId;
    const answer = await new Promise<AskAnswer>((resolve) => {
      this.asks.set(askId, resolve);
      o.signal.addEventListener("abort", () => this.answer(askId, { kind: "deny", reason: "cancelled" }), { once: true });
      this.out.push({ kind: "ask.opened", turnId: turn.turnId, askId, ask });
    });
    if (ask.kind === "tool" && answer.kind === "allowTurn") this.allowedThisTurn.add(toolName);
    return permissionResultFor(ask, answer, input);
  }

  answer(askId: AskId, answer: AskAnswer): void {
    const resolve = this.asks.get(askId);
    this.asks.delete(askId);
    resolve?.(answer);
  }

  async send(input: TurnInput): Promise<void> {
    if (this.dead) throw new Error("session is dead");
    const content = await contentFor(input);
    this.lastUuid = null;
    const done = new Promise<void>((settle) => {
      this.turn = { turnId: input.turnId, interrupted: false, settle };
    });
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    return done;
  }

  async interrupt(): Promise<void> {
    if (!this.turn || this.dead) return;
    this.turn.interrupted = true;
    try {
      await this.q.interrupt();
    } catch (err) {
      console.error(`[agent ${this.pid}] interrupt failed`, err);
    }
  }

  async setModel(model: ModelId): Promise<void> {
    if (this.dead) return;
    await this.q.setModel(model);
  }

  async setEffort(effort: Effort): Promise<void> {
    if (this.dead) return;
    await this.q.applyFlagSettings({ effortLevel: effort });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.dead) return;
    await this.q.setPermissionMode(SDK_MODE[mode]);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.out;
  }

  async commands(): Promise<readonly SlashCommand[]> {
    if (this.dead) return [];
    return toSlashCommands(await this.q.supportedCommands(), this.terminalCommands);
  }

  async reloadSkills(): Promise<readonly SlashCommand[]> {
    if (this.dead) return [];
    return toSlashCommands((await this.q.reloadSkills()).skills, this.terminalCommands);
  }

  kill(): Promise<void> {
    if (!this.killing) {
      this.killing = (async () => {
        this.input.end();
        this.abort.abort();
        if (this.pid !== null) await this.deps.killTree(this.pid);
        this.q.close();
      })();
    }
    return this.killing;
  }
}

export class SdkAgentFactory implements AgentFactory {
  private catalog: Promise<readonly RawModel[]> | null = null;

  constructor(private readonly deps: SdkDeps) {}

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    return new SdkSession(opts, this.deps);
  }

  /** Spawn a throwaway process in `cwd`, ask it one question, close it. */
  private async probe<T>(cwd: string, ask: (q: SdkQuery) => Promise<T>): Promise<T> {
    const input = new Pushable<SDKUserMessage>();
    const q = this.deps.query({ prompt: input, options: { cwd, settingSources: ["user", "project", "local"], pathToClaudeCodeExecutable: this.deps.claudeBin, env: this.deps.env as Record<string, string> } });
    try {
      return await ask(q);
    } finally {
      input.end();
      q.close();
    }
  }

  /** Spawns a throwaway process once per server lifetime and asks it. Cached; the catalog changes only when the CLI is upgraded. */
  models(): Promise<readonly RawModel[]> {
    if (!this.catalog) {
      this.catalog = this.probe(homedir(), async (q) => {
        const infos: ModelInfo[] = await q.supportedModels();
        return infos.map((m) => ({ id: m.value, label: m.displayName, supportsEffort: m.supportsEffort === true, efforts: m.supportedEffortLevels ?? [] }));
      });
      this.catalog.catch(() => (this.catalog = null));
    }
    return this.catalog;
  }

  /**
   * The probe never reads the message stream, so it never sees `system.init`
   * and cannot know which commands are terminal-bound. A cold thread's menu
   * therefore carries a few entries a live one would hide; the first turn
   * replaces it with the filtered live list.
   */
  commands(cwd: string): Promise<readonly SlashCommand[]> {
    return this.probe(cwd, async (q) => toSlashCommands(await q.supportedCommands(), new Set()));
  }
}

/**
 * The model picker's options: the SDK's live catalog minus anything matching
 * MODEL_POLICY_DENY, keeping every effort level the SDK reports.
 * There is deliberately no fallback list: if the catalog cannot be read, the
 * picker shows an error rather than silently offering models that may not exist.
 */
export async function modelCatalog(factory: AgentFactory): Promise<readonly ModelChoice[]> {
  const raw = await factory.models();
  return raw
    .filter((m) => !MODEL_POLICY_DENY.some((re) => re.test(m.id)))
    .map((m) => {
      const efforts = EFFORTS.filter((e) => m.efforts.includes(e));
      return { id: m.id as ModelId, label: m.label, supportsEffort: m.supportsEffort && efforts.length > 0, efforts };
    });
}

/**
 * Validate a client-supplied model id against the live catalog. This is the
 * only place a raw string becomes a ModelId, per boundary-discipline.
 */
export function parseModelId(raw: unknown, catalog: readonly ModelChoice[]): ModelId | null {
  return typeof raw === "string" && catalog.some((c) => c.id === raw) ? (raw as ModelId) : null;
}
