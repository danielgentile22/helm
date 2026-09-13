/**
 * The HTTP shell. Thin: validate at the boundary, call one core method,
 * shape the response. No business logic here. Hono on node:http, bound to
 * the tailnet address only (main.ts), fronted by `tailscale serve`.
 *
 * Routes (all under authenticate unless noted)
 *   POST   /auth/webauthn/register/options     (API key or enroll token) -> registrationOptions
 *   POST   /auth/webauthn/register/verify      (same, challengeId-bound) -> finishRegistration
 *   POST   /auth/webauthn/login/options        (open)            -> assertionOptions
 *   POST   /auth/webauthn/login/verify         (open)            -> finishAssertion, Set-Cookie
 *   POST   /auth/enroll                        (API key)         -> one-shot enrollment link
 *   POST   /auth/logout                                          -> clear cookie
 *   GET    /auth/me                                              -> { label }
 *
 *   GET    /api/models                                           -> ModelChoice[] (live catalog)
 *   GET    /api/about                                            -> { version, host }
 *   GET    /api/passkeys                                         -> { label, createdAt }[] (never the credential id)
 *   GET    /api/settings                                         -> HelmSettings
 *   PATCH  /api/settings                                         -> HelmSettings
 *   GET    /api/threads?archived=1                               -> ThreadSummary[]
 *   GET    /api/threads/search?q=..&archived=1&limit=N           -> SearchHit[]
 *   POST   /api/threads                                          -> create (idempotent on threadId)
 *   GET    /api/threads/:id                                      -> ThreadSummary
 *   PATCH  /api/threads/:id                                      -> reconfigure (model/effort/title/permissionMode)
 *   DELETE /api/threads/:id                                      -> archive
 *   POST   /api/threads/:id/send                                 -> SendResponse
 *   POST   /api/threads/:id/interrupt                            -> 204 always
 *   POST   /api/threads/:id/answer                               -> 204; 409 already answered or expired; 404 unknown ask; 400 wrong shape
 *   GET    /api/threads/:id/commands                             -> { commands: SlashCommand[] }
 *   POST   /api/threads/:id/commands/reload                      -> { commands: SlashCommand[] } (rediscovers skills)
 *   POST   /api/threads/:id/uploads   (raw body, one file, Content-Length capped) -> StagedUpload[]
 *   GET    /api/threads/:id/uploads/:uploadId                    -> the staged bytes, inline
 *   GET    /api/threads/:id/files/:fileId                        -> bytes of a file the model offered, inline
 *   GET    /api/threads/:id/events?after=N   (SSE, cookie or key) -> ThreadEvent stream
 *   GET    /api/events                        (SSE)              -> global fan-in
 *   GET    /api/dirs?path=...                                    -> DirEntry[] (within browseRoots)
 *   GET    /api/push/key                                         -> VAPID public key
 *   POST   /api/push/subscribe                                   -> 204
 *   DELETE /api/push/subscribe                                   -> 204
 *   GET    /*                                  (open)            -> static PWA (index.html, sw.js, manifest)
 *
 * Tracing a request never needs more than three files: app.ts -> one core
 * module -> log.ts.
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Context } from "hono";
import { DEFAULT_EFFORT, EFFORTS, LIMITS, PERMISSION_MODES, THEMES } from "../../shared/protocol";
import type {
  AnswerRequest,
  AskAnswer,
  AskId,
  ClientMsgId,
  CreateThreadRequest,
  Effort,
  HelmSettings,
  ModelChoice,
  ModelId,
  Origin,
  PermissionMode,
  QuestionAnswer,
  SearchHit,
  SendRequest,
  SettingsPatch,
  ThreadConfig,
  ThreadConfigPatch,
  ThreadId,
  ThreadSummary,
} from "../../shared/protocol";
import type { AgentFactory } from "../core/agent";
import { modelCatalog, parseModelId } from "../core/agent";
import { parseQuery, ThreadSearch } from "../core/search";
import { threadSummary } from "../core/summary";
import type { LogRegistry, ThreadLog } from "../core/log";
import type { PushSubscriptionRecord } from "../core/push";
import type { Supervisor } from "../core/supervisor";
import type { ThreadStore } from "../core/thread-store";
import type { SettingsStore } from "../core/settings";
import type { Offers } from "../core/offers";
import type { Uploads } from "../core/uploads";
import type { AuthDeps, EnrollTokens, WebAuthnCeremonies } from "./auth";
import { API_KEY_HEADER, authenticate, bodyTooLarge, checkApiKey, sessionCookie } from "./auth";
import { cursorFrom, respondGlobal, respondThread } from "./sse";

export interface PushDeps {
  publicKey(): string;
  subscribe(rec: PushSubscriptionRecord): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
}

export interface AppDeps {
  readonly auth: AuthDeps;
  readonly webauthn: WebAuthnCeremonies;
  readonly enroll: EnrollTokens;
  readonly threads: ThreadStore;
  readonly logs: LogRegistry;
  readonly supervisor: Supervisor;
  readonly agents: AgentFactory;
  readonly uploads: Uploads;
  readonly offers: Offers;
  readonly settings: SettingsStore;
  readonly about: { readonly version: string; readonly host: string };
  readonly push: PushDeps;
  readonly staticDir: string;
  readonly browseRoots: readonly string[];
  readonly defaultCwd: string;
  /** A thread created here starts in bypass whatever the server default says. */
  readonly vaultRoot: string;
  /** Public origin, for the enrollment link. */
  readonly publicOrigin: string;
  readonly heartbeatMs?: number;
}

