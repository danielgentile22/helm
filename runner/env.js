// ~/.claude/.env loader shared by the runner and the launchd queue scripts.
// process.env wins over the file (callers do `process.env[k] || _env[k]`).
// Sibling: lib/homeEnv.ts is the HUD's copy of this — keep the accepted-key
// rule (any KEY=value line, # comments skipped, quotes stripped) in sync or
// a setting can work for the runner and be invisible to the HUD.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// The rule (identical in lib/homeEnv.ts and feeds/_metrics.py — the three-way
// contract test in scripts/test-runner.ts diffs all three over one fixture):
// mixed-case word keys, # comments skipped, value trimmed, one quote pair
// stripped.
export function parseEnvText(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadEnvFile() {
  const envPath = join(homedir(), ".claude", ".env");
  if (!existsSync(envPath)) return {};
  try {
    return parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}
