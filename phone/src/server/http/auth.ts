/**
 * The auth boundary. Two doors, one middleware, fail closed.
 *
 *   1. `helm_session` cookie: minted after a WebAuthn assertion (Face ID).
 *      HttpOnly, Secure, SameSite=Strict, 12 h. Required for SSE because
 *      EventSource cannot set headers.
 *   2. `X-Helm-Key` header: static key from .env, timing-safe compare,
 *      503 if unconfigured (salvaged checkHelmKey). For curl and for
 *      enrolling a new passkey.
 *
 * Everything under /api and /events passes through requireAuth. Static assets
 * and the two WebAuthn ceremony endpoints do not. WebAuthn state (the
 * credential set, pending challenges) lives in ~/.helm2/auth/, atomic-written.
 *
 * Security is only these two doors plus Tailscale. No per-route policy, by design.
 */

import type { Origin } from "../../shared/protocol";

export type AuthResult = { ok: true; origin: Origin } | { ok: false; status: 401 | 403 | 503; error: string };

export interface AuthDeps {
  readonly apiKey: string | undefined; // HELM_API_KEY
  readonly sessions: SessionStore;
  readonly now: () => number;
}

/** Salvaged: timing-safe, fails closed when unconfigured. */
export function checkApiKey(header: string | null, expected: string | undefined): AuthResult {
  throw new Error("not implemented");
}

/** Salvaged: reject on Content-Length before buffering; absent header = chunked = reject. */
export function bodyTooLarge(headers: Headers, capBytes: number): boolean {
  throw new Error("not implemented");
}

/** Cookie first, then header. Pure given deps. */
export function authenticate(req: Request, deps: AuthDeps): AuthResult {
  throw new Error("not implemented");
}

export interface SessionStore {
  /** Random 32-byte token -> { label, expiresAt }; in memory plus ~/.helm2/auth/sessions.json so a restart does not log the phone out. */
  mint(label: string, ttlMs: number): Promise<string>;
  lookup(token: string): Promise<{ label: string } | null>;
  revokeAll(): Promise<void>;
}

/**
 * WebAuthn ceremonies. Registration requires the API key (enrollment is a
 * laptop-side act). Assertion is open (it is the login). Relying party id is
 * the tailnet hostname; origin must match exactly.
 */
export interface WebAuthnCeremonies {
  registrationOptions(label: string): Promise<{ challengeId: string; options: unknown }>;
  finishRegistration(challengeId: string, response: unknown): Promise<{ credentialId: string }>;
  assertionOptions(): Promise<{ challengeId: string; options: unknown }>;
  /** On success mints a session cookie value via SessionStore. */
  finishAssertion(challengeId: string, response: unknown): Promise<{ cookie: string }>;
  listCredentials(): Promise<readonly { credentialId: string; label: string; createdAt: string }[]>;
  revokeCredential(credentialId: string): Promise<void>;
}
