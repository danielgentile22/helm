import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// ~/.claude/.env loader — the one place keys live (same pattern metrics-pull
// uses). Loaded once per server process; process.env wins over the file.
// Sibling: runner/env.js is the runner-side copy (the runner can't import TS)
// — keep the accepted-key rule in sync or a key works for the runner and is
// invisible to the HUD.
// ---------------------------------------------------------------------------

let loaded = false;

// The parsing rule, pure — identical to runner/env.js parseEnvText() and
// feeds/_metrics.py parse_env_text(); the three-way contract test in
// scripts/test-runner.ts diffs all three over one fixture (issue #43).
export function parseHomeEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function loadHomeEnv() {
  if (loaded) return;
  loaded = true;
  const file = path.join(os.homedir(), ".claude", ".env");
  try {
    for (const [k, v] of Object.entries(parseHomeEnvText(fs.readFileSync(file, "utf-8")))) {
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {
    // no home env file — process.env may still have the keys
  }
}

export function homeEnv(name: string): string | undefined {
  loadHomeEnv();
  return process.env[name];
}
