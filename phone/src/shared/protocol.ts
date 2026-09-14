/**
 * Wire vocabulary shared by server and client. Nothing in here touches the
 * filesystem, the SDK, or the DOM. If a type is not needed on both sides it
 * does not belong here.
 *
 * The one coordinate the whole system agrees on is `Seq`: a per-thread,
 * contiguous, 1-based integer minted only by ThreadLog.append. A cursor is a
 * Seq you have already seen (or 0 for "nothing yet").
 */

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** Per-thread event sequence number. Contiguous from 1. Only the log mints these. */
export type Seq = Brand<number, "Seq">;
/** Position after which a client wants events. 0 means "from the beginning". */
export type Cursor = Seq | 0;
/** UUID-like (8 to 40 hex chars or dashes). The client may mint it; a malformed one is replaced, not rejected. */
export type ThreadId = Brand<string, "ThreadId">;
/** Minted at the `turn.started` append; equals `t:<seq of that append>`. */
export type TurnId = Brand<string, "TurnId">;

/** `t:<seq>` of the turn.started event; derivable from the log so a TurnId can never dangle. The one place the spelling lives. */
export function turnIdFor(seq: Seq): TurnId {
  return `t:${seq}` as TurnId;
}

export function seqOfTurnId(id: TurnId): Seq | null {
  const m = id.match(/^t:(\d+)$/);
  return m ? (Number(m[1]) as Seq) : null;
}
/** Client-minted idempotency key for send(). */
export type ClientMsgId = Brand<string, "ClientMsgId">;
/** Claude Code session id, as reported by the SDK's `system.init` message. */
export type ClaudeSessionId = Brand<string, "ClaudeSessionId">;
export type UploadId = Brand<string, "UploadId">;
/** UUID minted when the model offers a file to the phone. */
export type FileId = Brand<string, "FileId">;
export type ToolUseId = Brand<string, "ToolUseId">;
/** Minted by the adapter when Claude Code asks something mid-turn; echoed by the answer route. */
export type AskId = Brand<string, "AskId">;

// ---------------------------------------------------------------------------
// Thread config (user-set inputs, stored in thread.json, not derived)
// ---------------------------------------------------------------------------

/**
 * A concrete Claude model id, e.g. "claude-opus-5". NOT a closed union: the
 * live catalog comes from the SDK's `Query.supportedModels()` and is validated
 * at the HTTP boundary against it (per boundary-discipline).
 *
 * Helm 1.0 hardcoded an allowlist ("claude-sonnet-4-6", "claude-opus-4-8",
 * "claude-haiku-4-5-...") and it rotted into uselessness within months. The
 * lesson is encoded as a call, not a comment: there is nowhere to put a stale
 * list, because the list is asked for at runtime.
 */
export type ModelId = Brand<string, "ModelId">;

/** One row of the live catalog, as offered to the model picker. */
export interface ModelChoice {
  readonly id: ModelId;
  readonly label: string;
  readonly supportsEffort: boolean;
  /** Effort levels this model accepts, exactly as Claude Code reports them. */
  readonly efforts: readonly Effort[];
}

/**
 * Policy filter applied to the live catalog. Daniel's standing rule is "never
 * Haiku"; matching on the id keeps the rule true for future Haiku releases
 * without another edit here. The "default" alias is dropped too: it resolves
 * to whatever Claude Code currently recommends, and a thread should record
 * the model it actually ran on.
 */
export const MODEL_POLICY_DENY: readonly RegExp[] = [/haiku/i, /^default$/];

/** Every level Claude Code knows. The catalog offers the subset each model supports. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: Effort = "medium";

/**
 * One entry in the slash-command menu: a built-in command or a discovered
 * skill, as Claude Code reports it. The list is per-cwd (skills are found
 * relative to the working directory) and can change mid-session, so it is
 * asked for rather than stored.
 */
export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  /** e.g. "<plan>". Empty when the command takes no argument. */
  readonly argumentHint: string;
}

/**
 * Server-wide preferences, in <HELM_HOME>/settings.json. These seed a new
 * thread; they never change one that already exists, whose own ThreadConfig
 * is the record of what it actually ran on.
 */
export interface HelmSettings {
  readonly theme: "system" | "light" | "dark";
  /** null means "no preference": the picker opens with nothing chosen. */
  readonly defaultModel: ModelId | null;
  readonly defaultEffort: Effort;
  /** Absolute path to an existing directory. */
  readonly defaultCwd: string;
  /** Seeds new threads outside the vault; a thread in the vault root always starts in `bypass`. */
  readonly defaultPermissionMode: PermissionMode;
}

