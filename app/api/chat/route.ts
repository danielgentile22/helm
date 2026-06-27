import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT_ROOT } from "@/lib/config";
import {
  CHAT_SYSTEM,
  HARD_TIMEOUT_MS,
  acquireThread,
  modelFor,
  parseClaudeJson,
  releaseThread,
  resolveThreadId,
  validateMessage,
} from "@/lib/chat";

// ---------------------------------------------------------------------------
// POST /api/chat — multi-turn chat against the vault. Each turn spawns
// `claude -p --resume <session-id>` in cwd=VAULT_ROOT, so the model reads and
// writes the vault directly (skip-permissions = same trust boundary as the
// runner: dev-authored surface, the user's own vault, localhost / tailnet).
//
// One Claude Code session-id per thread → real conversational memory. The
// session-id is the thread's continuity; we persist it in a sidecar and resume
// it next turn. The conversation transcript is mirrored into the vault so the
// chat itself is never lost (the whole point of this feature).
//
// Reachable only over the tailnet on the VM (no public surface). Still: this
// runs arbitrary code in the vault — never expose this route publicly.
//
// Pure logic (model allowlist, validation, parsing, busy-lock) lives in
// lib/chat.ts and is unit-tested there (scripts/test-chat.ts, no API spend).
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

const CHATS_DIR = join(VAULT_ROOT, "inbox", "chats"); // human transcript (Obsidian-readable)
const SESSIONS_DIR = join(VAULT_ROOT, "system", "chats"); // session-id sidecars (machine-owned)

function sidecarPath(threadId: string) {
  return join(SESSIONS_DIR, `${threadId}.json`);
}

function readSidecar(threadId: string): { sessionId?: string; turns?: number; created?: string } {
  try {
    return JSON.parse(readFileSync(sidecarPath(threadId), "utf8"));
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  let body: { threadId?: unknown; message?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const valid = validateMessage(body.message);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: valid.status });
  const message = valid.message;

  const threadId = resolveThreadId(body.threadId);
  const model = modelFor(body.model);

  if (!acquireThread(threadId)) {
    return NextResponse.json({ error: "thread busy — a turn is already running" }, { status: 409 });
  }

  try {
    mkdirSync(CHATS_DIR, { recursive: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });

    const prior = readSidecar(threadId);
    const args = ["-p", message, "--model", model, "--output-format", "json", "--append-system-prompt", CHAT_SYSTEM, "--dangerously-skip-permissions"];
    if (prior.sessionId) args.push("--resume", prior.sessionId);

    const { stdout, stderr, code, timedOut } = await runClaude(args);

    if (timedOut) {
      return NextResponse.json({ error: "turn timed out after 5 min" }, { status: 504 });
    }
    const parsed = parseClaudeJson(stdout);
    if (!parsed) {
      return NextResponse.json(
        { error: `claude produced no parseable output (exit ${code})`, stderr: stderr.slice(0, 400) },
        { status: 502 }
      );
    }

    const reply = (parsed.result ?? "").trim() || "(no reply)";
    const sessionId = parsed.session_id ?? prior.sessionId;
    const ts = new Date().toISOString();

    // mirror the turn into the vault — first write seeds frontmatter
    const transcript = join(CHATS_DIR, `${threadId}.md`);
    if (!existsSync(transcript)) {
      writeFileSync(
        transcript,
        `---\nthread: ${threadId}\ntype: chat\ncreated: ${ts}\ntags: [chat]\n---\n\n# Chat ${threadId.slice(0, 8)}\n`,
        "utf8"
      );
    }
    appendFileSync(
      transcript,
      `\n**You** · ${ts}\n\n${message}\n\n**HELM** (${model}) · ${new Date().toISOString()}\n\n${reply}\n`,
      "utf8"
    );

    writeFileSync(
      sidecarPath(threadId),
      JSON.stringify(
        { threadId, sessionId, model, turns: (prior.turns ?? 0) + 1, created: prior.created ?? ts, updated: new Date().toISOString() },
        null,
        2
      ),
      "utf8"
    );

    return NextResponse.json({ threadId, reply, sessionId, model, costUsd: parsed.total_cost_usd ?? null, isError: !!parsed.is_error });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  } finally {
    releaseThread(threadId);
  }
}

function runClaude(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_BIN, args, {
      shell: false,
      cwd: VAULT_ROOT, // vault is cwd → reads/writes the vault, auto-loads its CLAUDE.md guardrails
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, HARD_TIMEOUT_MS);
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: -1, timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}
