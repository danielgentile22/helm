import { homeEnv } from "./homeEnv";

// ---------------------------------------------------------------------------
// Personal-machine config — ALL of it, in one place. Every value reads an env
// var (process.env first, then ~/.claude/.env). Most fall back to a default
// that works on a fresh clone; VAULT_ROOT is the exception — it's required and
// has no default (see below). The Configuration table in docs/setup.md walks
// through each one.
// Client components can't import this (server-only via homeEnv/fs); the two
// client-side values use NEXT_PUBLIC_ vars — see lib/voiceClient.ts and
// components/ReportOverlay.tsx.
// ---------------------------------------------------------------------------

/** Vault root — the folder of plain files everything reads/writes. REQUIRED:
 *  there is no default. Set VAULT_ROOT in your shell or ~/.claude/.env and
 *  point it at your real vault. Unset → the HUD fails fast (below) rather than
 *  silently rendering demo data against a throwaway folder. */
export const VAULT_ROOT = requireVaultRoot();

function requireVaultRoot(): string {
  const root = homeEnv("VAULT_ROOT");
  if (!root) {
    throw new Error(
      "VAULT_ROOT is not set. HELM has no vault to read or write. Set it in " +
        "your shell or ~/.claude/.env — e.g. VAULT_ROOT=/Users/you/Projects/Vault " +
        "— then restart the HUD."
    );
  }
  return root;
}

/** IANA timezone for "today" — daily notes, schedules, and the runner must
 *  all agree on this or dates flip near midnight UTC. Default matches the
 *  machine record (.helm-config.json) so losing the ~/.claude/.env line
 *  doesn't silently shift every date bucket an hour. */
export const HUD_TZ = homeEnv("HUD_TZ") ?? "America/New_York";

/** Local voice-server (Kokoro TTS + faster-whisper STT). */
export const VOICE_SERVER_URL = homeEnv("VOICE_SERVER_URL") ?? "http://127.0.0.1:3108";

/** How the voice prompts refer to you ("<name>: <what you said>"). */
export const USER_NAME = homeEnv("HUD_USER_NAME") ?? "User";

/** The other person on the shared Morphy board — must match the Notion
 *  "Assignee"/"Added by" values verbatim (that's what the runner filters on).
 *  Lives in env, never in source: this repo is public and the demo vault ships
 *  pseudonyms. Client components read NEXT_PUBLIC_COLLABORATOR_NAME instead
 *  (inlined at build) — keep the two in step. */
export const COLLABORATOR_NAME = homeEnv("HUD_COLLABORATOR_NAME") ?? "Collaborator";
