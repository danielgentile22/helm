#!/usr/bin/env node
/**
 * Queue a skill intent from outside the HUD — for launchd-scheduled skills.
 *
 * Writes the SAME intent shape the HUD's writeIntent() (lib/skills.ts) and
 * /api/queue produce: <vault>/system/queue/<uuid>.json. The always-alive runner
 * watches that folder and executes the skill. This script does no work itself —
 * it just drops the intent and exits, so the heavy `claude -p` run happens in
 * the runner where every other skill runs (timeouts, dedupe, logging included).
 *
 *   node scripts/queue-intent.mjs <skill> [source]
 *
 * Used by com.helm.weekly (scripts/com.helm.weekly.plist) to fire the
 * weekly-review every Sunday. VAULT_ROOT resolves from the environment first,
 * then ~/.claude/.env — the same precedence the runner uses.
 */

import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// Same env resolution as the runner: process.env first, then ~/.claude/.env.
import { loadEnvFile } from "../runner/env.js";

const _env = loadEnvFile();
const env = (k) => process.env[k] || _env[k];

const skill = process.argv[2];
const source = process.argv[3] || "schedule";
if (!skill) {
  console.error("usage: node scripts/queue-intent.mjs <skill> [source]");
  process.exit(2);
}

const VAULT_ROOT = env("VAULT_ROOT");
if (!VAULT_ROOT) {
  console.error("[queue-intent] VAULT_ROOT is not set — cannot find the queue. " +
    "Set it in the environment or ~/.claude/.env.");
  process.exit(1);
}

const queueDir = join(VAULT_ROOT, "system", "queue");
mkdirSync(queueDir, { recursive: true });

const id = randomUUID();
const intent = { id, skill, args: {}, ts: new Date().toISOString(), source };
// atomic write-then-rename, same contract as writeIntent() in lib/skills.ts —
// the runner fs.watch()es this dir and must never see a torn intent (the temp
// name fails its UUID_JSON_RE, so it's invisible until renamed). The shape
// match is enforced by a contract test in scripts/test-vault.ts (issue #43).
const dest = join(queueDir, `${id}.json`);
const tmp = `${dest}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(intent, null, 2), "utf8");
renameSync(tmp, dest);

console.log(`[queue-intent] queued ${skill} (${id}) source=${source} → ${queueDir}`);
