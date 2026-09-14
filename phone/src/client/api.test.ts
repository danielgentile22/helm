import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, SyncFrame, ThreadEvent, ThreadId, TurnId, UploadId } from "../shared/protocol";
import { HelmClient, HttpError } from "./api";
import { FakeES } from "./testkit";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function client() {
  FakeES.instances = [];
  const c = new HelmClient({ baseUrl: "http://x", EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4, document: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} } });
  const seen: number[] = [];
  const states: string[] = [];
  const syncs: SyncFrame[] = [];
  const resets: number[] = [];
  const stop = c.attach("t1" as ThreadId, 0, { onEvent: (ev: ThreadEvent) => seen.push(ev.seq), onSync: (f) => syncs.push(f), onReset: (f) => resets.push(f.headSeq), onState: (s) => states.push(s) });
  return { seen, states, syncs, resets, stop };
}

test("attach opens from zero, forwards contiguous events, learns the generation from seq 1, and reports sync as live", async () => {
  const { seen, states, syncs, stop } = client();
  const es = FakeES.instances[0]!;
  assert.equal(es.url, "http://x/api/threads/t1/events?after=0");
  es.open();
  es.emit(1);
  es.emit(2);
  es.sync({ headSeq: 2 as Seq });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(syncs.length, 1);
  assert.equal(states.at(-1), "live");
  es.fail();
  await tick();
  assert.equal(FakeES.instances[1]!.url, "http://x/api/threads/t1/events?after=2&gen=0", "a reconnect carries the cursor and the generation it counts in");
  stop();
  assert.equal(FakeES.instances[1]!.closed, true);
});

test("a gap or a duplicate drops the connection and re-attaches from the last seen seq", async () => {
  const { seen, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.emit(1);
  es.emit(3); // gap
  assert.deepEqual(seen, [1]);
  assert.equal(es.closed, true);
  await tick();
  const es2 = FakeES.instances[1]!;
  assert.equal(es2.url, "http://x/api/threads/t1/events?after=1&gen=0");
  es2.open();
  es2.emit(1); // duplicate
  assert.equal(es2.closed, true);
  await tick();
  assert.equal(FakeES.instances[2]!.url, "http://x/api/threads/t1/events?after=1&gen=0");
  stop();
});

test("errors reconnect with backoff from the cursor; stop ends the loop", async () => {
  const { states, stop } = client();
  FakeES.instances[0]!.fail();
  await tick();
  assert.equal(FakeES.instances.length, 2);
  assert.ok(states.includes("offline"));
  stop();
  FakeES.instances[1]!.fail();
  await tick();
  assert.equal(FakeES.instances.length, 2, "no reconnect after stop");
});

test("a sync frame with a head behind the cursor tells the handlers to reset and restarts from zero", async () => {
  const { syncs, resets, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.emit(1);
  es.emit(2);
  es.emit(3);
  es.sync({ headSeq: 1 as Seq });
  assert.deepEqual([syncs.length, resets], [0, [1]], "a reset, not a sync: the frame belongs to a log the phone is about to throw away");
  await tick();
  assert.equal(FakeES.instances[1]!.url, "http://x/api/threads/t1/events?after=0&gen=0");
  stop();
});

test("a sync frame from another generation resets and reopens from zero carrying the new generation", async () => {
  const { seen, syncs, resets, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.emit(1);
  es.sync({ headSeq: 1 as Seq, generation: 0 as never });
  assert.equal(syncs.length, 1, "seq 1 was not a log.generation, so the log is generation 0 and the frame agrees");
  es.emit(2);
  es.sync({ headSeq: 9 as Seq, generation: 1 as never });
  assert.deepEqual([seen, resets], [[1, 2], [9]], "a head ahead of the cursor in another generation is still a reset");
  assert.equal(es.closed, true);
  await tick();
  const es2 = FakeES.instances[1]!;
  assert.equal(es2.url, "http://x/api/threads/t1/events?after=0&gen=1", "the replay from zero names the generation it was told about");
  es2.open();
  es2.send({ seq: 1 as Seq, ts: "", kind: "log.generation", generation: 1 as never });
  es2.emit(2);
  es2.sync({ headSeq: 2 as Seq, generation: 1 as never });
  assert.equal(syncs.length, 2, "the replayed log names generation 1 at seq 1, so the frame agrees");
  es2.fail();
  await tick();
  assert.equal(FakeES.instances[2]!.url, "http://x/api/threads/t1/events?after=2&gen=1", "a plain reconnect carries the cursor and its generation");
  stop();
});

test("a replay whose log turns out to be a newer generation than its sync frame claims is thrown away", async () => {
  const { syncs, resets, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.send({ seq: 1 as Seq, ts: "", kind: "log.generation", generation: 2 as never });
  es.emit(2);
  es.sync({ headSeq: 2 as Seq, generation: 1 as never });
  assert.deepEqual([syncs.length, resets], [0, [2]]);
  await tick();
  assert.equal(FakeES.instances[1]!.url, "http://x/api/threads/t1/events?after=0&gen=1");
  stop();
});

test("the command calls unwrap the envelope, and the upload URL is built once", async () => {
  const seen: { method: string; url: string }[] = [];
  const commands = [{ name: "grill", description: "Grill a plan", argumentHint: "<plan>" }];
  const c = new HelmClient({
    baseUrl: "http://x",
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url });
      return new Response(JSON.stringify({ commands }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await c.listCommands("t1" as ThreadId), commands);
  assert.deepEqual(await c.reloadCommands("t1" as ThreadId), commands);
  assert.deepEqual(seen, [
    { method: "GET", url: "http://x/api/threads/t1/commands" },
    { method: "POST", url: "http://x/api/threads/t1/commands/reload" },
  ]);
  assert.equal(c.uploadUrl("t1" as ThreadId, "u9" as UploadId), "http://x/api/threads/t1/uploads/u9");
});

test("a 503 from the command endpoint reaches the caller as an HttpError to fall back on", async () => {
  const c = new HelmClient({ baseUrl: "http://x", fetch: (async () => new Response(JSON.stringify({ error: "commands unavailable" }), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch });
  await assert.rejects(c.listCommands("t1" as ThreadId), (err: Error & { status?: number }) => err.status === 503 && err.message === "commands unavailable");
});

test("call() surfaces the server's error message with its status", async () => {
  const c = new HelmClient({ baseUrl: "http://x", fetch: (async () => new Response(JSON.stringify({ error: "no such thread" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch });
  await assert.rejects(c.getThread("zz" as ThreadId), (err: Error & { status?: number }) => err.message === "no such thread" && err.status === 404);
});

test("forkThread posts the turn id to the source thread and hands back the new summary", async () => {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const summary = { config: { threadId: "t2" }, headSeq: 4 };
  const c = new HelmClient({
    baseUrl: "http://x",
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(summary), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await c.forkThread("t1" as ThreadId, "t:6" as TurnId), summary);
  assert.deepEqual(seen, [{ method: "POST", url: "http://x/api/threads/t1/fork", body: { turnId: "t:6" } }]);
});

test("a 409 from the fork endpoint reaches the caller as an HttpError, so the screen can say why", async () => {
  const c = new HelmClient({ baseUrl: "http://x", fetch: (async () => new Response(JSON.stringify({ error: "the turn is still running" }), { status: 409, headers: { "content-type": "application/json" } })) as typeof fetch });
  await assert.rejects(c.forkThread("t1" as ThreadId, "t:6" as TurnId), (err: Error) => err instanceof HttpError && err.status === 409 && err.message === "the turn is still running");
});
