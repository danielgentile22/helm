/**
 * Boot order (each step idempotent, so a crash loop under launchd KeepAlive
 * converges):
 *
 *   1. load .env (HELM_API_KEY, HELM_VAPID_*, HELM_BIND_ADDR, HELM_VAULT_ROOT, HELM_HOME=~/.helm2)
 *   2. take the instance lock; refuse to boot if another server is alive
 *   3. logs.recoverAll(): torn-tail truncation, orphaned turns closed, queued inputs dropped (log I3/I4)
 *   4. mirror.resume() per thread: catch the vault markdown up to the log
 *   5. push.watch + mirror.watch on every open log (and on every future open via LogRegistry.onOpen)
 *   6. listen on the tailnet address only (never 0.0.0.0); `tailscale serve` provides HTTPS
 *   7. on SIGTERM: supervisor.shutdown() (kill groups, 10 s grace), then exit
 *
 * Nothing here spawns Claude. The first send() does.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { LIMITS } from "../shared/protocol";
import { SdkAgentFactory } from "./core/agent";
import { acquireInstanceLock } from "./core/instanceLock";
import { LogRegistry } from "./core/log";
import { Mirror } from "./core/mirror";
import { PushService } from "./core/push";
import { SettingsStore } from "./core/settings";
import { Supervisor } from "./core/supervisor";
import { ThreadStore } from "./core/thread-store";
import { Offers } from "./core/offers";
import { Uploads } from "./core/uploads";
import { loadDotenv, loadEnv } from "./env";
import { buildApp } from "./http/app";
import { EnrollTokens, FileSessionStore, WebAuthn } from "./http/auth";

export async function main(): Promise<void> {
  const env = loadEnv({ ...loadDotenv(resolve(process.env.HELM_ENV ?? ".env")), ...process.env });
  const lock = await acquireInstanceLock(env.HELM_HOME);

  const threadsRoot = join(env.HELM_HOME, "threads");
  const logs = new LogRegistry(threadsRoot);
  const threads = new ThreadStore(threadsRoot);
  const agents = new SdkAgentFactory({ env: process.env });
  const offers = new Offers(threads, logs);
  const supervisor = new Supervisor(logs, threads, agents, { additionalDirectories: env.HELM_ADD_DIRS, idleParkMs: LIMITS.IDLE_PARK_MS, offers });
  const uploads = new Uploads(threads, logs);
  const settings = new SettingsStore(join(env.HELM_HOME, "settings.json"), { defaultCwd: env.HELM_VAULT_ROOT });
  const sessions = new FileSessionStore(join(env.HELM_HOME, "auth", "sessions.json"));
  const sessionTtlMs = env.HELM_SESSION_HOURS * 3600_000;
  const publicOrigin = `https://${env.HELM_HOSTNAME}`;
  const webauthn = new WebAuthn({ rpId: env.HELM_HOSTNAME, origin: publicOrigin, credentialsFile: join(env.HELM_HOME, "auth", "credentials.json"), sessions, sessionTtlMs });
  const enroll = new EnrollTokens();
  const push = new PushService(join(env.HELM_HOME, "push", "subscriptions.json"), { publicKey: env.HELM_VAPID_PUBLIC, privateKey: env.HELM_VAPID_PRIVATE, subject: env.HELM_VAPID_SUBJECT }, threads);
  const mirror = new Mirror(env.HELM_VAULT_ROOT, threads);
  const version = (JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

  logs.onOpen((log) => {
    push.watch(log);
    mirror.watch(log);
  });
  const recovered = await logs.recoverAll();
  for (const log of await logs.openLogs()) await mirror.resume(log).catch((err) => console.error(`[mirror ${log.threadId}] resume failed`, err));
  await mirror.prune().catch((err) => console.error("[mirror] prune failed", err));

  const app = buildApp({
    auth: { apiKey: env.HELM_API_KEY, sessions, now: Date.now },
    webauthn,
    enroll,
    threads,
    logs,
    supervisor,
    agents,
    uploads,
    offers,
    settings,
    about: { version, host: env.HELM_HOSTNAME },
    push,
    staticDir: env.HELM_STATIC_DIR,
    browseRoots: env.HELM_ADD_DIRS,
    defaultCwd: env.HELM_VAULT_ROOT,
    sessionTtlMs,
    publicOrigin,
  });

  const server = serve({ fetch: app.fetch, hostname: env.HELM_BIND_ADDR, port: env.HELM_PORT }, (info) => {
    console.log(`[helm] listening on http://${info.address}:${info.port} (${recovered.length} threads recovered)`);
  });

  if ((await webauthn.listCredentials()).length === 0) {
    console.log(`[helm] no passkey enrolled yet. Open this on the phone within 10 minutes:\n  ${publicOrigin}/enroll?token=${enroll.mint()}`);
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[helm] ${signal}: shutting down`);
    server.close();
    await supervisor.shutdown();
    await lock.release();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[helm] boot failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
