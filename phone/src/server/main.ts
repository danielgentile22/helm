/**
 * The production entry point. Loads .env, takes the instance lock, builds the
 * server graph through the composition root (server.ts), listens on the
 * tailnet address only (never 0.0.0.0; `tailscale serve` provides HTTPS), and
 * on SIGTERM drains the supervisor (kill groups, 10 s grace) before exiting.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { serve } from "@hono/node-server";
import { SdkAgentFactory } from "./core/agent";
import { killTree } from "./util/killTree";
import { acquireInstanceLock } from "./core/instanceLock";
import { loadDotenv, loadEnv } from "./env";
import { buildServer, configFromEnv } from "./server";

export async function main(): Promise<void> {
  const env = loadEnv({ ...loadDotenv(resolve(process.env.HELM_ENV ?? ".env")), ...process.env });
  const lock = await acquireInstanceLock(env.HELM_HOME);
  const version = (JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const helm = await buildServer(configFromEnv(env, version), { agents: new SdkAgentFactory({ query, killTree: (pid) => killTree(pid, "group"), env: process.env }) });

  const server = serve({ fetch: helm.fetch, hostname: env.HELM_BIND_ADDR, port: env.HELM_PORT }, (info) => {
    console.log(`[helm] listening on http://${info.address}:${info.port} (${helm.recovered.length} threads recovered)`);
  });

  if ((await helm.webauthn.listCredentials()).length === 0) {
    console.log(`[helm] no passkey enrolled yet. Open this on the phone within 10 minutes:\n  https://${env.HELM_HOSTNAME}/enroll?token=${helm.enroll.mint()}`);
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[helm] ${signal}: shutting down`);
    server.close();
    await helm.shutdown();
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
