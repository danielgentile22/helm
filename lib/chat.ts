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

// Skills chat may dispatch to the runner's queue — a subset of lib/skills
// ALLOWED_SKILLS (test-skill-contract.ts asserts the coupling). voice-ask and
// the morphy-* natives stay out: chat IS the conversation, and the Morphy
// paragraph below already routes board changes to Notion.
export const CHAT_SKILLS = [
  "morning-report",
  "inbox-brief",
  "plan-today",
  "plan-tomorrow",
  "vault-cleanup",
  "weekly-review",
];

// Chat-scoped policy appended to the default system prompt (which still loads
// the vault's CLAUDE.md). Kept HERE, not in the shared vault CLAUDE.md, so it
// only shapes chat — the runner's task skills are untouched. Makes chat behave
// like a conversation, not a one-shot "SAVED <path>" task run, and restates the
// two read-only areas (Morphy board + system/ caches) in chat's voice.
//
// Dispatch is NOT a sanctioned file write anymore (ADR-0009): the model emits a
// `DISPATCH <skill>` sentinel line and route code — not model obedience —
// validates it against CHAT_SKILLS before calling writeIntent. So a prompt
// injection in vault/web content the chat reads can ask for `voice-ask` via the
// sentinel all it likes; parseDispatch() drops anything outside CHAT_SKILLS and
// route code always writes args={}.
//
// ponytail: this closes the SANCTIONED path only. The `claude -p` child still
// runs --dangerously-skip-permissions in the vault, so an injection can order
// it to Write a raw system/queue/<uuid>.json (any ALLOWED_SKILLS skill, any
// args), bypassing this validation entirely. No in-process guard fixes that —
// the child has full FS read, so any signing secret is readable too. True
// isolation needs an OS sandbox / separate uid for the child (follow-up ticket,
// out of scope for #16); tracked so it isn't mistaken for closed.
export function chatSystem(chatOnly = false): string {
  const dispatch = chatOnly
    ? // On the tailnet VM (CHAT_ONLY=1) there is no runner to reach — don't
      // promise a queue we can't deliver; point him at the Mac instead.
      `You are running on the tailnet VM, which cannot reach the runner. If he asks you to RUN a skill (${CHAT_SKILLS.join(", ")}), do NOT claim it's queued — tell him to dispatch it from the Mac HUD deck or by voice. You can still read any existing report or plan from the vault.`
    : `When he explicitly asks you to RUN a skill ('run my morning report', 'kick off the weekly review' — a dispatch, not a question about what a past report said), emit the line "DISPATCH <skill>" on its own line with nothing else on it, then tell him it's queued and takes a few minutes — reports land under inbox/reports/, plans in daily-notes/. Skills you may dispatch: ${CHAT_SKILLS.join(", ")}. That sentinel line is the ONLY way you queue work — never write a file under system/ yourself. If he asks about a report's CONTENTS, read the existing file instead of dispatching.`;
  return [
    "You are HELM, Daniel's personal assistant, answering an interactive chat from his phone or laptop.",
    "This is a conversation, not a one-shot task: reply directly and concisely in plain text (it renders in a small chat bubble) — no markdown headers, no file paths, no 'SAVED ...' lines.",
    "You're running inside his Obsidian vault: read freely, and when he asks you to capture or change something, edit the relevant note (daily-notes/, inbox/, Atlas/) directly.",
    "Two read-only areas: (1) the Morphy board — answer from system/morphy-state.json and NEVER modify Morphy tasks or the generated Atlas/Projects/Morphy snapshot; to change tasks, tell him to use the board. (2) system/ caches (agenda, metrics, runs) are machine-generated — don't hand-edit them.",
    dispatch,
    "Carry the thread across turns.",
  ].join(" ");
}

// A dispatch sentinel: `DISPATCH` at line start, then the skill token. The
// route strips these lines before showing the reply, so the user never sees
// the machine token. Anchored + single-token so ordinary prose can't fire it.
const DISPATCH_RE = /^DISPATCH[ \t]+([a-z][a-z0-9-]*)[ \t]*$/gim;

// Fenced code blocks are where the model quotes things verbatim — a protocol
// example it prints, or untrusted vault/web content it echoes back. A legit
// dispatch is a bare line in prose, never fenced, so drop fences before
// scanning: a `DISPATCH morning-report` sitting inside ``` can't queue work.
function stripFences(s: string): string {
  return s.replace(/```[\s\S]*?```/g, "").replace(/~~~[\s\S]*?~~~/g, "");
}

/** The skill the reply asks to dispatch, but ONLY if EXACTLY ONE non-fenced
 *  sentinel names a CHAT_SKILLS skill; else null. This — not the prompt — is
 *  the enforcement boundary. Zero sentinels = no dispatch; two or more = the
 *  reply is ambiguous or injected, so we refuse rather than guess (safe-fail:
 *  nothing queued beats queuing the wrong thing). */
export function parseDispatch(reply: string): string | null {
  const matches = [...stripFences(reply).matchAll(DISPATCH_RE)];
  if (matches.length !== 1) return null;
  const skill = matches[0][1].toLowerCase();
  return CHAT_SKILLS.includes(skill) ? skill : null;
}

/** Drop every DISPATCH sentinel line and collapse the hole it leaves, so the
 *  user never sees the machine token — even a stray one parseDispatch ignored. */
export function stripDispatch(reply: string): string {
  return reply
    .replace(DISPATCH_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