/** The settings a PATCH may carry. Named once so the parser and the type cannot drift apart. */
const SETTINGS_FIELDS: readonly (keyof HelmSettings)[] = ["theme", "defaultModel", "defaultEffort", "defaultCwd", "defaultPermissionMode"];

type Env = { Variables: { origin: Origin } };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function buildApp(deps: AppDeps): { fetch: (req: Request) => Promise<Response> } {
  const app = new Hono<Env>();
  const fail = (c: Context, status: 400 | 401 | 403 | 404 | 413 | 500 | 503, error: string): Response => c.json({ error }, status);

  // ---- auth doors -------------------------------------------------------

  app.use("/api/*", async (c, next) => {
    const r = await authenticate(c.req.raw, deps.auth);
    if (!r.ok) return fail(c, r.status, r.error);
    c.set("origin", r.origin);
    await next();
  });

  /** Registration is a laptop-side act: API key, or a one-shot enrollment token from the printed link. */
  const enrollGate = (c: Context): Response | null => {
    const token = c.req.query("enroll");
    if (token && deps.enroll.consume(token)) return null;
    const r = checkApiKey(c.req.header(API_KEY_HEADER) ?? null, deps.auth.apiKey);
    return r.ok ? null : fail(c, r.status, r.error);
  };

  app.post("/auth/enroll", async (c) => {
    const r = checkApiKey(c.req.header(API_KEY_HEADER) ?? null, deps.auth.apiKey);
    if (!r.ok) return fail(c, r.status, r.error);
    return c.json({ url: `${deps.publicOrigin}/enroll?token=${deps.enroll.mint()}` });
  });

  const pendingEnrollments = new Set<string>();
  app.post("/auth/webauthn/register/options", async (c) => {
    const denied = enrollGate(c);
    if (denied) return denied;
    const body = await json(c);
    const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim().slice(0, 40) : "device";
    const r = await deps.webauthn.registrationOptions(label);
    pendingEnrollments.add(r.challengeId);
    return c.json(r);
  });

  app.post("/auth/webauthn/register/verify", async (c) => {
    const body = await json(c);
    const challengeId = typeof body?.challengeId === "string" ? body.challengeId : "";
    // The options call was gated; the verify call is bound to a challenge that only it could have minted.
    if (!pendingEnrollments.delete(challengeId)) return fail(c, 403, "no pending enrollment for this challenge");
    try {
      return c.json(await deps.webauthn.finishRegistration(challengeId, body?.response));
    } catch (err) {
      return fail(c, 400, `registration failed: ${message(err)}`);
    }
  });

  app.post("/auth/webauthn/login/options", async (c) => c.json(await deps.webauthn.assertionOptions()));

  app.post("/auth/webauthn/login/verify", async (c) => {
    const body = await json(c);
    try {
      const r = await deps.webauthn.finishAssertion(typeof body?.challengeId === "string" ? body.challengeId : "", body?.response);
      c.header("Set-Cookie", r.cookie);
      return c.json({ label: r.label });
    } catch (err) {
      return fail(c, 401, `sign-in failed: ${message(err)}`);
    }
  });

  app.post("/auth/logout", async (c) => {
    c.header("Set-Cookie", sessionCookie("", 0));
    return c.body(null, 204);
  });

  app.get("/auth/me", async (c) => {
    const r = await authenticate(c.req.raw, deps.auth);
    return r.ok ? c.json({ label: r.origin.label, via: r.origin.via }) : fail(c, r.status, r.error);
  });

  // ---- models and threads ----------------------------------------------

  let catalog: Promise<readonly ModelChoice[]> | null = null;
  const models = (): Promise<readonly ModelChoice[]> => {
    if (!catalog) {
      catalog = modelCatalog(deps.agents);
      catalog.catch(() => (catalog = null));
    }
    return catalog;
  };

  app.get("/api/models", async (c) => {
    try {
      return c.json(await models());
    } catch (err) {
      return fail(c, 503, `model catalog unavailable: ${message(err)}`);
    }
  });

  app.get("/api/about", (c) => c.json(deps.about));

  app.get("/api/passkeys", async (c) => c.json(passkeyRows(await deps.webauthn.listCredentials())));

  app.get("/api/settings", async (c) => c.json(await deps.settings.get()));

  app.patch("/api/settings", async (c) => {
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const parsed = parseSettingsPatch(await json(c), await models().catch(() => []));
    if (!parsed.ok) return fail(c, parsed.status, parsed.error);
    // Touching the filesystem is the route's job, not the parser's: the parser stays pure and unit-testable.
    if (parsed.value.defaultCwd !== undefined && !(await stat(parsed.value.defaultCwd).then((s) => s.isDirectory(), () => false))) {
      return fail(c, 400, "defaultCwd is not an existing directory");
    }
    return c.json(await deps.settings.patch(parsed.value));
  });

  const summary = (log: ThreadLog, config: ThreadConfig): ThreadSummary =>
    threadSummary(log.getHead(), config, deps.supervisor.status(log.threadId).session);

  /** The search corpus is a cache over the logs, so it lives as long as the app does. */
  const search = new ThreadSearch(deps.logs);

  app.get("/api/threads", async (c) => {
    const configs = await deps.threads.list({ includeArchived: c.req.query("archived") === "1" });
    const out = await Promise.all(configs.map(async (cfg) => summary(await deps.logs.get(cfg.threadId), cfg)));
    out.sort((a, b) => (b.lastTurnEndedAt ?? b.config.createdAt).localeCompare(a.lastTurnEndedAt ?? a.config.createdAt));
    return c.json(out);
  });

  // Before /api/threads/:id so the static segment wins the match.
  app.get("/api/threads/search", async (c) => {
    const terms = parseQuery(c.req.query("q") ?? "");
    if (terms.length === 0) return fail(c, 400, "q is required");
    const raw = c.req.query("limit") ?? "20";
    if (!/^-?\d+$/.test(raw)) return fail(c, 400, "limit must be an integer");
    const limit = Math.min(100, Math.max(1, Number(raw)));
    const configs = await deps.threads.list({ includeArchived: c.req.query("archived") === "1" });
    const found = await search.find(configs, terms, limit);
    const rows: SearchHit[] = found.map(({ config, log, match }) => ({ summary: summary(log, config), seq: match.seq, snippet: match.snippet, ranges: match.ranges }));
    return c.json(rows);
  });

  app.post("/api/threads", async (c) => {
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const parsed = parseCreateThread(await json(c), await models().catch(() => []), deps.defaultCwd);
    if (!parsed.ok) return fail(c, parsed.status, parsed.error);
    const threadId = parsed.value.threadId ?? (randomUUID() as ThreadId);
    const existing = await deps.threads.get(threadId);
    if (existing) return c.json(existing);
    const permissionMode = parsed.value.permissionMode ?? (resolve(parsed.value.cwd) === resolve(deps.vaultRoot) ? "bypass" : (await deps.settings.get()).defaultPermissionMode);
    let config;
    try {
      config = await deps.threads.create({ ...parsed.value, threadId, permissionMode });
    } catch (err) {
      return fail(c, 400, message(err));
    }
    const log = await deps.logs.get(threadId);
    await log.append({ kind: "thread.created", config });
    return c.json(config, 201);
  });

  const thread = async (c: Context<Env>): Promise<{ threadId: ThreadId; config: ThreadSummary["config"]; log: ThreadLog } | Response> => {
    const threadId = c.req.param("id") as ThreadId;
    const config = await deps.threads.get(threadId);
    if (!config) return fail(c, 404, "no such thread");
    return { threadId, config, log: await deps.logs.get(threadId) };
  };

  app.get("/api/threads/:id", async (c) => {
    const t = await thread(c);
    return t instanceof Response ? t : c.json(summary(t.log, t.config));
  });

  app.patch("/api/threads/:id", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const parsed = parsePatch(await json(c), await models().catch(() => []));
    if (!parsed.ok) return fail(c, parsed.status, parsed.error);
    await deps.supervisor.reconfigure(t.threadId, parsed.value, c.get("origin"));
    return c.json(await deps.threads.get(t.threadId));
  });

  app.delete("/api/threads/:id", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    await deps.supervisor.archive(t.threadId);
    await deps.uploads.purge(t.threadId);
    deps.offers.purge(t.threadId);
    return c.body(null, 204);
  });

  app.post("/api/threads/:id/send", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const parsed = parseSend(await json(c));
    if (!parsed.ok) return fail(c, parsed.status, parsed.error);
    let uploads;
    try {
      uploads = await deps.uploads.resolve(t.threadId, parsed.value.uploadIds ?? []);
    } catch (err) {
      return fail(c, 400, message(err));
    }
    const res = await deps.supervisor.send(t.threadId, { clientMsgId: parsed.value.clientMsgId, text: parsed.value.text, uploads, origin: originFor(c, parsed.value.label) });
    return c.json(res, res.accepted ? 200 : 409);
  });

  app.post("/api/threads/:id/interrupt", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    await deps.supervisor.interrupt(t.threadId);
    return c.body(null, 204);
  });

  /** The route's origin, with the same optional label override /send takes. */
  const originFor = (c: Context<Env>, label: string | undefined): Origin => {
    const base = c.get("origin");
    return label ? { via: base.via, label } : base;
  };

  app.post("/api/threads/:id/answer", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const parsed = parseAnswer(await json(c));
    if (!parsed.ok) return fail(c, parsed.status, parsed.error);
    const r = await deps.supervisor.answer(t.threadId, parsed.value.askId, parsed.value.answer, originFor(c, parsed.value.label));
    switch (r) {
      case "ok":
        return c.body(null, 204);
      case "conflict":
        return c.json({ error: "already answered or expired" }, 409);
      case "unknown":
        return fail(c, 404, "no such ask");
      case "mismatch":
        return fail(c, 400, "answer does not fit the ask");
    }
  });

  const commands = async (c: Context<Env>, reload: boolean): Promise<Response> => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    try {
      return c.json({ commands: await deps.supervisor.commands(t.threadId, { reload }) });
    } catch (err) {
      return fail(c, 503, `commands unavailable: ${message(err)}`);
    }
  };

  app.get("/api/threads/:id/commands", (c) => commands(c, false));
  app.post("/api/threads/:id/commands/reload", (c) => commands(c, true));

  app.post("/api/threads/:id/uploads", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    if (bodyTooLarge(c.req.raw.headers, LIMITS.UPLOAD_BYTES)) return fail(c, 413, `upload larger than ${LIMITS.UPLOAD_BYTES} bytes`);
    const body = c.req.raw.body;
    if (!body) return fail(c, 400, "empty body");
    const name = decodeURIComponent(c.req.header("x-upload-name") ?? "file");
    const mime = (c.req.header("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    const staged = await deps.uploads.stage(t.threadId, { name, mime, stream: body as unknown as AsyncIterable<Uint8Array> }, c.get("origin"));
    return c.json([staged], 201);
  });

  /**
   * Stream a file the log knows about. An upload is a copy whose bytes never
   * change under its id, so the phone may hold on to it for an hour. An offer
   * is a live path, so nothing may cache it.
   */
  const serveFile = async (c: Context, file: { path: string; name: string; mime: string } | null, cache: "max-age=3600" | "no-store"): Promise<Response> => {
    if (!file) return fail(c, 404, "no such file");
    const size = await stat(file.path).then((s) => (s.isFile() ? s.size : null), () => null);
    if (size === null) return fail(c, 404, "the file is no longer there");
    c.header("Content-Type", file.mime);
    c.header("Content-Length", String(size));
    c.header("Content-Disposition", `inline; filename="${file.name}"`);
    c.header("Cache-Control", `private, ${cache}`);
    return c.body(Readable.toWeb(createReadStream(file.path)) as ReadableStream);
  };

  app.get("/api/threads/:id/uploads/:uploadId", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    const [upload] = await deps.uploads.resolve(t.threadId, [c.req.param("uploadId")]).catch(() => []);
    return serveFile(c, upload ?? null, "max-age=3600");
  });

  app.get("/api/threads/:id/files/:fileId", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    return serveFile(c, await deps.offers.resolve(t.threadId, c.req.param("fileId")), "no-store");
  });

  app.get("/api/threads/:id/events", async (c) => {
    const t = await thread(c);
    if (t instanceof Response) return t;
    const cur = cursorFrom(new URL(c.req.url), c.req.header("last-event-id") ?? null);
    if (!cur.ok) return fail(c, 400, "bad cursor");
    return respondThread(c, t.log, deps.supervisor, cur.after, deps.heartbeatMs);
  });

  app.get("/api/events", (c) => respondGlobal(c, deps.logs, deps.heartbeatMs));

  app.get("/api/dirs", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json(deps.browseRoots.map((p) => ({ name: p.split("/").pop() ?? p, path: p, hasClaudeMd: false, isGitRepo: false })));
    try {
      return c.json(await deps.threads.browse(path, deps.browseRoots));
    } catch (err) {
      return fail(c, 400, message(err));
    }
  });

  // ---- push ---------------------------------------------------------------

  app.get("/api/push/key", (c) => c.json({ key: deps.push.publicKey() }));

  app.post("/api/push/subscribe", async (c) => {
    if (bodyTooLarge(c.req.raw.headers, LIMITS.SEND_BODY_BYTES)) return fail(c, 413, "body too large");
    const body = await json(c);
    const sub = body?.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    if (typeof sub?.endpoint !== "string" || typeof sub.keys?.p256dh !== "string" || typeof sub.keys?.auth !== "string") return fail(c, 400, "bad subscription");
    await deps.push.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: c.get("origin").label, createdAt: new Date().toISOString() });
    return c.body(null, 204);
  });

  app.delete("/api/push/subscribe", async (c) => {
    const body = await json(c);
    if (typeof body?.endpoint !== "string") return fail(c, 400, "bad endpoint");
    await deps.push.unsubscribe(body.endpoint);
    return c.body(null, 204);
  });

  // ---- static PWA ----------------------------------------------------------

  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (rel === "/" || rel.startsWith("/t/") || rel === "/enroll" || rel === "/login" || rel === "/settings") rel = "/index.html";
    const file = join(deps.staticDir, rel);
    if (!file.startsWith(deps.staticDir)) return fail(c, 404, "not found");
    try {
      const bytes = await readFile(file);
      c.header("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
      // Shell files revalidate on every load so a rebuild reaches the phone at once; icons may cache.
      c.header("Cache-Control", /\.(png|webmanifest)$/.test(rel) ? "max-age=3600" : "no-cache");
      return c.body(bytes);
    } catch {
      return fail(c, 404, "not found");
    }
  });

  return { fetch: async (req) => app.fetch(req) };
}

