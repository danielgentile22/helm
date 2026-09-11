/**
 * The HTTP shell. Thin: validate at the boundary, call one core method,
 * shape the response. No business logic here. Hono on node:http, bound to
 * the tailnet address only (main.ts), fronted by `tailscale serve`.
 *
 * Routes (all under requireAuth unless noted)
 *   POST   /auth/webauthn/register/options     (API key)         -> registrationOptions
 *   POST   /auth/webauthn/register/verify      (API key)         -> finishRegistration
 *   POST   /auth/webauthn/login/options        (open)            -> assertionOptions
 *   POST   /auth/webauthn/login/verify         (open)            -> finishAssertion, Set-Cookie
 *   POST   /auth/logout                                          -> clear cookie
 *
 *   GET    /api/threads                                          -> ThreadSummary[]
 *   POST   /api/threads                                          -> create (idempotent on threadId)
 *   GET    /api/threads/:id                                      -> ThreadSummary
 *   PATCH  /api/threads/:id                                      -> reconfigure (model/effort/title)
 *   DELETE /api/threads/:id                                      -> archive
 *   POST   /api/threads/:id/send                                 -> SendResponse
 *   POST   /api/threads/:id/interrupt                            -> 204 always
 *   POST   /api/threads/:id/uploads   (multipart, Content-Length capped) -> StagedUpload[]
 *   GET    /api/threads/:id/events?after=N   (SSE, cookie or key) -> ThreadEvent stream
 *   GET    /api/events                        (SSE)              -> global fan-in
 *   GET    /api/dirs?path=...                                    -> DirEntry[] (roots: ~/Projects ~/Desktop ~/Documents ~/.helm2 excluded)
 *   GET    /api/push/key                                         -> VAPID public key
 *   POST   /api/push/subscribe                                   -> 204
 *   DELETE /api/push/subscribe                                   -> 204
 *   GET    /*                                  (open)            -> static PWA (index.html, sw.js, manifest)
 *
 * Tracing a request never needs more than three files: app.ts -> one core
 * module -> log.ts.
 */

import type { LogRegistry } from "../core/log";
import type { PushService } from "../core/push";
import type { Supervisor } from "../core/supervisor";
import type { ThreadStore } from "../core/thread-store";
import type { Uploads } from "../core/uploads";
import type { AuthDeps, WebAuthnCeremonies } from "./auth";

export interface AppDeps {
  readonly auth: AuthDeps;
  readonly webauthn: WebAuthnCeremonies;
  readonly threads: ThreadStore;
  readonly logs: LogRegistry;
  readonly supervisor: Supervisor;
  readonly uploads: Uploads;
  readonly push: PushService;
  readonly staticDir: string;
  readonly browseRoots: readonly string[];
}

/** Returns a fetch-style handler `(req: Request) => Promise<Response>` for node:http adaptation in main.ts. */
export function buildApp(deps: AppDeps): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}

/**
 * Pure request parsers. Each returns either the typed value or the HTTP
 * error to send. Unit-tested with no I/O.
 */
export function parseSend(body: unknown): { ok: true; value: import("../../shared/protocol").SendRequest & { clientMsgId: import("../../shared/protocol").ClientMsgId } } | { ok: false; status: 400 | 413; error: string } {
  throw new Error("not implemented");
}
export function parseCreateThread(body: unknown): { ok: true; value: import("../../shared/protocol").CreateThreadRequest } | { ok: false; status: 400; error: string } {
  throw new Error("not implemented");
}
export function parsePatch(body: unknown): { ok: true; value: import("../../shared/protocol").ThreadConfigPatch } | { ok: false; status: 400; error: string } {
  throw new Error("not implemented");
}
