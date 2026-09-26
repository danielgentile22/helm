/**
 * Boundary parser for the server's environment. Reads `.env` from HELM_ENV
 * (default: ./.env) without a dependency, overlays process.env, and throws a
 * readable message on a missing required key. Secrets are referenced by
 * name only; nothing here logs a value.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Env {
  readonly HELM_HOME: string; // ~/.helm
  readonly HELM_VAULT_ROOT: string; // ~/Vault
  readonly HELM_BIND_ADDR: string; // loopback; tailscale serve proxies to it
  readonly HELM_PORT: number;
  readonly HELM_API_KEY: string | undefined;
  readonly HELM_VAPID_PUBLIC: string;
  readonly HELM_VAPID_PRIVATE: string;
  readonly HELM_VAPID_SUBJECT: string;
  readonly HELM_ADD_DIRS: readonly string[]; // default ~/Projects ~/Desktop ~/Documents
  /** Tailnet hostname, the WebAuthn relying party id, e.g. mac.tail1234.ts.net */
  readonly HELM_HOSTNAME: string;
  /** Session cookie lifetime. One value, so Daniel can stretch it. */
  readonly HELM_SESSION_HOURS: number;
  readonly HELM_STATIC_DIR: string;
}

/** Parse a dotenv file: KEY=value lines, optional quotes, # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function loadDotenv(path: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

const expand = (p: string): string => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p === "~" ? homedir() : resolve(p));

/** Parse the merged environment at the boundary; throws with a readable message on a missing required key. */
export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const need = (k: string): string => {
    const v = raw[k];
    if (!v) throw new Error(`missing required environment variable ${k} (set it in .env)`);
    return v;
  };
  const port = Number(raw.HELM_PORT ?? "8420");
  if (!Number.isInteger(port) || port <= 0) throw new Error("HELM_PORT must be a positive integer");
  const hours = Number(raw.HELM_SESSION_HOURS ?? "12");
  if (!(hours > 0)) throw new Error("HELM_SESSION_HOURS must be a positive number");
  return {
    HELM_HOME: expand(raw.HELM_HOME ?? "~/.helm"),
    HELM_VAULT_ROOT: expand(raw.HELM_VAULT_ROOT ?? "~/Vault"),
    HELM_BIND_ADDR: need("HELM_BIND_ADDR"),
    HELM_PORT: port,
    HELM_API_KEY: raw.HELM_API_KEY || undefined,
    HELM_VAPID_PUBLIC: need("HELM_VAPID_PUBLIC"),
    HELM_VAPID_PRIVATE: need("HELM_VAPID_PRIVATE"),
    HELM_VAPID_SUBJECT: need("HELM_VAPID_SUBJECT"),
    HELM_ADD_DIRS: (raw.HELM_ADD_DIRS ?? "~/Projects:~/Desktop:~/Documents").split(":").filter(Boolean).map(expand),
    HELM_HOSTNAME: need("HELM_HOSTNAME"),
    HELM_SESSION_HOURS: hours,
    HELM_STATIC_DIR: expand(raw.HELM_STATIC_DIR ?? "./public"),
  };
}