// ---------------------------------------------------------------------------
// Pure request parsers. Each returns either the typed value or the HTTP error to send.
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

/** A client-minted id: uuid-like, so it is safe as a path segment and a filename. */
const ID_RE = /^[a-f0-9-]{8,40}$/i;

export function parseSend(body: unknown): Parsed<SendRequest & { clientMsgId: ClientMsgId }> {
  if (!isRecord(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const clientMsgId = typeof body.clientMsgId === "string" && ID_RE.test(body.clientMsgId) ? (body.clientMsgId as ClientMsgId) : null;
  if (!clientMsgId) return { ok: false, status: 400, error: "clientMsgId must be a uuid-like token" };
  if (typeof body.text !== "string") return { ok: false, status: 400, error: "text must be a string" };
  if (body.text.length > LIMITS.MESSAGE_CHARS) return { ok: false, status: 413, error: `text longer than ${LIMITS.MESSAGE_CHARS} chars` };
  const uploadIds = body.uploadIds === undefined ? undefined : Array.isArray(body.uploadIds) && body.uploadIds.every((u) => typeof u === "string") ? (body.uploadIds as string[]) : null;
  if (uploadIds === null) return { ok: false, status: 400, error: "uploadIds must be an array of strings" };
  if (body.text.trim() === "" && !uploadIds?.length) return { ok: false, status: 400, error: "empty message" };
  return { ok: true, value: { clientMsgId, text: body.text, uploadIds, label: label(body.label) } };
}

/**
 * The client may mint the thread id so create + first send are safely
 * retriable. A malformed id parses to undefined and the route mints a fresh
 * one; the message id is the idempotency key, so parseSend rejects it instead.
 */
export function parseCreateThread(body: unknown, catalog: readonly ModelChoice[], defaultCwd: string): Parsed<CreateThreadRequest & { threadId: ThreadId | undefined }> {
  if (!isRecord(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const cwd = body.cwd === undefined ? defaultCwd : body.cwd;
  if (typeof cwd !== "string" || !cwd.startsWith("/")) return { ok: false, status: 400, error: "cwd must be an absolute path" };
  const model = parseModelId(body.model, catalog);
  if (!model) return { ok: false, status: 400, error: "model is not in the live catalog" };
  const effort = body.effort === undefined ? DEFAULT_EFFORT : body.effort;
  if (!EFFORTS.includes(effort as Effort)) return { ok: false, status: 400, error: `effort must be one of ${EFFORTS.join(", ")}` };
  const title = body.title === undefined || body.title === null ? null : typeof body.title === "string" ? body.title.slice(0, 120) : undefined;
  if (title === undefined) return { ok: false, status: 400, error: "title must be a string" };
  const threadId = typeof body.threadId === "string" && ID_RE.test(body.threadId) ? (body.threadId as ThreadId) : undefined;
  if (body.permissionMode !== undefined && !PERMISSION_MODES.includes(body.permissionMode as PermissionMode)) return { ok: false, status: 400, error: `permissionMode must be one of ${PERMISSION_MODES.join(", ")}` };
  return { ok: true, value: { threadId, cwd, model, effort: effort as Effort, title, ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode as PermissionMode }) } };
}

const label = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : undefined);

function parseQuestionAnswer(v: unknown): QuestionAnswer | null {
  if (!isRecord(v)) return null;
  if (v.kind === "options") return Array.isArray(v.labels) && v.labels.length > 0 && v.labels.every((l) => typeof l === "string" && l.length > 0) ? { kind: "options", labels: v.labels as string[] } : null;
  if (v.kind === "text") return typeof v.text === "string" && v.text.trim() !== "" && v.text.length <= LIMITS.ANSWER_CHARS ? { kind: "text", text: v.text } : null;
  return null;
}

/** Whether the ask can take the answer is the supervisor's call; this only checks the shape of each answer kind. */
export function parseAnswer(body: unknown): Parsed<AnswerRequest & { askId: AskId; label: string | undefined }> {
  if (!isRecord(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  if (typeof body.askId !== "string" || body.askId === "") return { ok: false, status: 400, error: "askId must be a non-empty string" };
  const a = body.answer;
  if (!isRecord(a)) return { ok: false, status: 400, error: "answer must be an object" };
  let answer: AskAnswer;
  switch (a.kind) {
    case "allow":
    case "allowTurn":
      answer = { kind: a.kind };
      break;
    case "deny":
      if (a.reason !== undefined && a.reason !== null && typeof a.reason !== "string") return { ok: false, status: 400, error: "reason must be a string or null" };
      if (typeof a.reason === "string" && a.reason.length > LIMITS.ANSWER_CHARS) return { ok: false, status: 413, error: `reason longer than ${LIMITS.ANSWER_CHARS} chars` };
      answer = { kind: "deny", reason: typeof a.reason === "string" && a.reason.trim() ? a.reason : null };
      break;
    case "answers": {
      if (!Array.isArray(a.answers) || a.answers.length < 1 || a.answers.length > 4) return { ok: false, status: 400, error: "answers must hold 1 to 4 entries" };
      const answers = a.answers.map(parseQuestionAnswer);
      if (answers.some((q) => q === null)) return { ok: false, status: 400, error: "each answer is {kind: options, labels: [...]} or {kind: text, text}" };
      answer = { kind: "answers", answers: answers as QuestionAnswer[] };
      break;
    }
    default:
      return { ok: false, status: 400, error: "answer.kind must be allow, allowTurn, deny or answers" };
  }
  return { ok: true, value: { askId: body.askId as AskId, answer, label: label(body.label) } };
}

/**
 * The passkey list as the device manager shows it. credentialId is a handle
 * to an authenticator and the UI has no use for it, so it is dropped here
 * rather than filtered in the route: an explicit mapping cannot be widened by
 * accident the way a spread of the stored record could.
 */
export function passkeyRows(creds: readonly { credentialId: string; label: string; createdAt: string }[]): { label: string; createdAt: string }[] {
  return creds.map((c) => ({ label: c.label, createdAt: c.createdAt }));
}

/**
 * Strict, unlike the file reader in settings.ts: an unknown field from a
 * client is a bug on the client, and accepting it silently would let a typo
 * look like a saved preference. `defaultCwd` is only checked for shape here;
 * whether the directory exists is a filesystem question the route asks.
 */
export function parseSettingsPatch(body: unknown, catalog: readonly ModelChoice[]): Parsed<SettingsPatch> {
  if (!isRecord(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const patch: { -readonly [K in keyof HelmSettings]?: HelmSettings[K] } = {};
  for (const key of Object.keys(body)) {
    if (!SETTINGS_FIELDS.includes(key as keyof HelmSettings)) return { ok: false, status: 400, error: `unknown field: ${key}` };
  }
  if (body.theme !== undefined) {
    if (!THEMES.includes(body.theme as HelmSettings["theme"])) return { ok: false, status: 400, error: `theme must be one of ${THEMES.join(", ")}` };
    patch.theme = body.theme as HelmSettings["theme"];
  }
  if (body.defaultModel !== undefined) {
    if (body.defaultModel !== null && !parseModelId(body.defaultModel, catalog)) return { ok: false, status: 400, error: "defaultModel is not in the live catalog" };
    patch.defaultModel = body.defaultModel === null ? null : (body.defaultModel as ModelId);
  }
  if (body.defaultEffort !== undefined) {
    if (!EFFORTS.includes(body.defaultEffort as Effort)) return { ok: false, status: 400, error: `defaultEffort must be one of ${EFFORTS.join(", ")}` };
    patch.defaultEffort = body.defaultEffort as Effort;
  }
  if (body.defaultCwd !== undefined) {
    if (typeof body.defaultCwd !== "string" || !body.defaultCwd.startsWith("/")) return { ok: false, status: 400, error: "defaultCwd must be an absolute path" };
    patch.defaultCwd = body.defaultCwd;
  }
  if (body.defaultPermissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(body.defaultPermissionMode as PermissionMode)) return { ok: false, status: 400, error: `defaultPermissionMode must be one of ${PERMISSION_MODES.join(", ")}` };
    patch.defaultPermissionMode = body.defaultPermissionMode as PermissionMode;
  }
  if (Object.keys(patch).length === 0) return { ok: false, status: 400, error: "nothing to change" };
  return { ok: true, value: patch };
}

export function parsePatch(body: unknown, catalog: readonly ModelChoice[]): Parsed<ThreadConfigPatch> {
  if (!isRecord(body)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const patch: { -readonly [K in keyof ThreadConfigPatch]: ThreadConfigPatch[K] } = {};
  if (body.model !== undefined) {
    const model = parseModelId(body.model, catalog);
    if (!model) return { ok: false, status: 400, error: "model is not in the live catalog" };
    patch.model = model;
  }
  if (body.effort !== undefined) {
    if (!EFFORTS.includes(body.effort as Effort)) return { ok: false, status: 400, error: `effort must be one of ${EFFORTS.join(", ")}` };
    patch.effort = body.effort as Effort;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) return { ok: false, status: 400, error: "title must be a non-empty string" };
    patch.title = body.title.trim().slice(0, 120);
  }
  if (body.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(body.permissionMode as PermissionMode)) return { ok: false, status: 400, error: `permissionMode must be one of ${PERMISSION_MODES.join(", ")}` };
    patch.permissionMode = body.permissionMode as PermissionMode;
  }
  if (Object.keys(patch).length === 0) return { ok: false, status: 400, error: "nothing to change" };
  return { ok: true, value: patch };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function json(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await c.req.json();
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}


function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
