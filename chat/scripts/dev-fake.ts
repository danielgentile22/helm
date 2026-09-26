/**
 * Boot the server graph through the production composition root on the
 * scripted fake agent, serve a built client from STATIC_DIR, and pre-mint a
 * session cookie so a browser can open it without a passkey. Run from a
 * checkout: `node --import tsx <this file>`. Prints the URL and the cookie to
 * paste into devtools.
 */
import { serve } from "@hono/node-server";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeAgentFactory } from "../src/server/core/agent.fake";
import type { FakeScript } from "../src/server/core/agent.fake";
import { buildServer } from "../src/server/server";

const STATIC_DIR = process.env.STATIC_DIR ?? new URL("../public", import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8431);
const TOKEN = "dev-session-token";
const HOST = "mac.test.ts.net";

const script: FakeScript = async (t) => {
  const text = t.input.text;
  if (text.startsWith("/")) {
    t.text(`Ran command: ${text}`);
    t.end();
    return;
  }
  if (text.includes("stream")) {
    for (let i = 0; i < 400; i++) {
      t.text(`delta ${i} `);
      await new Promise((r) => setTimeout(r, 15));
    }
    t.end();
    return;
  }
  if (text.includes("slow")) {
    t.thinking("Considering the request.");
    const id = t.toolStart("Bash", { command: "sleep 30" });
    await Promise.race([t.interrupted, new Promise((r) => setTimeout(r, 30_000))]);
    t.toolEnd(id, "interrupted", true);
    t.end("ok");
    return;
  }
  t.text(`Echo: ${text}` + (t.input.uploads.length ? `\n\nSaw ${t.input.uploads.length} upload(s): ${t.input.uploads.map((u) => `${u.name} (${u.mime})`).join(", ")}` : ""));
  t.end();
};

const home = join(process.env.TMPDIR ?? "/tmp", "helm2-dev-fake");
const work = join(home, "work");
const staticDir = join(home, "static");
await mkdir(join(home, "auth"), { recursive: true });
await mkdir(work, { recursive: true });
await writeFile(join(home, "auth", "sessions.json"), JSON.stringify([{ token: TOKEN, label: "devbrowser", expiresAt: Date.now() + 86_400_000 }]));
await cp(STATIC_DIR, staticDir, { recursive: true });

const agents = new FakeAgentFactory(script);
agents.commandList = [
  { name: "commit", description: "Commit staged work", argumentHint: "" },
  { name: "grill-with-docs", description: "Grill a plan against the docs", argumentHint: "<plan>" },
  { name: "grill", description: "Grill the user relentlessly about a plan", argumentHint: "<plan>" },
  { name: "unslop", description: "Cut AI tells from any writing", argumentHint: "<text>" },
];
const helm = await buildServer(
  {
    home,
    vaultRoot: work,
    hostname: HOST,
    apiKey: "dev-key",
    vapid: { publicKey: "vapid-public", privateKey: "vapid-private", subject: "mailto:dev@example.com" },
    browseRoots: [work],
    additionalDirectories: [],
    sessionTtlMs: 86_400_000,
    staticDir,
    version: "0.0.0-dev",
    idleParkMs: 60_000,
    heartbeatMs: 60_000,
  },
  { agents, pushSend: async () => undefined },
);

serve({ fetch: helm.fetch, hostname: "127.0.0.1", port: PORT }, (info) => {
  console.log(`dev-fake listening on http://127.0.0.1:${info.port}`);
  console.log(`cookie: helm_session=${TOKEN}`);
});