export const THEMES: readonly HelmSettings["theme"][] = ["system", "light", "dark"];

export type SettingsPatch = Partial<HelmSettings>;

/**
 * Whether a turn may pause to ask before a gated tool call. `ask` runs Claude
 * Code's default permission rules and forwards every prompt to the phone;
 * `bypass` is the pre-gate behavior, everything runs. Thread config, so a
 * vault chore and a repo can differ.
 */
export type PermissionMode = "ask" | "bypass";
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "bypass"];

export interface ThreadConfig {
  readonly threadId: ThreadId;
  /** Absolute path. Determines which CLAUDE.md Claude Code discovers. */
  readonly cwd: string;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly permissionMode: PermissionMode;
  /** null until the server titles it from the first turn. */
  readonly title: string | null;
  readonly createdAt: string; // ISO
  readonly archivedAt: string | null;
}

export type ThreadConfigPatch = Partial<Pick<ThreadConfig, "model" | "effort" | "title" | "permissionMode">>;

// ---------------------------------------------------------------------------
// Asks: a turn pausing on the user
// ---------------------------------------------------------------------------

export interface AskOption {
  readonly label: string;
  readonly description: string;
}

/** One question of an AskUserQuestion call. Free text is always accepted; the SDK adds "Other" itself. */
export interface AskQuestion {
  readonly question: string;
  /** Chip text, at most a dozen characters. */
  readonly header: string;
  readonly options: readonly AskOption[];
  readonly multiSelect: boolean;
}

/**
 * What Claude Code is waiting on. A tool ask carries the same name and
 * (truncated) input a `tool.started` does, so the card and the list row name
 * it through toolSummary; `title` is the sentence the SDK rendered when it
 * had one ("Claude wants to run npm test").
 */
export type AskPayload =
  | { readonly kind: "tool"; readonly toolName: string; readonly input: unknown; readonly toolUseId: ToolUseId; readonly title: string | null; readonly description: string | null }
  | { readonly kind: "question"; readonly questions: readonly AskQuestion[] };

/** One question's answer: the labels picked, or typed text when no option fit. */
export type QuestionAnswer = { readonly kind: "options"; readonly labels: readonly string[] } | { readonly kind: "text"; readonly text: string };

export type AskAnswer =
  | { readonly kind: "allow" }
  /** Allow, and do not ask again for this tool name until the turn ends. */
  | { readonly kind: "allowTurn" }
  | { readonly kind: "deny"; readonly reason: string | null }
  /** One entry per question, in the order asked. */
  | { readonly kind: "answers"; readonly answers: readonly QuestionAnswer[] };

/**
 * Who settled an ask. A person answered through a device; the system answered
 * on their behalf when the request could no longer be waited on (`interrupted`,
 * `archived`), when the server rebooted with the turn open (`restart`), when
 * the Claude Code process died under it (`exited`), or when
 * Claude Code decided without asking (`rule`: a deny rule or classifier). A
 * system answer is always a denial, which is how expiry stays distinct from a
 * person's "Deny" in the transcript.
 */
export type AskSystemReason = "interrupted" | "restart" | "exited" | "archived" | "rule";
export type AskAnsweredBy = { readonly by: "user"; readonly origin: Origin } | { readonly by: "system"; readonly reason: AskSystemReason };

export interface AnswerRequest {
  readonly askId: string;
  readonly answer: AskAnswer;
}

/** The shape of `ask.opened` and `ask.answered`, reused by the log head and the phone's pending set. */
export interface PendingAsk {
  readonly askId: AskId;
  readonly turnId: TurnId;
  readonly ask: AskPayload;
}

/** Whether an answer has the shape the ask can take: a question takes answers or deny, a tool takes anything but answers. */
export function answerFits(ask: AskPayload, answer: AskAnswer): boolean {
  return ask.kind === "question" ? answer.kind === "answers" || answer.kind === "deny" : answer.kind !== "answers";
}

/** One question's answer in words: the labels picked, or the text typed. The SDK, the mirror and the card all say it this way. */
export function answerPhrase(a: QuestionAnswer): string {
  return a.kind === "options" ? a.labels.join(", ") : a.text;
}

/**
 * The one line a push, a list row, and a mirror line say about an ask: what
 * tool or what question. Shared so the three agree.
 */
export function askSummary(ask: AskPayload): string {
  if (ask.kind === "question") return ask.questions[0]?.question ?? "Question";
  if (ask.title) return tidy(ask.title).slice(0, 160);
  const { label, arg } = toolSummary(ask.toolName, ask.input);
  return arg ? `${label} ${arg}` : label;
}

