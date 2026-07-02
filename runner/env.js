// ~/.claude/.env loader shared by the runner and the launchd queue scripts.
// process.env wins over the file (callers do `process.env[k] || _env[k]`).
// Sibling: lib/homeEnv.ts is the HUD's copy of this — keep the accepted-key
// rule (any KEY=value line, # comments skipped, quotes stripped) in sync or
// a setting can work for the runner and be invisible to the HUD.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function parseEnvText(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    out[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
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
