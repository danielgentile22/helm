import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMsgId, ModelId, ThreadEvent, ThreadId } from "../../shared/protocol";
import { FakeAgentFactory, echoScript, type FakeScript } from "./agent.fake";
import { LogRegistry } from "./log";
import { Supervisor, titleFrom } from "./supervisor";
import { ThreadStore } from "./thread-store";

const origin = { via: "pwa", label: "iphone" } as const;
const model = "claude-opus-5" as ModelId;

async function harness(script: FakeScript = echoScript, idleParkMs = 60_000) {
  const home = await mkdtemp(join(tmpdir(), "helm2-sup-"));
  const threadsRoot = join(home, "threads");
  const logs = new LogRegistry(threadsRoot);
  const threads = new ThreadStore(threadsRoot);
  const agents = new FakeAgentFactory(script);
  const sup = new Supervisor(logs, threads, agents, { additionalDirectories: [], idleParkMs });
  const threadId = "0f0f0f0f-0000-4000-8000-00000000abcd" as ThreadId;
  await threads.create({ threadId, cwd: home, model, effort: "high" });
  const log = await logs.get(threadId);
  await log.append({ kind: "thread.created", config: (await threads.get(threadId))! });
  const kinds = async (): Promise<string[]> => {
    const out: string[] = [];
    for await (const ev of log.read(0)) out.push(ev.kind === "turn.ended" ? `${ev.kind}:${ev.outcome}` : ev.kind === "input.dropped" ? `${ev.kind}:${ev.reason}` : ev.kind);
    return out;
  };
  const events = async (): Promise<ThreadEvent[]> => {
    const out: ThreadEvent[] = [];
    for await (const ev of log.read(0)) out.push(ev);
    return out;
  };
  /** Resolves on the next turn.ended appended to the log. */
  const nextTurnEnd = (): Promise<ThreadEvent> =>
    new Promise((resolve) => {
      const unsub = log.subscribe((ev) => {
        if (ev.kind === "turn.ended") {
          unsub();
          resolve(ev);
        }
      });
    });
  const cleanup = async (): Promise<void> => {
    await sup.shutdown();
    await rm(home, { recursive: true });
  };
  return { home, logs, threads, agents, sup, threadId, log, kinds, events, nextTurnEnd, cleanup };
}

const msg = (id: string, text = "hello there") => ({ clientMsgId: id as ClientMsgId, text, uploads: [], origin });

test("send on a cold thread: input.queued is on disk before send resolves, a turn runs, the thread is titled", async () => {
  const h = await harness();
  const ended = h.nextTurnEnd();
  const res = await h.sup.send(h.threadId, msg("m1", "Summarize my week\nsecond line"));
  assert.deepEqual(res, { accepted: true, state: "running", seq: 2 });
  const onDisk = await readFile(join(h.home, "threads", h.threadId, "events.jsonl"), "utf8");
  assert.ok(onDisk.includes('"kind":"input.queued"'));

  await ended;
  assert.deepEqual(await h.kinds(), ["thread.created", "input.queued", "thread.config", "turn.started", "session.bound", "assistant.text", "turn.ended:ok"]);
  const evs = await h.events();
  const started = evs.find((e) => e.kind === "turn.started");
  assert.ok(started && started.kind === "turn.started" && started.turnId === `t:${started.seq}` && started.spawned === true && started.model === model);
  assert.equal((await h.threads.get(h.threadId))!.title, "Summarize my week");
  assert.equal(h.sup.status(h.threadId).session, "idle");
  assert.equal(h.log.getHead().sessionId, "fake-session-1");
  await h.cleanup();
});

test("a duplicate clientMsgId is accepted once and returns the original seq", async () => {
  const h = await harness();
  const ended = h.nextTurnEnd();
  const first = await h.sup.send(h.threadId, msg("m1"));
  const dup = await h.sup.send(h.threadId, msg("m1"));
  assert.deepEqual(dup, { accepted: true, state: "duplicate", seq: first.accepted ? first.seq : -1 });
  await ended;
  assert.equal((await h.kinds()).filter((k) => k === "input.queued").length, 1);
  assert.equal(h.agents.last.sends.length, 1);
  await h.cleanup();
});

test("send while running is queued and runs next, in order, on the same process", async () => {
  const h = await harness(async (t) => {
    if (t.input.text === "slow") await new Promise((r) => setTimeout(r, 30));
    t.text(`done ${t.input.text}`);
    t.end();
  });
  const r1 = await h.sup.send(h.threadId, msg("m1", "slow"));
  const r2 = await h.sup.send(h.threadId, msg("m2", "second"));
  const r3 = await h.sup.send(h.threadId, msg("m3", "third"));
  assert.equal(r1.accepted && r1.state, "running");
  assert.equal(r2.accepted && r2.state, "queued");
  assert.equal(r3.accepted && r3.state, "queued");
  assert.ok(["warming", "running"].includes(h.sup.status(h.threadId).session));

  await waitFor(async () => (await h.kinds()).filter((k) => k.startsWith("turn.ended")).length === 3);
  const evs = await h.events();
  const order = evs.filter((e) => e.kind === "turn.started").map((e) => e.kind === "turn.started" && e.clientMsgId);
  assert.deepEqual(order, ["m1", "m2", "m3"]);
  assert.equal(h.agents.sessions.length, 1, "one process for all three turns");
  assert.equal(h.log.getHead().queued.length, 0);
  await h.cleanup();
});