// ---------------------------------------------------------------------------
// Events: the whole vocabulary of the system
// ---------------------------------------------------------------------------

/** Who caused a turn. Rendered as the prompt prefix, e.g. `[iphone] >`. */
export interface Origin {
  readonly via: "pwa" | "key"; // cookie session vs static API key
  readonly label: string; // "iphone", "laptop", "curl"; free text from the client
}

export interface StagedUpload {
  readonly uploadId: UploadId;
  /** Absolute path on the Mac where the file now lives. */
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
}

/**
 * A file on the Mac the model offered to the phone via the `send_to_phone`
 * tool. The path is live, not a copy: the download route stats it on every
 * request, so a moved file is an honest 404 rather than a stale snapshot.
 */
export interface OfferedFile {
  readonly fileId: FileId;
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  /** The model's one-line reason, or null. */
  readonly note: string | null;
}

export type TurnOutcome =
  | "ok"
  | "interrupted"
  | "error"
  /** Server restarted while this turn was open; appended by boot recovery. */
  | "orphaned";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number | null;
  /** Approximate context size after this turn (input + cache read). The UI's "ctx 48k" meter. */
  readonly contextTokens: number;
  /** Denominator for the context meter. Optional: log lines written before it was recorded lack it. */
  readonly contextWindow?: number;
  readonly durationMs: number;
}

/**
 * What a thread is doing right now, for the thread list. Derived from the
 * head on every read and never stored, so it cannot go stale.
 */
export type DoingNow =
  | { kind: "tool"; name: string; arg: string }
  /** The tail of the last thing the model said, when no tool is in flight. */
  | { kind: "text"; tail: string };

