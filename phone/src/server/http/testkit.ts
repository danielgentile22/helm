/**
 * In-process stack for the primary suite: the production graph from the
 * composition root over a temp home, with the scripted fake agent and a
 * push delivery stubbed out. `restart()` builds a fresh stack over the same home
 * to simulate a server crash and reboot.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncFrame, ThreadEvent } from "../../shared/protocol";
import { FakeAgentFactory, echoScript, type FakeScript } from "../core/agent.fake";
import type { LogRegistry } from "../core/log";
import type { PushSubscriptionRecord } from "../core/push";
import type { Supervisor } from "../core/supervisor";
import type { Offers } from "../core/offers";
import { buildServer } from "../server";

export const API_KEY = "test-key-123";
export const HOST = "mac.test.ts.net";

export interface Stack {
  readonly home: string;
  readonly fetch: (req: Request) => Promise<Response>;
  readonly agents: FakeAgentFactory;
  readonly logs: LogRegistry;
  readonly supervisor: Supervisor;
  /** What the model's `send_to_phone` tool calls; tests call it directly since the fake agent has no tools. */
  readonly offers: Offers;
  /** The subscriptions on disk, the way a reboot would read them. */
  subscriptions(): Promise<PushSubscriptionRecord[]>;
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

  const agents = new FakeAgentFactory(script);
  const server = await buildServer(
    {
      home: h,
      vaultRoot: join(h, "work"),
      hostname: HOST,
      apiKey: "apiKey" in opts ? opts.apiKey : API_KEY,
      vapid: { publicKey: "vapid-public", privateKey: "vapid-private", subject: "mailto:test@example.com" },
      browseRoots: [join(h, "work")],
      sessionTtlMs: 3600_000,
      staticDir,
      version: "0.0.0-test",
      idleParkMs: 60_000,
      heartbeatMs: 60_000,
    },
    { agents, pushSend: async () => undefined },
  );

  const stack: Stack = {
    home: h,
    fetch: server.fetch,
    agents,
    logs: server.logs,
    supervisor: server.supervisor,
    offers: server.offers,
    subscriptions: async () => Object.values(JSON.parse(await readFile(join(h, "push", "subscriptions.json"), "utf8").catch(() => "{}")) as Record<string, PushSubscriptionRecord>),
    api: (method, path, body, headers = {}) =>
      server.fetch(
        new Request(`https://${HOST}${path}`, {
          method,
          headers: { "x-helm-key": API_KEY, ...(body !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body))) } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      ),
    restart: (nextScript) => buildStack(nextScript ?? script, h, opts),
    shutdown: () => server.shutdown(),
    cleanup: async () => {
      await server.shutdown();
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
