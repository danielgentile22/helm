import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushService, payloadFor, type PushSubscriptionRecord } from "./push";
import { ThreadLog } from "./log";
import { ThreadStore } from "./thread-store";
import type {
  ClientMsgId,
  EventOf,
  ModelId,
  PushPayload,
  Seq,
  ThreadId,
  TurnId,
  TurnOutcome,
} from "../../shared/protocol";

const threadId = "0f0f0f0f-0000-4000-8000-000000000042" as ThreadId;
const turnId = "t:4" as TurnId;
const origin = { via: "pwa", label: "iphone" } as const;
const vapid = { publicKey: "pub-key", privateKey: "priv-key", subject: "mailto:d@example.com" };

function endedEvent(outcome: TurnOutcome, error: string | null = null, seq = 9): EventOf<"turn.ended"> {
  return {
    kind: "turn.ended",
    seq: seq as Seq,
    ts: "2026-09-11T00:00:00.000Z",
    turnId,
    outcome,
    sessionId: null,
    usage: null,
    error,
  };
}

function sub(endpoint: string, label = "iphone"): PushSubscriptionRecord {
  return { endpoint, keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` }, label, createdAt: "2026-09-11T00:00:00.000Z" };
}

async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function settle(ms = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function readFileRecords(file: string): Promise<readonly PushSubscriptionRecord[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, PushSubscriptionRecord>;
  return Object.values(parsed);
}

// ---------------------------------------------------------------------------
// Pure: payloadFor
// ---------------------------------------------------------------------------

test("payloadFor renders the title, the outcome, and the preview", () => {
  const ok = payloadFor(threadId, "Vault cleanup", endedEvent("ok"), "All done, three files moved.");
  assert.deepEqual(ok, {
    threadId,
    title: "Vault cleanup",
    body: "All done, three files moved.",
    kind: "ok",
    seq: 9 as Seq,
    url: `/t/${threadId}#end`,
  } satisfies PushPayload);

  assert.equal(payloadFor(threadId, null, endedEvent("ok"), "hi").title, "Helm");
  assert.equal(payloadFor(threadId, "T", endedEvent("error", "spawn failed"), null).body, "Error: spawn failed");
  assert.equal(payloadFor(threadId, "T", endedEvent("interrupted"), "partial text").body, "Interrupted");
  assert.equal(payloadFor(threadId, "T", endedEvent("orphaned"), null).body, "Server restarted while this turn was running; resend if needed");
  assert.equal(payloadFor(threadId, "T", endedEvent("ok"), null).body, "Turn finished");
  const body = (preview: string | null): string => payloadFor(threadId, "T", endedEvent("ok"), preview).body;
  assert.equal(body("   \n  "), "Turn finished", "whitespace is not a preview");
  assert.equal(body("\n\n  Renamed four files.  \nThen ran the tests.\n"), "Renamed four files.", "the first non-empty line, trimmed");

  assert.deepEqual(
    (["ok", "error", "interrupted", "orphaned"] as const).map((o) => payloadFor(threadId, "T", endedEvent(o, "boom"), "hi").kind),
    ["ok", "error", "interrupted", "orphaned"],
    "the outcome travels as its own field, not parsed out of the body",
  );

  const long = "x".repeat(400);
  assert.equal(payloadFor(threadId, "T", endedEvent("ok"), long).body, "x".repeat(120));

  assert.equal(payloadFor(threadId, "T", endedEvent("ok"), "hi").seq, 9 as Seq);
  assert.equal(payloadFor(threadId, "T", endedEvent("ok", null, 31), "hi").seq, 31 as Seq);
});

// ---------------------------------------------------------------------------
// Integration against a real log and a real thread store
// ---------------------------------------------------------------------------

interface Rig {
  readonly home: string;
  readonly file: string;
  readonly log: ThreadLog;
  readonly threads: ThreadStore;
  readonly sent: { endpoint: string; payload: PushPayload }[];
  readonly push: PushService;
  cleanup(): Promise<void>;
}

