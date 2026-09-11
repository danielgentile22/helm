/**
 * Adapter over @anthropic-ai/claude-agent-sdk. The rest of the server never
 * imports the SDK; it talks to AgentSession and consumes ThreadEventBody.
 *
 * One AgentSession = one long-lived Claude Code process in streaming-input
 * mode (query() with an AsyncIterable prompt), so successive turns reuse the
 * process, MCP servers stay warm, and interrupt() has a target between
 * SDK messages. Memory across process restarts comes from `resume`.
 *
 * VERIFIED against @anthropic-ai/claude-agent-sdk@0.3.268 (docs/SDK-FINDINGS.md).
 * Every capability this adapter depends on exists; none of the fallbacks the
 * candidate designs hedged with are needed:
 *   Query.streamInput(AsyncIterable<SDKUserMessage>)      sdk.d.ts:2941
 *   Query.interrupt() -> SDKControlInterruptResponse       sdk.d.ts:2625
 *   Query.setModel(model?)                                 sdk.d.ts:2659
 *   Query.supportedModels() -> ModelInfo[]                 sdk.d.ts:2763
 *   Options.spawnClaudeCodeProcess?: (o) => SpawnedProcess sdk.d.ts:2288
 *
 * Two consequences worth stating up front, because they delete design
 * complexity rather than add it:
 *
 * 1. A message sent while a turn is running is FOLDED INTO that turn by the
 *    CLI, not rejected and not merely queued behind it (sdk.d.ts:3351: "a user
 *    message folded into a meta turn takes the echo over ... the first reply
 *    frame after that fold carries the folded message's uuid"). So the phone
 *    and the laptop can both drive one thread, and a reply can be bound back
 *    to the send that caused it. Helm 1.0's 409-on-busy is not carried over.
 * 2. spawnClaudeCodeProcess lets us spawn the child ourselves with
 *    `detached: true`, so it leads its own process group and killTree keeps
 *    its real guarantee (grandchildren -- MCP servers, shell tools -- die with
 *    it). No pid-tree sweep fallback is needed.
 */

import type {
  ClaudeSessionId,
  Effort,
  ModelId,
  ModelChoice,
  StagedUpload,
  ThreadEventBody,
  TurnId,
} from "../../shared/protocol";

export interface SpawnOptions {
  readonly cwd: string;
  readonly model: ModelId;
  readonly effort: Effort;
  /** Present when we have a session to resume; absent on a brand-new thread. */
  readonly resume: ClaudeSessionId | null;
  /** `--add-dir` equivalents; from config, default ~/Projects ~/Desktop ~/Documents. */
  readonly additionalDirectories: readonly string[];
  /** Short phone-context appendix; never the vault. */
  readonly appendSystemPrompt: string;
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
      | "turn.ended";
  }
>;

export interface AgentSession {
  readonly pid: number | null;
  readonly sessionId: ClaudeSessionId | null;
  /**
   * Push a user turn onto the streaming input. Resolves when the turn's
   * `turn.ended` has been yielded on events(). Rejects only if the session is
   * dead; a model error is a `turn.ended {outcome: "error"}`, not a rejection.
   *
   * Sending while a turn is running is legal and is NOT an error: the CLI
   * folds the message into the running turn. The supervisor still logs an
   * `input.queued` first so both clients see it on the log before anything
   * acts on it.
   */
  send(input: TurnInput): Promise<void>;
  /**
   * Stop means stop. Issues interrupt({ cancel_queued: true }) so one round
   * trip aborts the running turn AND cancels anything queued behind it; the
   * SDK names this exact case ("a remote UI's Stop button", sdk.d.ts:4126).
   * Feature-detected via the `interrupt_cancel_queued_v1` capability on the
   * init message; older CLIs ignore the field and abort the turn only.
   * Idempotent, and a no-op when no turn is in flight.
   */
  interrupt(): Promise<void>;
  setModel(model: ModelId): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  /** Ordered stream of AgentEvent for the life of the process. Ends when the process exits. */
  events(): AsyncIterable<AgentEvent>;
  /** SIGTERM the group, SIGKILL after 10 s, settle once. Idempotent. */
  kill(): Promise<void>;
}