/** Tokens summed over every turn of a thread. No cost: the SDK reports it cumulatively per process, which does not add up across restarts. */
export interface UsageTotal {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/** The running total after one more turn; the server's head and the phone's fold agree by sharing it. */
export function addUsage(total: UsageTotal | null, u: Usage): UsageTotal {
  return {
    inputTokens: (total?.inputTokens ?? 0) + u.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + u.outputTokens,
    cacheReadTokens: (total?.cacheReadTokens ?? 0) + u.cacheReadTokens,
    cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
  };
}

/**
 * Event bodies. Every variant is a fact that happened; nothing here is a
 * command. Client folds these; server projections (mirror, push) read these.
 */
export type ThreadEventBody =
  | { kind: "thread.created"; config: ThreadConfig }
  | { kind: "thread.config"; patch: ThreadConfigPatch; origin: Origin }
  | { kind: "thread.archived" }
  /** The SDK reported its session id. Repeated on every spawn; last one wins. */
  | { kind: "session.bound"; sessionId: ClaudeSessionId }
  | {
      kind: "input.queued";
      clientMsgId: ClientMsgId;
      text: string;
      uploads: readonly StagedUpload[];
      origin: Origin;
    }
  /** A queued input that will never run (server restart). Client offers resend. */
  | { kind: "input.dropped"; clientMsgId: ClientMsgId; reason: "restart" | "archived" }
  | {
      kind: "turn.started";
      turnId: TurnId;
      clientMsgId: ClientMsgId;
      model: ModelId;
      effort: Effort;
      /** True when the process was spawned (cold/parked) rather than reused. */
      spawned: boolean;
    }
  /** Coalesced over ~40 ms by the writer. blockIx orders text blocks within a turn. */
  | { kind: "assistant.text"; turnId: TurnId; blockIx: number; delta: string }
  | { kind: "assistant.thinking"; turnId: TurnId; delta: string }
  | {
      kind: "tool.started";
      turnId: TurnId;
      toolUseId: ToolUseId;
      name: string;
      /** JSON input, truncated by the adapter to TOOL_INPUT_MAX bytes. */
      input: unknown;
    }
  | {
      kind: "tool.finished";
      turnId: TurnId;
      toolUseId: ToolUseId;
      /** Truncated to TOOL_OUTPUT_MAX bytes; the client shows "..." and a byte count. */
      output: string;
      isError: boolean;
    }
  | {
      kind: "turn.ended";
      turnId: TurnId;
      outcome: TurnOutcome;
      /** Carried here so ThreadHead can be derived from the last turn boundary alone. */
      sessionId: ClaudeSessionId | null;
      usage: Usage | null;
      /** Human-readable, already scrubbed of paths and stack traces. */
      error: string | null;
      /**
       * The SDK uuid of the turn's last message, where a fork of this thread
       * resumes (the SDK forks at the kept turn's last chain entry). Absent on
       * turns logged before forking existed and on turns that produced no
       * message; a fork from such a turn starts Claude fresh.
       */
      forkPoint?: string;
    }
  /**
   * This thread began as a copy of another, up to and including `atTurn`
   * there. Everything before this event in the log is that copy, re-stamped
   * with this log's seqs and the original timestamps. `resume` names the
   * source session and the message the fork's first turn resumes at; null
   * when the source turn recorded no fork point, so Claude starts here with
   * no memory of the copied turns.
   */
  | { kind: "thread.forked"; from: ThreadId; fromTitle: string | null; atTurn: TurnId; resume: { sessionId: ClaudeSessionId; at: string } | null }
  /** Someone forked this thread at `atTurn`; the copy lives in `to`. Never copied into a further fork. */
  | { kind: "thread.forked.out"; to: ThreadId; toTitle: string; atTurn: TurnId }
  | { kind: "upload.staged"; upload: StagedUpload; origin: Origin }
  /** Appended by the tool handler, not the agent stream, so it is not tied to a turn. */
  | { kind: "file.offered"; file: OfferedFile; origin: Origin }
  /** Claude Code paused on the user. Pending until an `ask.answered` with the same askId; the turn's end implies one. */
  | { kind: "ask.opened"; turnId: TurnId; askId: AskId; ask: AskPayload }
  | { kind: "ask.answered"; turnId: TurnId; askId: AskId; answer: AskAnswer; by: AskAnsweredBy };

export type EventKind = ThreadEventBody["kind"];

/** One line of events.jsonl and one SSE `data:` frame. */
export type ThreadEvent = ThreadEventBody & {
  readonly seq: Seq;
  readonly ts: string; // ISO
};

export type EventOf<K extends EventKind> = Extract<ThreadEvent, { kind: K }>;

// ---------------------------------------------------------------------------
// Control frames on the SSE stream (never logged, never carry a seq)
// ---------------------------------------------------------------------------

/**
 * Sent once at attach, after replay, before going live. Tells the client
 * where the head is so it can show "replaying" vs "live", and whether the
 * process is currently doing anything. `event: sync` on the wire.
 */
export interface SyncFrame {
  readonly headSeq: Cursor;
  readonly session: "cold" | "warming" | "idle" | "running" | "parked";
  readonly openTurn: TurnId | null;
  readonly queuedCount: number;
}

// ---------------------------------------------------------------------------
// HTTP request/response shapes
// ---------------------------------------------------------------------------

export interface CreateThreadRequest {
  readonly threadId?: string; // client may mint; server validates or replaces
  readonly cwd: string;
  readonly model: ModelId;
  readonly effort: Effort;
  readonly title?: string | null;
  /** Absent: bypass in the vault root, else the server's default. */
  readonly permissionMode?: PermissionMode;
}

/** POST /api/threads/:id/fork. The turn must have ended; the reply is the new thread's summary. Two calls make two forks. */
export interface ForkRequest {
  readonly turnId: string;
}

export interface SendRequest {
  readonly clientMsgId: string;
  readonly text: string;
  readonly uploadIds?: readonly string[];
  readonly label?: string; // Origin.label
}

export type SendResponse =
  | { accepted: true; state: "running" | "queued"; seq: Seq }
  /** Same clientMsgId seen before: returns the original outcome, does nothing. */
  | { accepted: true; state: "duplicate"; seq: Seq }
  | { accepted: false; error: string };

export interface ThreadSummary {
  readonly config: ThreadConfig;
  readonly headSeq: Cursor;
  readonly session: SyncFrame["session"];
  readonly lastTurnEndedAt: string | null;
  /** How the last turn ended, so the thread list can mark a failure without reading events. */
  readonly lastOutcome: TurnOutcome | null;
  readonly contextTokens: number | null;
  /** First ~120 chars of the last assistant text; for the thread list. */
  readonly preview: string | null;
  readonly doing: DoingNow | null;
  readonly usageTotal: UsageTotal | null;
  readonly contextWindow: number | null;
  /** A turn is open and blocked on an unanswered ask. Distinct from running: the process is waiting, not working. */
  readonly waiting: boolean;
}

/** Where a search term matched inside a snippet: `[start, end)` offsets, so the client draws the highlight and the server sends no markup. */
export type MatchRange = readonly [start: number, end: number];

/** Sorted and non-overlapping. Touching ranges stay separate: two adjacent hits are two hits. */
export function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: MatchRange[] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start < last[1]) out[out.length - 1] = [last[0], Math.max(last[1], end)];
    else out.push([start, end]);
  }
  return out;
}

