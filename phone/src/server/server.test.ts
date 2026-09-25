import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSessionId, ClientMsgId, ModelId, PushPayload, ThreadId, TurnId, Usage } from "../shared/protocol";
import { FakeAgentFactory, defaultUsage } from "./core/agent.fake";
import { ThreadLog } from "./core/log";
import { mirrorPath } from "./core/mirror";
import { ThreadStore } from "./core/thread-store";
import { buildServer } from "./server";

const threadId = "0f0f0f0f-0000-4000-8000-000000000042" as ThreadId;
const model = "claude-opus-5" as ModelId;
const usage: Usage = defaultUsage;

async function appendTurn(log: ThreadLog, msgId: string, prompt: string, reply: string): Promise<void> {
  await log.append({ kind: "input.queued", clientMsgId: msgId as ClientMsgId, text: prompt, uploads: [], origin: { via: "pwa", label: "iphone" } });
  const start = await log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: msgId as ClientMsgId, model, effort: "high" as const, spawned: false }));
  await log.append({ kind: "assistant.text", turnId: start.turnId, blockIx: 0, delta: reply });
  await log.append({ kind: "turn.ended", turnId: start.turnId, outcome: "ok", sessionId: "sess-1" as ClaudeSessionId, usage, error: null });
}

test("boot attaches watchers before recovery and resumes the mirror after repair", async () => {
  const home = await mkdtemp(join(tmpdir(), "helm2-boot-"));
  const vault = join(home, "vault");
  const threadsRoot = join(home, "threads");
  await mkdir(vault, { recursive: true });
  await new ThreadStore(threadsRoot).create({ threadId, cwd: vault, model, effort: "high", permissionMode: "bypass", title: "Seeded" });
  const seeded = await ThreadLog.open(threadId, join(threadsRoot, threadId));
  await appendTurn(seeded, "m1", "first prompt", "first reply");
  const note = mirrorPath(vault, threadId);
  await assert.rejects(readFile(note), { code: "ENOENT" }, "no mirror note exists before boot");

  const pushed: PushPayload[] = [];
  const server = await buildServer(
    {
      home,
      vaultRoot: vault,
      hostname: "mac.test.ts.net",
      apiKey: "k",
      vapid: { publicKey: "p", privateKey: "s", subject: "mailto:t@example.com" },
      browseRoots: [vault],
      additionalDirectories: [],
      sessionTtlMs: 1000,
      staticDir: join(home, "static"),
      version: "0.0.0-test",
    },
    { agents: new FakeAgentFactory(), pushSend: async (_sub, payload) => void pushed.push(payload) },
  );

  assert.deepEqual(server.recovered, [threadId]);
  const afterBoot = await readFile(note, "utf8");
  assert.equal(afterBoot.match(/^## /gm)?.length, 1, "resume wrote the turn recovery found");

  const log = await server.logs.get(threadId);
  await server.push.subscribe({ endpoint: "https://push.example/phone", keys: { p256dh: "p", auth: "a" }, label: "iphone", createdAt: "2026-09-13T00:00:00.000Z" });
  await appendTurn(log, "m2", "second prompt", "second reply");
  await server.mirror.idle();
  assert.equal((await readFile(note, "utf8")).match(/^## /gm)?.length, 2, "the recovered log's watcher mirrors a new turn");
  for (let i = 0; i < 200 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(pushed.length, 1, "the recovered log's push watcher fires with only the mirror alongside it");

  await server.shutdown();
  await rm(home, { recursive: true, force: true });
});
