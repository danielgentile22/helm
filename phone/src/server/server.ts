/**
 * The composition root. Builds the whole server graph from a config record
 * plus an agent adapter, so production (main.ts), the HTTP test kit and the
 * dev-fake script boot the same way. Two adapters justify the seam: SDK
 * agents in production, scripted fakes in tests.
 *
 * Boot order (each step idempotent, so a crash loop under launchd KeepAlive
 * converges):
 *
 *   1. push.watch + mirror.watch on every log the registry opens, now or later
 *   2. logs.recoverAll(): torn-tail truncation, orphaned turns closed, queued inputs dropped (log I3/I4)
 *   3. mirror.resume() per repaired log, then mirror.prune()
 *
 * Nothing here listens or spawns Claude. The entry point listens; the first send() spawns.
 */

import { join } from "node:path";
import { LIMITS } from "../shared/protocol";
import type { ThreadId } from "../shared/protocol";
import type { AgentFactory } from "./core/agent";
import { LogRegistry } from "./core/log";
import { Mirror } from "./core/mirror";
import { PushService, type Send } from "./core/push";
import { SettingsStore } from "./core/settings";
import { Supervisor } from "./core/supervisor";
import { ThreadStore } from "./core/thread-store";
import { Offers } from "./core/offers";
import { Uploads } from "./core/uploads";
import type { Env } from "./env";
import { buildApp } from "./http/app";
import { EnrollTokens, FileSessionStore, WebAuthn } from "./http/auth";

export interface ServerConfig {
  readonly home: string;
  /** Vault root: the mirror target and the default thread cwd. */
  readonly vaultRoot: string;
  /** Tailnet hostname: the WebAuthn relying party id and the public origin's host. */
  readonly hostname: string;
  readonly apiKey: string | undefined;
  readonly vapid: { readonly publicKey: string; readonly privateKey: string; readonly subject: string };
  readonly browseRoots: readonly string[];
  readonly sessionTtlMs: number;
  readonly staticDir: string;
  readonly version: string;
  readonly idleParkMs?: number;
  readonly heartbeatMs?: number;
}

export interface ServerDeps {
  readonly agents: AgentFactory;
  /** One push delivery attempt. Tests inject a recorder; production uses web-push. */
  readonly pushSend?: Send;
}

export interface Server {
  readonly fetch: (req: Request) => Promise<Response>;
  readonly logs: LogRegistry;
  readonly supervisor: Supervisor;
  readonly offers: Offers;
  readonly mirror: Mirror;
  readonly webauthn: WebAuthn;
  readonly enroll: EnrollTokens;
  readonly publicOrigin: string;
  /** Threads repaired at boot. */
  readonly recovered: readonly ThreadId[];
  shutdown(): Promise<void>;
}

export function configFromEnv(env: Env, version: string): ServerConfig {
  return {
    home: env.HELM_HOME,
    vaultRoot: env.HELM_VAULT_ROOT,
    hostname: env.HELM_HOSTNAME,
    apiKey: env.HELM_API_KEY,
    vapid: { publicKey: env.HELM_VAPID_PUBLIC, privateKey: env.HELM_VAPID_PRIVATE, subject: env.HELM_VAPID_SUBJECT },
    browseRoots: env.HELM_ADD_DIRS,
    sessionTtlMs: env.HELM_SESSION_HOURS * 3600_000,
    staticDir: env.HELM_STATIC_DIR,
    version,
  };
}

export async function buildServer(cfg: ServerConfig, deps: ServerDeps): Promise<Server> {
  const threadsRoot = join(cfg.home, "threads");
  const logs = new LogRegistry(threadsRoot);
  const threads = new ThreadStore(threadsRoot);
  const offers = new Offers(threads, logs);
  const supervisor = new Supervisor(logs, threads, deps.agents, { additionalDirectories: cfg.browseRoots, idleParkMs: cfg.idleParkMs ?? LIMITS.IDLE_PARK_MS, offers });
  const uploads = new Uploads(threads, logs);
  const settings = new SettingsStore(join(cfg.home, "settings.json"), { defaultCwd: cfg.vaultRoot });
  const sessions = new FileSessionStore(join(cfg.home, "auth", "sessions.json"));
  const publicOrigin = `https://${cfg.hostname}`;
  const webauthn = new WebAuthn({ rpId: cfg.hostname, origin: publicOrigin, credentialsFile: join(cfg.home, "auth", "credentials.json"), sessions, sessionTtlMs: cfg.sessionTtlMs });
  const enroll = new EnrollTokens();
  const push = new PushService(join(cfg.home, "push", "subscriptions.json"), cfg.vapid, threads, deps.pushSend ? { send: deps.pushSend } : undefined);
  const mirror = new Mirror(cfg.vaultRoot, threads);

  logs.onOpen((log) => {
    push.watch(log);
    mirror.watch(log);
  });
  const recovered = await logs.recoverAll();
  for (const log of await logs.openLogs()) await mirror.resume(log).catch((err) => console.error(`[mirror ${log.threadId}] resume failed`, err));
  await mirror.prune().catch((err) => console.error("[mirror] prune failed", err));

  const app = buildApp({
    auth: { apiKey: cfg.apiKey, sessions, now: Date.now },
    webauthn,
    enroll,
    threads,
    logs,
    supervisor,
    agents: deps.agents,
    uploads,
    offers,
    settings,
    about: { version: cfg.version, host: cfg.hostname },
    push,
    staticDir: cfg.staticDir,
    browseRoots: cfg.browseRoots,
    defaultCwd: cfg.vaultRoot,
    publicOrigin,
    heartbeatMs: cfg.heartbeatMs,
  });

  return { fetch: app.fetch, logs, supervisor, offers, mirror, webauthn, enroll, publicOrigin, recovered, shutdown: () => supervisor.shutdown() };
}
