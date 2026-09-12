/**
 * In-process stack for the primary suite: real log, supervisor, SSE, HTTP,
 * auth, uploads over a temp home, with the scripted fake agent and a stub
 * push service. `restart()` builds a fresh stack over the same home to
 * simulate a server crash and reboot.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncFrame, ThreadEvent } from "../../shared/protocol";
import { FakeAgentFactory, echoScript, type FakeScript } from "../core/agent.fake";
import { LogRegistry } from "../core/log";
import type { PushSubscriptionRecord } from "../core/push";
import { SettingsStore } from "../core/settings";
import { Supervisor } from "../core/supervisor";
import { ThreadStore } from "../core/thread-store";
import { Uploads } from "../core/uploads";
import { buildApp } from "./app";
import { EnrollTokens, FileSessionStore, WebAuthn } from "./auth";

export const API_KEY = "test-key-123";

export interface Stack {
  readonly home: string;
  readonly fetch: (req: Request) => Promise<Response>;
  readonly agents: FakeAgentFactory;
  readonly logs: LogRegistry;
  readonly supervisor: Supervisor;
  readonly pushSubs: PushSubscriptionRecord[];
  /** Authenticated JSON request helper using the API key door. */
  api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** Abandon this stack without killing anything (a crash), then boot a new one over the same home. */
  restart(script?: FakeScript): Promise<Stack>;
  shutdown(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function buildStack(script: FakeScript = echoScript, home?: string, opts: { apiKey?: string | undefined } = {}): Promise<Stack> {
  const h = home ?? (await mkdtemp(join(tmpdir(), "helm2-http-")));
  const staticDir = join(h, "static");
  await mkdir(staticDir, { recursive: true });
  await writeFile(join(staticDir, "index.html"), "<!doctype html><title>Helm</title>");
  await mkdir(join(h, "work"), { recursive: true });
  await mkdir(join(h, "work", "proj"), { recursive: true });
  await writeFile(join(h, "work", "proj", "CLAUDE.md"), "");

  const threadsRoot = join(h, "threads");
  const logs = new LogRegistry(threadsRoot);
  await logs.recoverAll();
  const threads = new ThreadStore(threadsRoot);
  const agents = new FakeAgentFactory(script);
  const supervisor = new Supervisor(logs, threads, agents, { additionalDirectories: [], idleParkMs: 60_000 });
  const uploads = new Uploads(threads, logs);
  const settings = new SettingsStore(join(h, "settings.json"), { defaultCwd: join(h, "work") });
  const sessions = new FileSessionStore(join(h, "auth", "sessions.json"));
  const apiKey = "apiKey" in opts ? opts.apiKey : API_KEY;
  const pushSubs: PushSubscriptionRecord[] = [];
  const app = buildApp({
    auth: { apiKey, sessions, now: Date.now },
    webauthn: new WebAuthn({ rpId: "mac.test.ts.net", origin: "https://mac.test.ts.net", credentialsFile: join(h, "auth", "credentials.json"), sessions, sessionTtlMs: 3600_000 }),
    enroll: new EnrollTokens(),
    threads,
    logs,
    supervisor,
    agents,
    uploads,
    settings,
    push: {
      publicKey: () => "vapid-public",
      subscribe: async (rec) => void pushSubs.push(rec),
      unsubscribe: async (endpoint) => void pushSubs.splice(pushSubs.findIndex((r) => r.endpoint === endpoint), 1),
    },
    staticDir,
    browseRoots: [join(h, "work")],
    defaultCwd: join(h, "work"),
    sessionTtlMs: 3600_000,
    publicOrigin: "https://mac.test.ts.net",
    heartbeatMs: 60_000,
  });

  const stack: Stack = {
    home: h,
    fetch: app.fetch,
    agents,
    logs,
    supervisor,
    pushSubs,
    api: (method, path, body, headers = {}) =>
      app.fetch(
        new Request(`https://mac.test.ts.net${path}`, {
          method,
          headers: { "x-helm-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
    restart: (nextScript) => buildStack(nextScript ?? script, h, opts),
    shutdown: () => supervisor.shutdown(),
    cleanup: async () => {
      await supervisor.shutdown();
      await rm(h, { recursive: true, force: true });
    },
  };
  return stack;
}

export type Frame = { kind: "event"; id: number; ev: ThreadEvent } | { kind: "sync"; frame: SyncFrame } | { kind: "comment"; text: string };

/**
 * Read an SSE response, parsing frames, until `until` returns true or the
 * stream ends. Cancels the body afterwards, which is what a phone dropping
 * the connection looks like to the server.
 */
export async function readSse(res: Response, until: (frames: Frame[]) => boolean, timeoutMs = 3000): Promise<Frame[]> {
  if (res.status !== 200 || !res.body) throw new Error(`sse: status ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(frames)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`sse: timed out with ${frames.length} frames`);
      const r = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("sse: read timed out")), remaining))]);
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let ix: number;
      while ((ix = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, ix);
        buf = buf.slice(ix + 2);
        const f = parseFrame(block);
        if (f) frames.push(f);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

function parseFrame(block: string): Frame | null {
  let id: number | null = null;
  let event = "message";
  let data = "";
  let comment: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) comment = line.slice(1).trim();
    else if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (comment !== null && !data) return { kind: "comment", text: comment };
  if (!data) return null;
  if (event === "sync") return { kind: "sync", frame: JSON.parse(data) as SyncFrame };
  return { kind: "event", id: id ?? -1, ev: JSON.parse(data) as ThreadEvent };
}

export const eventSeqs = (frames: Frame[]): number[] => frames.filter((f): f is Extract<Frame, { kind: "event" }> => f.kind === "event").map((f) => f.ev.seq);
export const events = (frames: Frame[]): ThreadEvent[] => frames.filter((f): f is Extract<Frame, { kind: "event" }> => f.kind === "event").map((f) => f.ev);
