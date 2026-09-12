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
/** UUID; client may mint it (see resolveThreadId in server/core/ids.ts). */
export type ThreadId = Brand<string, "ThreadId">;
/** Minted at the `turn.started` append; equals `t:<seq of that append>`. */
export type TurnId = Brand<string, "TurnId">;
/** Client-minted idempotency key for send(). */
export type ClientMsgId = Brand<string, "ClientMsgId">;
/** Claude Code session id, as reported by the SDK's `system.init` message. */
export type ClaudeSessionId = Brand<string, "ClaudeSessionId">;
export type UploadId = Brand<string, "UploadId">;
export type ToolUseId = Brand<string, "ToolUseId">;

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
}

export const THEMES: readonly HelmSettings["theme"][] = ["system", "light", "dark"];

export type SettingsPatch = Partial<HelmSettings>;

export interface ThreadConfig {
  readonly threadId: ThreadId;
  /** Absolute path. Determines which CLAUDE.md Claude Code discovers. */
  readonly cwd: string;
  readonly model: ModelId;
  readonly effort: Effort;
  /** null until the server titles it from the first turn. */
  readonly title: string | null;
  readonly createdAt: string; // ISO
  readonly archivedAt: string | null;
}

export type ThreadConfigPatch = Partial<Pick<ThreadConfig, "model" | "effort" | "title">>;

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
    }
  | { kind: "upload.staged"; upload: StagedUpload; origin: Origin };

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
  readonly contextTokens: number | null;
  /** First ~120 chars of the last assistant text; for the thread list. */
  readonly preview: string | null;
  readonly doing: DoingNow | null;
  readonly usageTotal: UsageTotal | null;
  readonly contextWindow: number | null;
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
  /** How the turn ended, so the notification can be styled by outcome rather than by parsing the body. */
  readonly kind: TurnOutcome;
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
  TOOL_INPUT_MAX: 4 * 1024,
  TOOL_OUTPUT_MAX: 16 * 1024,
  DELTA_COALESCE_MS: 40,
  SSE_HEARTBEAT_MS: 15_000,
  IDLE_PARK_MS: 30 * 60_000,
} as const;
