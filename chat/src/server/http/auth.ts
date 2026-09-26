/**
 * The auth boundary. Two doors, one middleware, fail closed.
 *
 *   1. `helm_session` cookie: minted after a WebAuthn assertion (Face ID).
 *      HttpOnly, Secure, SameSite=Strict, lifetime from config (12 h).
 *      Required for SSE because EventSource cannot set headers.
 *   2. `X-Helm-Key` header: static key from .env, timing-safe compare,
 *      503 if unconfigured (salvaged checkHelmKey). For curl and for
 *      enrolling a new passkey.
 *
 * Everything under /api passes through authenticate. Static assets and the
 * two WebAuthn login endpoints do not. Registration needs the API key or a
 * one-shot enrollment token the server printed on the Mac. WebAuthn state
 * (the credential list, sessions) lives in ~/.helm/auth/, atomic-written.
 *
 * Security is only these two doors plus Tailscale. No per-route policy, by design.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Origin } from "../../shared/protocol";
import { atomicWrite } from "../util/atomicWrite";

export const SESSION_COOKIE = "helm_session";
export const API_KEY_HEADER = "x-helm-key";

export type AuthResult = { ok: true; origin: Origin } | { ok: false; status: 401 | 403 | 503; error: string };

export interface AuthDeps {
  readonly apiKey: string | undefined; // HELM_API_KEY
  readonly sessions: SessionStore;
  readonly now: () => number;
}

/** Salvaged: timing-safe, fails closed when unconfigured. */
export function checkApiKey(header: string | null, expected: string | undefined): AuthResult {
  if (!expected) return { ok: false, status: 503, error: "API key not configured" };
  if (header === null) return { ok: false, status: 401, error: "missing API key" };
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: "bad API key" };
  return { ok: true, origin: { via: "key", label: "curl" } };
}

/** Salvaged: reject on Content-Length before buffering; absent header = chunked = reject. */
export function bodyTooLarge(headers: Headers, capBytes: number): boolean {
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return true;
  return Number(raw) > capBytes;
}

export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Cookie first, then header. */
export async function authenticate(req: Request, deps: AuthDeps): Promise<AuthResult> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) {
    const s = await deps.sessions.lookup(token);
    if (s) return { ok: true, origin: { via: "pwa", label: s.label } };
  }
  const key = req.headers.get(API_KEY_HEADER);
  if (key !== null) return checkApiKey(key, deps.apiKey);
  return { ok: false, status: 401, error: "not signed in" };
}

export function sessionCookie(token: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export interface SessionStore {
  /** Random 32-byte token -> { label, expiresAt }; in memory plus a file so a restart does not log the phone out. */
  mint(label: string, ttlMs: number): Promise<string>;
  lookup(token: string): Promise<{ label: string } | null>;
  revokeAll(): Promise<void>;
}

interface SessionRecord {
  readonly token: string;
  readonly label: string;
  readonly expiresAt: number;
}

export class FileSessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    try {
      for (const r of JSON.parse(readFileSync(file, "utf8")) as SessionRecord[]) this.sessions.set(r.token, r);
    } catch {
      // No file yet, or unreadable: start empty. Worst case the phone logs in again.
    }
  }

  async mint(label: string, ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { token, label, expiresAt: this.now() + ttlMs });
    await this.persist();
    return token;
  }

  async lookup(token: string): Promise<{ label: string } | null> {
    const r = this.sessions.get(token);
    if (!r) return null;
    if (r.expiresAt <= this.now()) {
      this.sessions.delete(token);
      void this.persist();
      return null;
    }
    return { label: r.label };
  }

  async revokeAll(): Promise<void> {
    this.sessions.clear();
    await this.persist();
  }

  private async persist(): Promise<void> {
    const live = [...this.sessions.values()].filter((r) => r.expiresAt > this.now());
    await mkdir(dirname(this.file), { recursive: true });
    await atomicWrite(this.file, JSON.stringify(live));
  }
}

/** One-shot enrollment tokens, printed by the server on the Mac. Memory only; a restart invalidates them. */
export class EnrollTokens {
  private readonly tokens = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = 10 * 60_000) {}

  mint(): string {
    const t = randomBytes(16).toString("hex");
    this.tokens.set(t, this.now() + this.ttlMs);
    return t;
  }

  consume(token: string): boolean {
    const exp = this.tokens.get(token);
    if (exp === undefined) return false;
    this.tokens.delete(token);
    return exp > this.now();
  }
}

/**
 * WebAuthn ceremonies. Registration requires the API key or an enrollment
 * token (enrollment is a laptop-side act). Assertion is open (it is the
 * login). Relying party id is the tailnet hostname; origin must match exactly.
 */
