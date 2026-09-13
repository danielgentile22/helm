import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, ThreadEvent, ThreadId, ThreadSummary, TurnId } from "../shared/protocol";
import { HelmClient, HttpError } from "./api";
import { FakeES } from "./testkit";
import { initialState, ThreadSession, type ThreadState } from "./thread";

const threadId = "t-1" as ThreadId;
const config = { threadId, cwd: "/v", model: "m" as never, effort: "high", permissionMode: "ask", title: null, createdAt: "", archivedAt: null } as const;
const summary: ThreadSummary = { config, headSeq: 4 as Seq, session: "idle", lastTurnEndedAt: null, lastOutcome: null, contextTokens: null, preview: null, doing: null, usageTotal: null, contextWindow: null, waiting: false };
const origin = { via: "pwa", label: "iphone" } as const;
const ev = (seq: number, body: object): ThreadEvent => ({ seq: seq as Seq, ts: "", ...body }) as ThreadEvent;
const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: null, contextTokens: 4, contextWindow: 200_000, durationMs: 5 };

/** One prompt and its answer, as the server would replay them from seq 1. */
const log: ThreadEvent[] = [
  ev(1, { kind: "thread.created", config }),
  ev(2, { kind: "input.queued", clientMsgId: "c1", text: "hi", uploads: [], origin }),
  ev(3, { kind: "turn.started", turnId: "t:3" as TurnId, clientMsgId: "c1", model: "m", effort: "high", spawned: true }),
  ev(4, { kind: "assistant.text", turnId: "t:3" as TurnId, blockIx: 0, delta: "Hello" }),
  ev(5, { kind: "thread.config", patch: { title: "Greeting" }, origin }),
  ev(6, { kind: "turn.ended", turnId: "t:3" as TurnId, outcome: "ok", sessionId: "s", usage, error: null }),
];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function open() {
  FakeES.instances = [];
  const fetched: string[] = [];
  const fetch = (async (url: string) => {
    fetched.push(url);
    return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const api = new HelmClient({ baseUrl: "http://x", fetch, EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4 });
  let state: ThreadState = initialState(summary);
  const session = new ThreadSession(api, threadId, "iphone", { get: () => state, set: (next) => (state = next) });
  return { session, fetched, es: () => FakeES.instances.at(-1)! };
}

test("title, context window and session state come from the events and the sync frame, with no REST refetch on turn end", async () => {
  const { session, fetched, es } = open();
  assert.equal(session.view.config.title, null);
  assert.equal(session.view.logHead, 4, "the summary's head is the replay denominator until sync says otherwise");
  es().open();
  for (const e of log) es().send(e);
  es().sync({ headSeq: 6 as Seq, session: "idle" });
  await tick();
  assert.equal(session.view.config.title, "Greeting");
  assert.equal(session.view.contextWindow, 200_000);
  assert.equal(session.view.contextTokens, 4);
  assert.deepEqual(session.view.usageTotal, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 });
  assert.equal(session.view.session, "idle");
  assert.equal(session.view.logHead, 6);
  assert.equal(session.conn, "live");
  assert.equal(session.running, false);
  assert.deepEqual(fetched, ["http://x/api/threads/t-1/commands"], "the only fetch is the command list");
  session.stop();
});

test("a shorter server log resets the view and the stream together: the phone replays from zero and shows only the new log", async () => {
  const { session, es } = open();
  const first = es();
  first.open();
  for (const e of log) first.send(e);
  assert.equal(session.view.turns.length, 1);
  first.sync({ headSeq: 3 as Seq, session: "cold" });
  assert.deepEqual([session.view.headSeq, session.view.logHead, session.view.session, session.view.turns.length, session.config.title], [0, 3, "cold", 0, "Greeting"], "head and session come from the frame; the config it had stays until seq 1 replays it, so the screen never lacks one");
  await tick();
  const second = es();
  assert.notEqual(second, first);
  assert.equal(second.url, "http://x/api/threads/t-1/events?after=0");
  assert.equal(session.conn, "connecting");
  second.open();
  for (const e of log.slice(0, 3)) second.send(e);
  second.sync({ headSeq: 3 as Seq, session: "running", openTurn: "t:3" as TurnId });
  assert.deepEqual([session.view.headSeq, session.view.turns.length, session.view.config.title, session.view.openTurn, session.conn], [3, 1, null, "t:3", "live"]);
  assert.equal(session.running, true);
  session.stop();
});

test("a gap in the stream reconnects from the last seen seq without touching the fold", async () => {
  const { session, es } = open();
  const first = es();
  first.open();
  for (const e of log.slice(0, 3)) first.send(e);
  first.send(log[4]!);
  assert.equal(session.view.headSeq, 3, "the out-of-order event never reached the fold");
  await tick();
  assert.equal(es().url, "http://x/api/threads/t-1/events?after=3");
  assert.equal(session.conn, "replaying");
  session.stop();
});

test("a failed send keeps the pending prompt and records the error until dismissed", async () => {
  FakeES.instances = [];
  const fetch = (async (url: string) => new Response(JSON.stringify({ error: url.endsWith("/send") ? "no such thread" : "unavailable" }), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;
  const api = new HelmClient({ baseUrl: "http://x", fetch, EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4 });
  let state: ThreadState = initialState(summary);
  const session = new ThreadSession(api, threadId, "iphone", { get: () => state, set: (next) => (state = next) });
  await session.submit("hi", []);
  assert.equal(session.view.turns[0]?.prompt?.state, "pending");
  assert.equal(session.view.turns[0]?.prompt?.label, "iphone");
  assert.equal(session.error, "Send failed: no such thread");
  assert.equal(session.commandsError, "unavailable");
  session.error = null;
  assert.equal(session.error, null);
  session.stop();
});

test("an answer posts the ask id and body; a 409 records no error because the event settles the card", async () => {
  FakeES.instances = [];
  const posted: { url: string; body: unknown }[] = [];
  let status = 204;
  const fetch = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("/answer")) return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "content-type": "application/json" } });
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ error: "already answered" }), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const api = new HelmClient({ baseUrl: "http://x", fetch, EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4 });
  let state: ThreadState = initialState(summary);
  const session = new ThreadSession(api, threadId, "iphone", { get: () => state, set: (next) => (state = next) });

  await session.answer("a1" as never, { kind: "deny", reason: "not yet" });
  assert.deepEqual(posted, [{ url: "http://x/api/threads/t-1/answer", body: { askId: "a1", answer: { kind: "deny", reason: "not yet" } } }]);
  assert.equal(session.error, null);

  status = 409;
  await assert.rejects(session.answer("a1" as never, { kind: "allow" }), (err: unknown) => err instanceof HttpError && err.status === 409);
  assert.equal(session.error, null, "another device won the race, which is not this phone's failure");

  status = 503;
  await assert.rejects(session.answer("a1" as never, { kind: "allow" }));
  assert.equal(session.error, "Answer failed: already answered");
  session.stop();
});