test("interrupt stops a hanging turn as interrupted; interrupt when idle is a no-op", async () => {
  const h = await harness(async (t) => {
    t.text("working");
    await t.interrupted;
  });
  await h.sup.interrupt(h.threadId); // cold: nothing happens
  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m1"));
  await waitFor(async () => (await h.kinds()).includes("assistant.text"));
  await h.sup.interrupt(h.threadId);
  const end = await ended;
  assert.equal(end.kind === "turn.ended" && end.outcome, "interrupted");
  await waitFor(async () => h.sup.status(h.threadId).session === "idle");
  await h.sup.interrupt(h.threadId); // idle: still nothing
  assert.equal(h.sup.status(h.threadId).session, "idle");
  await h.cleanup();
});

test("reconfigure persists, logs thread.config, applies to the live agent, and the next turn carries the new model", async () => {
  const h = await harness();
  await h.sup.send(h.threadId, msg("m1"));
  await waitFor(async () => h.sup.status(h.threadId).session === "idle");
  await h.sup.reconfigure(h.threadId, { model: "claude-sonnet-5" as ModelId, effort: "low" }, origin);
  const cfg = (await h.threads.get(h.threadId))!;
  assert.equal(cfg.model, "claude-sonnet-5");
  assert.equal(cfg.effort, "low");
  assert.deepEqual(h.agents.last.setModelCalls, ["claude-sonnet-5"]);
  assert.deepEqual(h.agents.last.setEffortCalls, ["low"]);

  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m2"));
  await ended;
  const evs = await h.events();
  const starts = evs.filter((e) => e.kind === "turn.started");
  assert.equal(starts[1]?.kind === "turn.started" && starts[1].model, "claude-sonnet-5");
  assert.equal(starts[1]?.kind === "turn.started" && starts[1].spawned, false);
  assert.ok(evs.some((e) => e.kind === "thread.config" && e.patch.model === "claude-sonnet-5"));
  await h.cleanup();
});

test("an idle thread parks after the timeout and the next send resumes the same session id on a new process", async () => {
  const h = await harness(echoScript, 20);
  await h.sup.send(h.threadId, msg("m1"));
  await waitFor(async () => h.sup.status(h.threadId).session === "parked");
  assert.equal(h.agents.sessions[0]!.killed, true);

  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m2"));
  await ended;
  assert.equal(h.agents.sessions.length, 2);
  assert.equal(h.agents.sessions[1]!.spawnOpts.resume, "fake-session-1");
  const evs = await h.events();
  const starts = evs.filter((e) => e.kind === "turn.started");
  assert.equal(starts[1]?.kind === "turn.started" && starts[1].spawned, true);
  await h.cleanup();
});

test("a process that dies mid-turn seals the turn with an error, the thread goes cold, and the next send resumes", async () => {
  let calls = 0;
  const h = await harness((t) => {
    calls += 1;
    if (calls === 1) {
      t.text("about to die");
      t.crash();
      return;
    }
    t.text("back");
    t.end();
  });
  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m1"));
  const end = await ended;
  assert.equal(end.kind === "turn.ended" && end.outcome, "error");
  assert.equal(end.kind === "turn.ended" && end.sessionId, "fake-session-1");
  await waitFor(async () => h.sup.status(h.threadId).session === "cold");

  const ended2 = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m2"));
  const end2 = await ended2;
  assert.equal(end2.kind === "turn.ended" && end2.outcome, "ok");
  assert.equal(h.agents.sessions[1]!.spawnOpts.resume, "fake-session-1");
  await h.cleanup();
});

test("archive kills the process, drops queued inputs, appends thread.archived, and marks the config", async () => {
  const h = await harness(async (t) => {
    t.text("x");
    await t.interrupted;
  });
  await h.sup.send(h.threadId, msg("m1"));
  await h.sup.send(h.threadId, msg("m2"));
  await waitFor(async () => (await h.kinds()).includes("assistant.text"));
  await h.sup.archive(h.threadId);
  const kinds = await h.kinds();
  assert.deepEqual(kinds.slice(-3), ["turn.ended:interrupted", "input.dropped:archived", "thread.archived"]);
  assert.equal(h.agents.last.killed, true);
  assert.ok((await h.threads.get(h.threadId))!.archivedAt);
  assert.equal(h.sup.status(h.threadId).session, "cold");
  assert.equal(h.log.getHead().queued.length, 0);
  const res = await h.sup.send(h.threadId, msg("m3"));
  assert.equal(res.accepted, false);
  await h.cleanup();
});