export interface WebAuthnCeremonies {
  registrationOptions(label: string): Promise<{ challengeId: string; options: unknown }>;
  finishRegistration(challengeId: string, response: unknown): Promise<{ credentialId: string }>;
  assertionOptions(): Promise<{ challengeId: string; options: unknown }>;
  /** On success mints a session cookie value via SessionStore. */
  finishAssertion(challengeId: string, response: unknown): Promise<{ cookie: string; label: string }>;
  listCredentials(): Promise<readonly { credentialId: string; label: string; createdAt: string }[]>;
  revokeCredential(credentialId: string): Promise<void>;
}

/** Stored as a list keyed by device so per-device revocation is a UI addition, not a migration. */
interface StoredCredential {
  readonly credentialId: string;
  readonly publicKey: string; // base64url
  readonly counter: number;
  readonly transports: readonly string[];
  readonly label: string;
  readonly createdAt: string;
}

interface Pending {
  readonly challenge: string;
  readonly label: string;
  readonly expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const USER_ID = new TextEncoder().encode("daniel");

export class WebAuthn implements WebAuthnCeremonies {
  private credentials: StoredCredential[] = [];
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly cfg: { rpId: string; origin: string; credentialsFile: string; sessions: SessionStore; sessionTtlMs: number; now?: () => number },
  ) {
    try {
      this.credentials = JSON.parse(readFileSync(cfg.credentialsFile, "utf8")) as StoredCredential[];
    } catch {
      this.credentials = [];
    }
  }

  private now(): number {
    return (this.cfg.now ?? Date.now)();
  }

  private remember(challenge: string, label: string): string {
    const id = randomBytes(16).toString("hex");
    for (const [k, p] of this.pending) if (p.expiresAt <= this.now()) this.pending.delete(k);
    this.pending.set(id, { challenge, label, expiresAt: this.now() + CHALLENGE_TTL_MS });
    return id;
  }

  private take(challengeId: string): Pending {
    const p = this.pending.get(challengeId);
    this.pending.delete(challengeId);
    if (!p || p.expiresAt <= this.now()) throw new Error("unknown or expired challenge");
    return p;
  }

  async registrationOptions(label: string): Promise<{ challengeId: string; options: unknown }> {
    const options = await generateRegistrationOptions({
      rpName: "Helm",
      rpID: this.cfg.rpId,
      userName: label,
      userID: USER_ID,
      userDisplayName: "Daniel",
      attestationType: "none",
      excludeCredentials: this.credentials.map((c) => ({ id: c.credentialId, transports: [...c.transports] })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    return { challengeId: this.remember(options.challenge, label), options };
  }

  async finishRegistration(challengeId: string, response: unknown): Promise<{ credentialId: string }> {
    const p = this.take(challengeId);
    const v = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: p.challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: true,
    });
    if (!v.verified || !v.registrationInfo) throw new Error("registration not verified");
    const c = v.registrationInfo.credential;
    this.credentials = [
      ...this.credentials.filter((x) => x.credentialId !== c.id),
      { credentialId: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports ?? [], label: p.label, createdAt: new Date(this.now()).toISOString() },
    ];
    await this.persist();
    return { credentialId: c.id };
  }

  async assertionOptions(): Promise<{ challengeId: string; options: unknown }> {
    const options = await generateAuthenticationOptions({
      rpID: this.cfg.rpId,
      userVerification: "required",
      allowCredentials: this.credentials.map((c) => ({ id: c.credentialId, transports: [...c.transports] })),
    });
    return { challengeId: this.remember(options.challenge, ""), options };
  }

  async finishAssertion(challengeId: string, response: unknown): Promise<{ cookie: string; label: string }> {
    const p = this.take(challengeId);
    const r = response as AuthenticationResponseJSON;
    const stored = this.credentials.find((c) => c.credentialId === r?.id);
    if (!stored) throw new Error("unknown credential");
    const v = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: p.challenge,
      expectedOrigin: this.cfg.origin,
      expectedRPID: this.cfg.rpId,
      requireUserVerification: true,
      credential: { id: stored.credentialId, publicKey: Buffer.from(stored.publicKey, "base64url"), counter: stored.counter, transports: [...stored.transports] as never },
    });
    if (!v.verified) throw new Error("assertion not verified");
    this.credentials = this.credentials.map((c) => (c.credentialId === stored.credentialId ? { ...c, counter: v.authenticationInfo.newCounter } : c));
    await this.persist();
    const token = await this.cfg.sessions.mint(stored.label, this.cfg.sessionTtlMs);
    return { cookie: sessionCookie(token, this.cfg.sessionTtlMs), label: stored.label };
  }

  async listCredentials(): Promise<readonly { credentialId: string; label: string; createdAt: string }[]> {
    return this.credentials.map(({ credentialId, label, createdAt }) => ({ credentialId, label, createdAt }));
  }

  async revokeCredential(credentialId: string): Promise<void> {
    this.credentials = this.credentials.filter((c) => c.credentialId !== credentialId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.cfg.credentialsFile), { recursive: true });
    await atomicWrite(this.cfg.credentialsFile, JSON.stringify(this.credentials, null, 2));
  }
}