/** One thread in a search result. `seq` is the turn boundary of the best matching turn, or null when only the title matched. */
export interface SearchHit {
  readonly summary: ThreadSummary;
  readonly seq: Seq | null;
  readonly snippet: string;
  readonly ranges: readonly MatchRange[];
}

export interface DirEntry {
  readonly name: string;
  readonly path: string;
  readonly hasClaudeMd: boolean;
  readonly isGitRepo: boolean;
}

export interface PushPayload {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly body: string;
  /** How the turn ended, or `ask` when a request is waiting on the user; styled by kind rather than by parsing the body. */
  readonly kind: TurnOutcome | "ask";
  readonly seq: Seq;
  readonly url: string; // `/t/<threadId>#end`
}

// ---------------------------------------------------------------------------
// Limits (enforced at HTTP boundary; documented here so the client agrees)
// ---------------------------------------------------------------------------

export const LIMITS = {
  MESSAGE_CHARS: 32_000,
  SEND_BODY_BYTES: 128 * 1024,
  UPLOAD_BYTES: 50 * 1024 * 1024,
  /** Largest file the model may offer to the phone. */
  OFFER_BYTES: 50 * 1024 * 1024,
  TOOL_INPUT_MAX: 4 * 1024,
  TOOL_OUTPUT_MAX: 16 * 1024,
  DELTA_COALESCE_MS: 40,
  /** A deny reason or a free-text answer to a question. */
  ANSWER_CHARS: 2_000,
  SSE_HEARTBEAT_MS: 15_000,
  IDLE_PARK_MS: 30 * 60_000,
} as const;

/** "2.4 MB", "512 KB", "17 B". Decimal units, as the Files app on iOS shows them. Shared so the card and the vault note agree. */
export function fmtBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const kb = n / 1000;
  if (kb < 1000) return `${Math.round(kb)} KB`;
  const mb = kb / 1000;
  if (mb < 1000) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Tool summaries
// ---------------------------------------------------------------------------

export type ToolCategory = "read" | "run" | "edit" | "other";

export interface ToolSummary {
  readonly label: string;
  readonly arg: string;
  readonly category: ToolCategory;
}

/** One row per tool: which input field a human would name, and what kind of work it is. */
const TOOLS: Readonly<Record<string, { field: string; category: ToolCategory }>> = {
  Bash: { field: "command", category: "run" },
  Read: { field: "file_path", category: "read" },
  Edit: { field: "file_path", category: "edit" },
  Write: { field: "file_path", category: "edit" },
  MultiEdit: { field: "file_path", category: "edit" },
  NotebookEdit: { field: "notebook_path", category: "edit" },
  Grep: { field: "pattern", category: "read" },
  Glob: { field: "pattern", category: "read" },
  LS: { field: "path", category: "read" },
  ToolSearch: { field: "query", category: "read" },
  WebFetch: { field: "url", category: "read" },
  WebSearch: { field: "query", category: "read" },
  Agent: { field: "description", category: "other" },
  Skill: { field: "skill", category: "other" },
};

const ARG_CHARS = 80;
/** Shared code cannot read node:os, so the home directory is matched by shape instead. */
const HOME = /\/(?:Users|home)\/[^/]+/gu;

/** Collapse runs of whitespace and shorten the home directory, so one line holds as much meaning as it can. */
export function tidy(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(HOME, "~");
}

/** `mcp__<server>__<tool>` reads as `<server>:<tool>`; null for an ordinary name. */
function mcpLabel(name: string): string | null {
  if (!name.startsWith("mcp__")) return null;
  const [server, ...rest] = name.slice("mcp__".length).split("__");
  if (!server || rest.length === 0) return null;
  return `${server}:${rest.join("__")}`;
}

function firstString(input: Record<string, unknown>): string {
  for (const v of Object.values(input)) if (typeof v === "string") return v;
  return "";
}

/**
 * The label, salient argument and kind of work of a tool call. Shared so the
 * thread list, the transcript and the vault mirror name a call the same way.
 * The argument falls back to the first string field, so an unknown MCP tool
 * still says something.
 */
export function toolSummary(name: string, input: unknown): ToolSummary {
  const label = mcpLabel(name) ?? name;
  const row = TOOLS[name];
  const category = row?.category ?? "other";
  if (typeof input !== "object" || input === null) return { label, arg: "", category };
  const rec = input as Record<string, unknown>;
  const direct = row === undefined ? undefined : rec[row.field];
  const raw = typeof direct === "string" ? direct : firstString(rec);
  return { label, arg: tidy(raw).slice(0, ARG_CHARS), category };
}
