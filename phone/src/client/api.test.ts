import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, SyncFrame, ThreadEvent, ThreadId } from "../shared/protocol";
import { HelmClient, type EventSourceLike } from "./api";

/** A scripted EventSource: the test drives it by calling emit / sync / fail. */
class FakeES implements EventSourceLike {
  static instances: FakeES[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  private listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  closed = false;
  constructor(readonly url: string) {
    FakeES.instances.push(this);
  }
  addEventListener(type: string, l: (ev: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  emit(seq: number): void {
    this.onmessage?.({ data: JSON.stringify({ seq, ts: "", kind: "thread.archived" }), lastEventId: String(seq) });
  }
  sync(frame: Partial<SyncFrame>): void {
    for (const l of this.listeners.get("sync") ?? []) l({ data: JSON.stringify({ headSeq: 0, session: "idle", openTurn: null, queuedCount: 0, ...frame }) });
  }
  fail(): void {
    this.onerror?.({});
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function client() {
  FakeES.instances = [];
  const c = new HelmClient({ baseUrl: "http://x", EventSource: FakeES, minBackoffMs: 1, maxBackoffMs: 4, document: { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} } });
  const seen: number[] = [];
  const states: string[] = [];
  const syncs: SyncFrame[] = [];
  const stop = c.attach("t1" as ThreadId, 3 as Seq, { onEvent: (ev: ThreadEvent) => seen.push(ev.seq), onSync: (f) => syncs.push(f), onState: (s) => states.push(s) });
  return { seen, states, syncs, stop };
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

test("a sync frame with a head behind the cursor restarts from zero", async () => {
  const { syncs, stop } = client();
  const es = FakeES.instances[0]!;
  es.open();
  es.sync({ headSeq: 1 as Seq });
  assert.equal(syncs.length, 1);
  await tick();
  assert.equal(FakeES.instances[1]!.url, "http://x/api/threads/t1/events?after=0");
  stop();
});

test("call() surfaces the server's error message with its status", async () => {
  const c = new HelmClient({ baseUrl: "http://x", fetch: (async () => new Response(JSON.stringify({ error: "no such thread" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch });
  await assert.rejects(c.getThread("zz" as ThreadId), (err: Error & { status?: number }) => err.message === "no such thread" && err.status === 404);
});
