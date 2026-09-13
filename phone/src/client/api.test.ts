import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, SyncFrame, ThreadEvent, ThreadId, UploadId } from "../shared/protocol";
import { HelmClient } from "./api";
import { FakeES } from "./testkit";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function client() {
  FakeES.instances = [];
  const c = new HelmClient({ baseUrl: "http://x", EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4, document: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} } });
  const seen: number[] = [];
  const states: string[] = [];
  const syncs: SyncFrame[] = [];
  const resets: number[] = [];
  const stop = c.attach("t1" as ThreadId, 3 as Seq, { onEvent: (ev: ThreadEvent) => seen.push(ev.seq), onSync: (f) => syncs.push(f), onReset: () => resets.push(seen.length), onState: (s) => states.push(s) });
  return { seen, states, syncs, resets, stop };
}

test("attach opens from the cursor, forwards contiguous events, and reports sync as live", async () => {
  const { seen, states, syncs, stop } = client();
  const es = FakeES.instances[0]!;
  assert.equal(es.url, "http://x/api/threads/t1/events?after=3");
  es.open();
  es.emit(4);
  es.emit(5);
  es.sync({ headSeq: 5 as Seq });
  assert.deepEqual(seen, [4, 5]);
  assert.equal(syncs.length, 1);
  assert.equal(states.at(-1), "live");
  stop();
  assert.equal(es.closed, true);
});

test("a gap or a duplicate drops the connection and re-attaches from the last seen seq", async () => {
  const { seen, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.emit(4);
  es.emit(6); // gap
  assert.deepEqual(seen, [4]);
  assert.equal(es.closed, true);
  await tick();
  const es2 = FakeES.instances[1]!;
  assert.equal(es2.url, "http://x/api/threads/t1/events?after=4");
  es2.open();
  es2.emit(4); // duplicate
  assert.equal(es2.closed, true);
  await tick();
  assert.equal(FakeES.instances[2]!.url, "http://x/api/threads/t1/events?after=4");
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
  es.sync({ headSeq: 1 as Seq });
  assert.deepEqual([syncs.length, resets], [0, [0]], "a reset, not a sync: the frame belongs to a log the phone is about to throw away");
  await tick();
  assert.equal(FakeES.instances[1]!.url, "http://x/api/threads/t1/events?after=0");
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