test("shutdown kills every live process", async () => {
  const h = await harness();
  const other = "0f0f0f0f-0000-4000-8000-00000000ef01" as ThreadId;
  await h.threads.create({ threadId: other, cwd: h.home, model, effort: "high" });
  await h.sup.send(h.threadId, msg("m1"));
  await h.sup.send(other, msg("m1"));
  await waitFor(async () => h.sup.status(h.threadId).session === "idle" && h.sup.status(other).session === "idle");
  await h.sup.shutdown();
  assert.deepEqual(h.agents.sessions.map((s) => s.killed), [true, true]);
  assert.equal(h.sup.status(h.threadId).session, "cold");
  await rm(h.home, { recursive: true });
});

test("titleFrom: first line, 60 chars max, no trailing punctuation", () => {
  assert.equal(titleFrom("  Fix the login bug.\nmore"), "Fix the login bug");
  assert.equal(titleFrom("a".repeat(80)), "a".repeat(60));
  assert.equal(titleFrom("What is this?"), "What is this");
  assert.equal(titleFrom("\n\n"), "Untitled");
});

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

test("hardening: concurrent sends with one clientMsgId queue exactly once", async () => {
  const h = await harness();
  const ended = h.nextTurnEnd();
  const results = await Promise.all(Array.from({ length: 5 }, () => h.sup.send(h.threadId, msg("same"))));
  await ended;
  assert.equal(results.filter((r) => r.accepted && r.state !== "duplicate").length, 1);
  assert.equal((await h.kinds()).filter((k) => k === "input.queued").length, 1);
  await h.cleanup();
});

test("hardening: shutdown during warming spawns nothing further and runs no turn", async () => {
  let spawned = 0;
  const h = await harness();
  const slowFactory = h.agents;
  const origSpawn = slowFactory.spawn.bind(slowFactory);
  slowFactory.spawn = async (opts) => {
    spawned += 1;
    await new Promise((r) => setTimeout(r, 30));
    return origSpawn(opts);
  };
  await h.sup.send(h.threadId, msg("m1"));
  assert.equal(h.sup.status(h.threadId).session, "warming");
  await h.sup.shutdown();
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(spawned <= 1);
  assert.ok(h.agents.sessions.every((s) => s.killed), "any process spawned during shutdown was killed");
  assert.equal((await h.kinds()).filter((k) => k.startsWith("turn.")).length, 0, "no turn ran after shutdown");
  assert.equal(h.sup.status(h.threadId).session, "cold");
  await rm(h.home, { recursive: true });
});

test("hardening: a throw inside a turn seals it and leaves the thread cold, not wedged", async () => {
  const h = await harness();
  h.agents.script = () => {
    throw new Error("script exploded synchronously");
  };
  h.agents.spawn = async () => ({ ...(await new FakeAgentFactory().spawn({ cwd: h.home, model, effort: "high", resume: null, additionalDirectories: [], appendSystemPrompt: "" })), send: () => { throw new Error("send exploded"); } }) as never;
  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m1"));
  const end = await ended;
  assert.equal(end.kind === "turn.ended" && end.outcome, "error");
  await waitFor(async () => h.sup.status(h.threadId).session === "cold");
  await h.cleanup();
});

test("hardening: a process that dies while idle is replaced on the next send instead of burning the message", async () => {
  const h = await harness();
  await h.sup.send(h.threadId, msg("m1"));
  await waitFor(async () => h.sup.status(h.threadId).session === "idle");
  h.agents.last.out.end(); // the process exited while idle
  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m2"));
  const end = await ended;
  assert.equal(end.kind === "turn.ended" && end.outcome, "ok");
  assert.equal(h.agents.sessions.length, 2);
  assert.equal(h.agents.sessions[1]!.spawnOpts.resume, "fake-session-1");
  await h.cleanup();
});

test("hardening: reconfigure during warming still applies to the turn that starts", async () => {
  const h = await harness();
  const origSpawn = h.agents.spawn.bind(h.agents);
  h.agents.spawn = async (opts) => {
    await new Promise((r) => setTimeout(r, 30));
    return origSpawn(opts);
  };
  const ended = h.nextTurnEnd();
  await h.sup.send(h.threadId, msg("m1"));
  await h.sup.reconfigure(h.threadId, { model: "claude-sonnet-5" as ModelId }, origin);
  await ended;
  const start = (await h.events()).find((e) => e.kind === "turn.started");
  assert.equal(start?.kind === "turn.started" && start.model, "claude-sonnet-5");
  assert.deepEqual(h.agents.last.setModelCalls, ["claude-sonnet-5"]);
  await h.cleanup();
});

test("hardening: concurrent thread.json patches do not lose updates", async () => {
  const h = await harness();
  await Promise.all([h.threads.patch(h.threadId, { title: "T" }), h.threads.patch(h.threadId, { model: "claude-sonnet-5" as ModelId }), h.threads.patch(h.threadId, { effort: "low" })]);
  const cfg = (await h.threads.get(h.threadId))!;
  assert.deepEqual([cfg.title, cfg.model, cfg.effort], ["T", "claude-sonnet-5", "low"]);
  await h.cleanup();
});
