import fs from "fs";
import path from "path";
import crypto from "crypto";
import { VAULT_ROOT } from "./config";

// ---------------------------------------------------------------------------
// Queue intent contract — shared by /api/queue (deck buttons) and /api/voice
// (spoken commands). ALLOWED_SKILLS must match runner.js buildPrompt() cases.
// ---------------------------------------------------------------------------

export const ALLOWED_SKILLS = new Set([
  "morning-report",
  "inbox-brief",
  "plan-today",
  "plan-tomorrow",
  "vault-cleanup",
  "weekly-review", // Sunday synthesis across the three directives → reports trail
  "voice-ask", // tier-3 open-ended asks → headless claude -p via runner
  // Morphy ↔ Notion native skills — executed in-process by the runner (REST),
  // NOT via `claude -p`, so they have no buildPrompt() case.
  "morphy-sync", // pull the board → cache + snapshot
  "morphy-task-add", // create a task on the board (args: title/assignee/priority)
]);

export function writeIntent(
  skill: string,
  source: string,
  args: Record<string, unknown> = {}
): string {
  const id = crypto.randomUUID();
  const intent = { id, skill, args, ts: new Date().toISOString(), source };
  const queueDir = path.join(VAULT_ROOT, "system", "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, `${id}.json`), JSON.stringify(intent, null, 2), "utf-8");
  return id;
}