export interface AgentFactory {
  spawn(opts: SpawnOptions): Promise<AgentSession>;
}

/**
 * Pure mapper from an SDK message to zero or more AgentEvents. This is the
 * boundary where the SDK's shape is parsed and trusted types begin. Kept pure
 * so it is unit-testable against recorded SDK fixtures with no API spend.
 *
 * Mapping (verify names against the installed SDK):
 *   system.init                          -> session.bound
 *   stream_event content_block_delta text -> assistant.text (blockIx from content_block index)
 *   stream_event ... thinking_delta      -> assistant.thinking
 *   assistant message tool_use block     -> tool.started (input truncated)
 *   user message tool_result block       -> tool.finished (output truncated)
 *   result                               -> turn.ended (outcome from subtype; usage mapped)
 *   everything else                      -> []
 */
export function agentMessageToEvents(turnId: TurnId, sdkMessage: unknown): readonly AgentEvent[] {
  throw new Error("not implemented");
}

/**
 * Build the SDK user message for a turn. Images become image content blocks
 * so the model sees them; every upload (images included) is also listed by
 * absolute path in a trailing line so the model can Read/mv it.
 */
export function buildUserMessage(input: TurnInput): { text: string; imagePaths: readonly string[] } {
  // TODO: if uploads.length: text += "\n\nAttached files (absolute paths on this Mac):\n" + uploads.map(u => `- ${u.path} (${u.mime}, ${u.bytes} B)`).join("\n")
  throw new Error("not implemented");
}

/** The only system-prompt addition Helm makes. Deliberately short; no vault preload. */
export const PHONE_APPENDIX =
  "You are being driven from a phone via Helm. Reply tightly; prefer doing the task over narrating it. " +
  "Paths you mention should be absolute. Do not paste large files back; say what you changed.";

export class SdkAgentFactory implements AgentFactory {
  constructor(private readonly deps: { claudeBin?: string; env: NodeJS.ProcessEnv }) {}
  spawn(opts: SpawnOptions): Promise<AgentSession> {
    // TODO: const input = new PushableAsyncIterable<SDKUserMessage>();
    //       const q = query({ prompt: input, options: { cwd, model: opts.model, resume: opts.resume ?? undefined,
    //         permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
    //         spawnClaudeCodeProcess: (o) => spawn(o.command, o.args, { ...o, detached: true }),
    //         additionalDirectories, appendSystemPrompt, includePartialMessages: true, abortController } });
    //       wrap q in an SdkSession that: assigns a fresh AbortController per process, maps messages via
    //       agentMessageToEvents with the current turnId, guarantees one turn.ended per send() (timer-free:
    //       a process exit mid-turn synthesizes turn.ended {error}), and exposes kill() via util/killTree.
    throw new Error("not implemented");
  }
}

/**
 * The model picker's options: the SDK's live catalog minus anything matching
 * MODEL_POLICY_DENY, with each row's effort levels clamped to EFFORT_CEILING.
 *
 * VERIFIED against @anthropic-ai/claude-agent-sdk@0.3.268:
 *   Query.supportedModels(): Promise<ModelInfo[]>   (sdk.d.ts:2763)
 *   ModelInfo carries per-model effort support       (sdk.d.ts:1294-1298)
 *
 * Cache the result for the process lifetime; it changes only when the CLI is
 * upgraded, and a stale-by-one-restart catalog is harmless. There is
 * deliberately no fallback list: if the catalog cannot be read, the picker
 * shows an error rather than silently offering models that may not exist.
 */
export async function modelCatalog(factory: AgentFactory): Promise<readonly ModelChoice[]> {
  // TODO: open (or reuse) a throwaway query, call supportedModels(), map
  //       ModelInfo -> ModelChoice, drop ids matching MODEL_POLICY_DENY,
  //       intersect each row's effort levels with EFFORT_CEILING.
  throw new Error("not implemented");
}

/**
 * Validate a client-supplied model id against the live catalog. This is the
 * only place a raw string becomes a ModelId, per boundary-discipline.
 */
export function parseModelId(raw: unknown, catalog: readonly ModelChoice[]): ModelId | null {
  // TODO: typeof raw === "string" && catalog.some(c => c.id === raw) ? raw as ModelId : null
  throw new Error("not implemented");
}
