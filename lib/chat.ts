import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Pure chat-route logic — everything /api/chat does that DOESN'T spawn claude
// or touch the filesystem. Extracted here so it can be exercised with no API
// spend (scripts/test-chat.ts) and so the route stays a thin I/O shell.
// No VAULT_ROOT import on purpose: keep this module side-effect-free so the
// test needs no env. The route owns the vault paths + the spawn.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-sonnet-4-6"; // chat default: fast + cheap, fully vault-capable
// Mirror of runner.js MODEL_ALLOWLIST — "use opus" rides in as the request's model.
export const MODEL_ALLOWLIST = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
]);
export const MAX_MESSAGE = 8000;
export const HARD_TIMEOUT_MS = 5 * 60_000; // a chat turn that runs longer is wedged

// Chat-scoped policy appended to the default system prompt (which still loads
// the vault's CLAUDE.md). Kept HERE, not in the shared vault CLAUDE.md, so it
// only shapes chat — the runner's task skills are untouched. Makes chat behave
// like a conversation, not a one-shot "SAVED <path>" task run, and restates the
// two read-only areas (Morphy board + system/ caches) in chat's voice.
export const CHAT_SYSTEM = [
  "You are HELM, Daniel's personal assistant, answering an interactive chat from his phone or laptop.",
  "This is a conversation, not a one-shot task: reply directly and concisely in plain text (it renders in a small chat bubble) — no markdown headers, no file paths, no 'SAVED ...' lines.",
  "You're running inside his Obsidian vault: read freely, and when he asks you to capture or change something, edit the relevant note (daily-notes/, inbox/, Atlas/) directly.",
  "Two read-only areas: (1) the Morphy board — answer from system/morphy-state.json and NEVER modify Morphy tasks or the generated Atlas/Projects/Morphy snapshot; to change tasks, tell him to use the board. (2) system/ caches (agenda, metrics, runs) are machine-generated — don't hand-edit them.",
  "Carry the thread across turns.",
].join(" ");

/** Pick the request's model if it's allowlisted, else the default. */
export function modelFor(m: unknown): string {
  return typeof m === "string" && MODEL_ALLOWLIST.has(m) ? m : DEFAULT_MODEL;
}

/** Validate + normalize the user message. Returns the trimmed message or the
 *  HTTP error the route should send (400 empty, 413 too long). */
export function validateMessage(
  raw: unknown
): { ok: true; message: string } | { ok: false; error: string; status: number } {
  const message = String(raw ?? "").trim();
  if (!message) return { ok: false, error: "empty message", status: 400 };
  if (message.length > MAX_MESSAGE) return { ok: false, error: "message too long", status: 413 };
  return { ok: true, message };
}

/** Keep a valid client threadId; otherwise mint a fresh one. The shape also
 *  matches a UUID, so a new thread and a resumed thread look identical. */
export function resolveThreadId(id: unknown): string {
  return typeof id === "string" && /^[a-f0-9-]{8,40}$/i.test(id) ? id : randomUUID();
}

// claude --output-format json prints one JSON object; be tolerant of stray
// lines and grab the last {...} block if a straight parse fails.
export function parseClaudeJson(
  stdout: string
): { result?: string; session_id?: string; total_cost_usd?: number; is_error?: boolean } | null {
  try {
    return JSON.parse(stdout);
  } catch {
    const m = stdout.match(/\{[\s\S]*\}\s*$/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

// ponytail: per-process lock, not per-thread-durable. `claude --resume` is not
// safe to run twice against the same session concurrently — reject the second.
// Survives restarts as "unlocked", which is correct: a crashed turn frees it.
const busy = new Set<string>();

/** True if the lock was taken; false if a turn is already running on the thread. */
export function acquireThread(threadId: string): boolean {
  if (busy.has(threadId)) return false;
  busy.add(threadId);
  return true;
}

export function releaseThread(threadId: string): void {
  busy.delete(threadId);
}