async function rig(opts: { title?: string | null; fail?: (endpoint: string) => unknown } = {}): Promise<Rig> {
  const home = await mkdtemp(join(tmpdir(), "helm2-push-"));
  const threadsRoot = join(home, "threads");
  const file = join(home, "push", "subscriptions.json");
  const threads = new ThreadStore(threadsRoot);
  await threads.create({ threadId, cwd: home, model: "claude-opus-5" as ModelId, effort: "high", title: opts.title ?? "Vault cleanup" });
  const log = await ThreadLog.open(threadId, join(threadsRoot, threadId));
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const push = new PushService(file, vapid, threads, {
    send: async (record, payload) => {
      const err = opts.fail?.(record.endpoint);
      if (err) throw err;
      sent.push({ endpoint: record.endpoint, payload });
    },
  });
  return {
    home,
    file,
    log,
    threads,
    sent,
    push,
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

/** A turn that says something, then ends. */
async function runTurn(log: ThreadLog, text = "Moved three notes into the inbox."): Promise<void> {
  await log.append({ kind: "turn.started", turnId, clientMsgId: "m1" as ClientMsgId, model: "claude-opus-5" as ModelId, effort: "high", spawned: true });
  await log.append({ kind: "assistant.text", turnId, blockIx: 0, delta: text });
  await log.append({ kind: "turn.ended", turnId, outcome: "ok", sessionId: null, usage: null, error: null });
}

test("watch sends the payload to every subscription when nobody is watching", async () => {
  const r = await rig();
  try {
    await r.push.subscribe(sub("https://push.example/a"));
    await r.push.subscribe(sub("https://push.example/b"));
    r.push.watch(r.log);

    await runTurn(r.log);
    await waitFor(() => r.sent.length === 2, "two sends");

    assert.deepEqual(
      r.sent.map((s) => s.endpoint).sort(),
      ["https://push.example/a", "https://push.example/b"],
    );
    for (const s of r.sent) {
      assert.equal(s.payload.title, "Vault cleanup");
      assert.equal(s.payload.body, "Moved three notes into the inbox.");
      assert.equal(s.payload.url, `/t/${threadId}#end`);
      assert.equal(s.payload.threadId, threadId);
    }
  } finally {
    await r.cleanup();
  }
});

test("watch stays quiet while an SSE subscriber is attached", async () => {
  const r = await rig();
  try {
    await r.push.subscribe(sub("https://push.example/a"));
    r.push.watch(r.log);
    const detach = r.log.subscribe("viewer", () => undefined);

    await runTurn(r.log);
    await settle();
    assert.deepEqual(r.sent, []);

    // Phone closes the app; the next turn does notify.
    detach();
    await r.log.append({ kind: "turn.started", turnId: "t:7" as TurnId, clientMsgId: "m2" as ClientMsgId, model: "claude-opus-5" as ModelId, effort: "high", spawned: false });
    await r.log.append({ kind: "turn.ended", turnId: "t:7" as TurnId, outcome: "ok", sessionId: null, usage: null, error: null });
    await waitFor(() => r.sent.length === 1, "one send after detach");
  } finally {
    await r.cleanup();
  }
});

test("a projection subscriber does not count as a viewer, and every outcome notifies", async () => {
  const r = await rig();
  try {
    await r.push.subscribe(sub("https://push.example/a"));
    r.push.watch(r.log);
    r.log.subscribe("projection", () => undefined);

    const outcomes: TurnOutcome[] = ["ok", "error", "interrupted", "orphaned"];
    for (const [i, outcome] of outcomes.entries()) {
      const t = `t:${i}` as TurnId;
      await r.log.append({ kind: "turn.started", turnId: t, clientMsgId: `m${i}` as ClientMsgId, model: "claude-opus-5" as ModelId, effort: "high", spawned: false });
      await r.log.append({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "partial" });
      await r.log.append({ kind: "turn.ended", turnId: t, outcome, sessionId: null, usage: null, error: outcome === "error" ? "boom" : null });
    }
    await waitFor(() => r.sent.length === outcomes.length, "one send per outcome");
    assert.deepEqual(r.sent.map((s) => s.payload.kind), outcomes, "no other event kind fired a send");
  } finally {
    await r.cleanup();
  }
});

test("a 410 from the push service drops that subscription from the file", async () => {
  const dead = "https://push.example/dead";
  const r = await rig({
    fail: (endpoint) => (endpoint === dead ? Object.assign(new Error("Gone"), { statusCode: 410, endpoint }) : undefined),
  });
  try {
    await r.push.subscribe(sub("https://push.example/live"));
    await r.push.subscribe(sub(dead));
    r.push.watch(r.log);

    await runTurn(r.log);
    await waitFor(() => r.sent.length === 1, "the live send");
    await settle();

    const records = await readFileRecords(r.file);
    assert.deepEqual(records.map((x) => x.endpoint), ["https://push.example/live"]);

    // The surviving subscription still gets later turns.
    await r.log.append({ kind: "turn.started", turnId: "t:8" as TurnId, clientMsgId: "m3" as ClientMsgId, model: "claude-opus-5" as ModelId, effort: "high", spawned: false });
    await r.log.append({ kind: "turn.ended", turnId: "t:8" as TurnId, outcome: "ok", sessionId: null, usage: null, error: null });
    await waitFor(() => r.sent.length === 2, "the second live send");
  } finally {
    await r.cleanup();
  }
});

test("a sender that throws a plain error does not block the other subscriptions", async () => {
  const r = await rig({ fail: (endpoint) => (endpoint === "https://push.example/broken" ? new Error("socket hang up") : undefined) });
  try {
    await r.push.subscribe(sub("https://push.example/broken"));
    await r.push.subscribe(sub("https://push.example/ok"));
    r.push.watch(r.log);

    await runTurn(r.log);
    await waitFor(() => r.sent.length === 1, "the working send");
    assert.equal(r.sent[0]!.endpoint, "https://push.example/ok");

    // A transient failure is not a dead subscription, so nothing is removed.
    const records = await readFileRecords(r.file);
    assert.equal(records.length, 2);
  } finally {
    await r.cleanup();
  }
});

test("subscribe is idempotent on endpoint and unsubscribe removes the record", async () => {
  const r = await rig();
  try {
    await r.push.subscribe(sub("https://push.example/a", "iphone"));
    await r.push.subscribe(sub("https://push.example/a", "iphone-renamed"));
    let records = await readFileRecords(r.file);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.label, "iphone-renamed");

    await r.push.unsubscribe("https://push.example/a");
    records = await readFileRecords(r.file);
    assert.deepEqual(records, []);

    // Unsubscribing an endpoint that is already gone is not an error.
    await r.push.unsubscribe("https://push.example/a");
  } finally {
    await r.cleanup();
  }
});

test("a new service over the same file sees the persisted subscriptions", async () => {
  const r = await rig();
  try {
    await r.push.subscribe(sub("https://push.example/a"));
    await r.push.subscribe(sub("https://push.example/b"));

    const sent: { endpoint: string; payload: PushPayload }[] = [];
    const reborn = new PushService(r.file, vapid, r.threads, {
      send: async (record, payload) => void sent.push({ endpoint: record.endpoint, payload }),
    });
    reborn.watch(r.log);

    await runTurn(r.log);
    await waitFor(() => sent.length === 2, "two sends from the reloaded service");
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), ["https://push.example/a", "https://push.example/b"]);
  } finally {
    await r.cleanup();
  }
});

test("a missing subscriptions file is tolerated and means no sends", async () => {
  const r = await rig();
  try {
    r.push.watch(r.log);
    await runTurn(r.log);
    await settle();
    assert.deepEqual(r.sent, []);
    assert.equal(r.push.publicKey(), "pub-key");
  } finally {
    await r.cleanup();
  }
});
