import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "../../shared/protocol";
import type { HelmSettings, SlashCommand, ThreadConfig, ThreadId, ThreadSummary } from "../../shared/protocol";
import { parseCreateThread, parsePatch, parseSend, passkeyRows } from "./app";
import { API_KEY, buildStack, eventSeqs, events, readSse, type Frame, type Stack } from "./testkit";

const THREAD = "0f0f0f0f-0000-4000-8000-0000000000aa";
const uuid = (n: number) => `0f0f0f0f-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The supervisor settles to idle a tick after the log emits turn.ended; poll rather than guess the tick count. */
async function untilIdle(s: Stack, threadId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const t = (await (await s.api("GET", `/api/threads/${threadId}`)).json()) as ThreadSummary;
    if (t.session === "idle") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("thread never settled to idle");
}

/** Poll until the server-side projection catches up with what the fake already emitted. */
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition never held");
}

test("auth doors: 401 without credentials, 401 on a bad key, 503 when unconfigured, static and login options open", async () => {
  const s = await buildStack();
  const open = (path: string, init?: RequestInit) => s.fetch(new Request(`https://mac.test.ts.net${path}`, init));
  assert.equal((await open("/api/threads")).status, 401);
  assert.equal((await open("/api/threads", { headers: { "x-helm-key": "nope" } })).status, 401);
  assert.equal((await open("/")).status, 200);
  assert.equal((await open("/t/abc")).status, 200);
  assert.equal((await open("/settings")).status, 200, "the settings screen deep-links like a thread");
  assert.equal((await open("/auth/webauthn/login/options", { method: "POST" })).status, 200);
  assert.equal((await open("/auth/webauthn/register/options", { method: "POST" })).status, 401, "registration needs the key or an enroll token");
  assert.deepEqual(await (await s.api("GET", "/auth/me")).json(), { label: "curl", via: "key" });

  const enroll = await (await s.api("POST", "/auth/enroll")).json() as { url: string };
  const token = new URL(enroll.url).searchParams.get("token")!;
  const reg = await open(`/auth/webauthn/register/options?enroll=${token}`, { method: "POST", body: JSON.stringify({ label: "iphone" }), headers: { "content-type": "application/json" } });
  assert.equal(reg.status, 200);
  assert.equal((await open(`/auth/webauthn/register/options?enroll=${token}`, { method: "POST" })).status, 401, "enroll token is one-shot");
  await s.cleanup();

  const closed = await buildStack(undefined, undefined, { apiKey: undefined });
  assert.equal((await closed.fetch(new Request("https://x/api/threads", { headers: { "x-helm-key": "anything" } }))).status, 503);
  await closed.cleanup();
});

test("threads: models from the live catalog, create is idempotent on a client id, list and summary, patch, archive", async () => {
  const s = await buildStack();
  const models = await (await s.api("GET", "/api/models")).json() as { id: string }[];
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-5", "claude-sonnet-5"], "Haiku is not offered");

  const create = await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5", effort: "high" });
  assert.equal(create.status, 201);
  const cfg = await create.json() as ThreadConfig;
  assert.equal(cfg.threadId, THREAD);
  assert.equal(cfg.cwd, join(s.home, "work"), "default cwd");
  const again = await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-sonnet-5", effort: "low" });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), cfg, "retry returns the original unchanged");
  assert.equal((await s.api("POST", "/api/threads", { model: "claude-haiku-4-5-20251001" })).status, 400);
  assert.equal((await s.api("POST", "/api/threads", { model: "claude-opus-5", cwd: "/definitely/not/here" })).status, 400);

  const list = await (await s.api("GET", "/api/threads")).json() as ThreadSummary[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.headSeq, 1);
  assert.equal(list[0]!.session, "cold");
  assert.equal(list[0]!.preview, null);

  const patched = await s.api("PATCH", `/api/threads/${THREAD}`, { title: "Renamed", effort: "low" });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as ThreadConfig).title, "Renamed");
  assert.equal((await s.api("PATCH", `/api/threads/${THREAD}`, { effort: "max" })).status, 200);
  assert.equal((await s.api("PATCH", `/api/threads/${THREAD}`, { effort: "ultra" })).status, 400);
  assert.equal((await s.api("GET", `/api/threads/${uuid(9)}`)).status, 404);

  assert.equal((await s.api("DELETE", `/api/threads/${THREAD}`)).status, 204);
  assert.deepEqual(await (await s.api("GET", "/api/threads")).json(), []);
  const archived = (await (await s.api("GET", "/api/threads?archived=1")).json()) as ThreadSummary[];
  assert.equal(archived.length, 1, "the archived filter still lists it");
  assert.ok(archived[0]!.config.archivedAt);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "hi" })).status, 409);
  await s.cleanup();
});

test("send and stream: SSE attached before send sees sync then the whole turn; replay from every cursor is exact", async () => {
  const s = await buildStack(async (t) => {
    t.thinking("let me think");
    t.text("Hello ", 0);
    t.tool("Read", { path: "/x" }, "contents");
    t.text("world", 1);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  const sent = await (await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "Say hello\nplease" })).json();
  assert.deepEqual(sent, { accepted: true, state: "running", seq: 2 });
  const frames = await live;
  assert.equal(frames[0]?.kind, "event", "thread.created replayed");
  assert.equal(frames[1]?.kind, "sync");
  const kinds = events(frames).map((e) => e.kind);
  assert.deepEqual(kinds, ["thread.created", "input.queued", "thread.config", "turn.started", "session.bound", "assistant.thinking", "assistant.text", "tool.started", "tool.finished", "assistant.text", "turn.ended"]);
  const head = kinds.length;
  assert.deepEqual(eventSeqs(frames), Array.from({ length: head }, (_, i) => i + 1));
  const dup = await (await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "Say hello\nplease" })).json();
  assert.deepEqual(dup, { accepted: true, state: "duplicate", seq: 2 });

  for (let c = 0; c <= head; c++) {
    const f = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${c}`), (fr) => fr.some((x) => x.kind === "sync"));
    assert.deepEqual(eventSeqs(f), Array.from({ length: head - c }, (_, i) => c + 1 + i), `cursor ${c}`);
    const sync = f.find((x): x is Extract<Frame, { kind: "sync" }> => x.kind === "sync")!;
    assert.equal(sync.frame.headSeq, head);
    assert.equal(sync.frame.session, "idle");
  }
  const viaHeader = await readSse(await s.api("GET", `/api/threads/${THREAD}/events`, undefined, { "last-event-id": String(head - 2) }), (fr) => fr.some((x) => x.kind === "sync"));
  assert.deepEqual(eventSeqs(viaHeader), [head - 1, head]);
  assert.equal((await s.api("GET", `/api/threads/${THREAD}/events?after=x`)).status, 400);

  const summary = await (await s.api("GET", `/api/threads/${THREAD}`)).json() as ThreadSummary;
  assert.equal(summary.preview, "Hello world");
  assert.equal(summary.config.title, "Say hello");
  assert.equal(summary.contextTokens, 110);
  assert.equal(summary.lastOutcome, "ok");
  assert.equal(summary.session, "idle");
  await s.cleanup();
});

test("crash mid-turn and reboot: the turn is sealed as orphaned, unstarted inputs are dropped, every cursor replays clean", async () => {
  const s = await buildStack(async (t) => {
    t.text("working on it");
    await t.interrupted; // hangs forever: the "process" never finishes
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const seen = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "assistant.text"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "first" });
  await seen;
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "second, never started" });
  const mid = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync"));
  const midSync = mid.find((x): x is Extract<Frame, { kind: "sync" }> => x.kind === "sync")!;
  assert.equal(midSync.frame.session, "running");
  assert.ok(midSync.frame.openTurn);
  assert.equal(midSync.frame.queuedCount, 1);

  // Crash: abandon the old stack, boot a new one over the same home.
  const r = await s.restart();
  const after = await readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync"));
  const evs = events(after);
  const tail = evs.slice(-2).map((e) => (e.kind === "turn.ended" ? `${e.kind}:${e.outcome}` : e.kind === "input.dropped" ? `${e.kind}:${e.reason}` : e.kind));
  assert.deepEqual(tail, ["turn.ended:orphaned", "input.dropped:restart"]);
  assert.equal(((await (await r.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary).lastOutcome, "orphaned");
  const sync = after.find((x): x is Extract<Frame, { kind: "sync" }> => x.kind === "sync")!;
  assert.equal(sync.frame.session, "cold");
  assert.equal(sync.frame.openTurn, null);
  assert.equal(sync.frame.queuedCount, 0);
  const head = evs.length;
  for (let c = 0; c <= head; c++) {
    const f = await readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=${c}`), (fr) => fr.some((x) => x.kind === "sync"));
    assert.deepEqual(eventSeqs(f), Array.from({ length: head - c }, (_, i) => c + 1 + i), `cursor ${c}`);
  }

  // The next send resumes the same Claude session id from the log.
  const r2 = await r.restart(async (t) => {
    t.text("back");
    t.end();
  });
  const done = readSse(await r2.api("GET", `/api/threads/${THREAD}/events?after=${head}`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await r2.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(3), text: "third" });
  await done;
  assert.equal(r2.agents.last.spawnOpts.resume, "fake-session-1");
  await r2.cleanup();
});

test("interrupt is 204 whether or not a turn is running, and stops a hanging turn", async () => {
  const s = await buildStack(async (t) => {
    t.text("x");
    await t.interrupted;
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/interrupt`)).status, 204);
  const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "go" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/interrupt`)).status, 204);
  const end = events(await done).at(-1);
  assert.equal(end?.kind === "turn.ended" && end.outcome, "interrupted");
  await s.cleanup();
});

test("uploads: raw body streamed under the thread cwd in an ignored folder, sniffed mime, referenced by send; unknown id and oversize rejected", async () => {
  const s = await buildStack(async (t) => {
    t.text(`got ${t.input.uploads.map((u) => u.name).join(",")}`);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  const up = await s.fetch(
    new Request(`https://x/api/threads/${THREAD}/uploads`, { method: "POST", headers: { "x-helm-key": API_KEY, "content-type": "application/octet-stream", "content-length": String(png.length), "x-upload-name": "../evil photo.PNG" }, body: png }),
  );
  assert.equal(up.status, 201);
  const [staged] = await up.json() as { uploadId: string; path: string; name: string; mime: string; bytes: number }[];
  assert.equal(staged!.mime, "image/png");
  assert.equal(staged!.bytes, png.length);
  assert.equal(staged!.name, "evil_photo.PNG");
  const dir = join(s.home, "work", ".helm2-uploads");
  assert.ok(staged!.path.startsWith(dir));
  assert.equal((await readFile(staged!.path)).equals(png), true);
  assert.equal(await readFile(join(dir, ".gitignore"), "utf8"), "*\n");
  assert.ok(!(await readdir(dir)).some((f) => f.endsWith(".part")));

  const tooBig = await s.fetch(new Request(`https://x/api/threads/${THREAD}/uploads`, { method: "POST", headers: { "x-helm-key": API_KEY, "content-length": String(LIMITS.UPLOAD_BYTES + 1) }, body: "x" }));
  assert.equal(tooBig.status, 413);
  const chunked = await s.fetch(new Request(`https://x/api/threads/${THREAD}/uploads`, { method: "POST", headers: { "x-helm-key": API_KEY }, body: "x" }));
  assert.equal(chunked.status, 413, "missing Content-Length is rejected");

  assert.equal((await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "see", uploadIds: ["nope"] })).status, 400);
  const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "see", uploadIds: [staged!.uploadId] })).status, 200);
  const evs = events(await done);
  assert.ok(evs.some((e) => e.kind === "upload.staged"));
  const text = evs.filter((e) => e.kind === "assistant.text").map((e) => e.kind === "assistant.text" && e.delta).join("");
  assert.equal(text, "got evil_photo.PNG");
  await s.cleanup();
});

test("dirs: roots when no path, children with CLAUDE.md and git flags, outside roots rejected", async () => {
  const s = await buildStack();
  const roots = await (await s.api("GET", "/api/dirs")).json() as { path: string }[];
  assert.deepEqual(roots.map((r) => r.path), [join(s.home, "work")]);
  const children = await (await s.api("GET", `/api/dirs?path=${encodeURIComponent(join(s.home, "work"))}`)).json() as { name: string; hasClaudeMd: boolean; isGitRepo: boolean }[];
  assert.deepEqual(children, [{ name: "proj", path: join(s.home, "work", "proj"), hasClaudeMd: true, isGitRepo: false }]);
  assert.equal((await s.api("GET", `/api/dirs?path=${encodeURIComponent(s.home)}`)).status, 400);
  await s.cleanup();
});

test("push routes: key, subscribe, unsubscribe", async () => {
  const s = await buildStack();
  assert.deepEqual(await (await s.api("GET", "/api/push/key")).json(), { key: "vapid-public" });
  assert.equal((await s.api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push/1", keys: { p256dh: "p", auth: "a" } } })).status, 204);
  assert.equal((await s.subscriptions())[0]?.label, "curl");
  assert.equal((await s.api("POST", "/api/push/subscribe", { subscription: { endpoint: 1 } })).status, 400);
  assert.equal((await s.api("DELETE", "/api/push/subscribe", { endpoint: "https://push/1" })).status, 204);
  assert.equal((await s.subscriptions()).length, 0);
  await s.cleanup();
});

test("global stream fans in boundary events across threads", async () => {
  const s = await buildStack();
  const g = readSse(await s.api("GET", "/api/events"), (f) => f.filter((x) => x.kind === "event").length >= 3);
  await new Promise((r) => setTimeout(r, 10));
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await s.api("POST", "/api/threads", { threadId: uuid(2), model: "claude-opus-5" });
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "hi" });
  const frames = await g;
  const tagged = frames.filter((f): f is Extract<Frame, { kind: "event" }> => f.kind === "event").map((f) => `${(f.ev as unknown as { threadId: string }).threadId.slice(-2)}:${f.ev.kind}`);
  assert.deepEqual(tagged.slice(0, 3), ["aa:thread.created", "02:thread.created", "aa:input.queued"]);
  await s.cleanup();
});

test("parsers: send, create, patch", () => {
  const catalog = [{ id: "m1", label: "M", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh", "max"] }] as never;
  assert.equal(parseSend(null).ok, false);
  assert.equal(parseSend({ clientMsgId: "bad id!", text: "x" }).ok, false);
  assert.equal(parseSend({ clientMsgId: uuid(1), text: "" }).ok, false);
  assert.equal(parseSend({ clientMsgId: uuid(1), text: "", uploadIds: ["u"] }).ok, true);
  const big = parseSend({ clientMsgId: uuid(1), text: "x".repeat(LIMITS.MESSAGE_CHARS + 1) });
  assert.equal(!big.ok && big.status, 413);
  assert.deepEqual(parseSend({ clientMsgId: uuid(1), text: "hi", label: " laptop " }), { ok: true, value: { clientMsgId: uuid(1), text: "hi", uploadIds: undefined, label: "laptop" } });

  assert.deepEqual(parseCreateThread({ model: "m1" }, catalog, "/d"), { ok: true, value: { threadId: undefined, cwd: "/d", model: "m1", effort: "medium", title: null } });
  assert.equal(parseCreateThread({ model: "m1", effort: "max" }, catalog, "/d").ok, true);
  assert.equal(parseCreateThread({ model: "m1", effort: "ultra" }, catalog, "/d").ok, false);
  assert.equal(parseCreateThread({ model: "m1", cwd: "relative" }, catalog, "/d").ok, false);
  assert.equal(parseCreateThread({ model: "zzz" }, catalog, "/d").ok, false);

  assert.equal(parsePatch({}, catalog).ok, false);
  assert.equal(parsePatch({ title: "  " }, catalog).ok, false);
  assert.deepEqual(parsePatch({ title: " T ", model: "m1" }, catalog), { ok: true, value: { model: "m1", title: "T" } });
});

test("the phone's view: folding the SSE frames a client receives reconstructs the transcript, from any cursor, across a crash", async () => {
  const { emptyView, foldAll, applySync } = await import("../../client/fold");
  const s = await buildStack(async (t) => {
    t.thinking("plan");
    t.text("Sure. ", 0);
    t.tool("Bash", { command: "ls" }, "a\nb");
    t.text("Listed.", 1);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "List files" });
  const frames = await live;
  const fullView = foldAll(emptyView(THREAD as never), events(frames));
  assert.equal(fullView.turns.length, 1);
  const turn = fullView.turns[0]!;
  const shape = turn.items.map((l) => (l.kind === "tool" ? `tool:${l.name}:${l.isError === false ? "ok" : "?"}` : l.kind === "text" ? `text:${l.text}` : l.kind));
  assert.equal(turn.prompt?.state, "started");
  assert.deepEqual(shape, ["note", "thinking", "text:Sure. ", "tool:Bash:ok", "text:Listed."]);
  assert.equal(turn.end?.outcome, "ok");
  assert.equal(fullView.openTurn, null);
  assert.equal(fullView.contextTokens, 110);

  // A phone that had seen up to cursor c and reconnects folds the tail onto its own view and lands on the same lines.
  const head = fullView.headSeq;
  for (let c = 1; c <= head; c++) {
    const before = foldAll(emptyView(THREAD as never), events(frames).slice(0, c));
    const tail = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${c}`), (fr) => fr.some((x) => x.kind === "sync"));
    const sync = tail.find((x): x is Extract<Frame, { kind: "sync" }> => x.kind === "sync")!;
    const after = applySync(foldAll(before, events(tail)), sync.frame);
    assert.deepEqual(after.turns, fullView.turns, `cursor ${c}`);
    assert.equal(after.replaying, false);
    assert.equal(after.session, "idle");
  }
  await s.cleanup();
});

test("commands: a cold thread is answered by a cwd probe, a live session answers for itself, reload picks up a new skill", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const names = async (method: string, path: string): Promise<string[]> => {
    const res = await s.api(method, path);
    assert.equal(res.status, 200);
    return ((await res.json()) as { commands: SlashCommand[] }).commands.map((c) => c.name);
  };

  assert.deepEqual(await names("GET", `/api/threads/${THREAD}/commands`), ["commit", "grill-with-docs"]);
  assert.deepEqual(s.agents.probes, [join(s.home, "work")], "a cold thread probes its own cwd");
  await names("GET", `/api/threads/${THREAD}/commands`);
  assert.equal(s.agents.probes.length, 1, "the probe result is cached per cwd");

  const turnDone = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "hi" });
  await turnDone;
  await untilIdle(s, THREAD);
  s.agents.last.pushCommands([{ name: "pushed", description: "arrived mid-session", argumentHint: "" }]);
  assert.deepEqual(await names("GET", `/api/threads/${THREAD}/commands`), ["pushed"], "the live session answers, not the probe");

  s.agents.commandList = [...s.agents.commandList, { name: "new-skill", description: "Just written", argumentHint: "" }];
  assert.deepEqual(await names("POST", `/api/threads/${THREAD}/commands/reload`), ["commit", "grill-with-docs", "new-skill"]);
  assert.deepEqual(await names("GET", `/api/threads/${THREAD}/commands`), ["commit", "grill-with-docs", "new-skill"], "reload replaced the live snapshot");

  assert.equal((await s.api("GET", `/api/threads/${uuid(9)}/commands`)).status, 404);
  assert.equal((await s.fetch(new Request(`https://mac.test.ts.net/api/threads/${THREAD}/commands`))).status, 401);
  await s.cleanup();
});

test("thread head: doing reports the open tool while running, the text tail once idle, and usage totals over two turns", async () => {
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => (openGate = r));
  let holdNext = true;
  const s = await buildStack(async (t) => {
    if (!holdNext) {
      t.text("Second turn done");
      t.end();
      return;
    }
    holdNext = false;
    t.text("Let me look. ");
    const id = t.toolStart("Bash", { command: "  npm   test " });
    await gate;
    t.toolEnd(id, "ok");
    t.text("All green.");
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const get = async (): Promise<ThreadSummary> => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary;

  const first = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "run the tests" });
  const mid = await until(get, (t) => t.doing?.kind === "tool");
  assert.equal(mid.session, "running");
  assert.deepEqual(mid.doing, { kind: "tool", name: "Bash", arg: "npm test" }, "the open tool wins over the text already emitted");
  openGate();

  await first;
  await untilIdle(s, THREAD);
  const done = await get();
  assert.deepEqual(done.doing, { kind: "text", tail: "Let me look. All green." }, "turn.ended clears the tool and the tail stands");
  assert.equal(done.preview, "Let me look. All green.");
  assert.equal(done.contextWindow, 200_000);
  assert.deepEqual(done.usageTotal, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 });

  const second = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${done.headSeq}`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "again" });
  await second;
  await untilIdle(s, THREAD);
  const after = await get();
  assert.deepEqual(after.usageTotal, { inputTokens: 20, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 0 }, "summed over both turns");
  assert.deepEqual(after.doing, { kind: "text", tail: "Second turn done" }, "a new turn resets the tail");
  await s.cleanup();
});

test("upload bytes: round-trip after staging, again after a restart, 404 for an unknown id, 401 without auth", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const posted = await s.fetch(
    new Request(`https://mac.test.ts.net/api/threads/${THREAD}/uploads`, {
      method: "POST",
      headers: { "x-helm-key": API_KEY, "content-type": "application/octet-stream", "content-length": String(png.length), "x-upload-name": "shot.png" },
      body: png,
    }),
  );
  assert.equal(posted.status, 201);
  const [staged] = (await posted.json()) as { uploadId: string; name: string; mime: string; bytes: number }[];
  assert.equal(staged!.mime, "image/png", "sniffed from the magic bytes");

  const got = await s.api("GET", `/api/threads/${THREAD}/uploads/${staged!.uploadId}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("content-length"), String(png.length));
  assert.equal(got.headers.get("content-disposition"), 'inline; filename="shot.png"');
  assert.equal(got.headers.get("cache-control"), "private, max-age=3600");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png);

  assert.equal((await s.api("GET", `/api/threads/${THREAD}/uploads/${uuid(7)}`)).status, 404);
  assert.equal((await s.fetch(new Request(`https://mac.test.ts.net/api/threads/${THREAD}/uploads/${staged!.uploadId}`))).status, 401);

  const r2 = await s.restart();
  const afterRestart = await r2.api("GET", `/api/threads/${THREAD}/uploads/${staged!.uploadId}`);
  assert.equal(afterRestart.status, 200, "resolved from the log, not from memory");
  assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), png);
  await r2.cleanup();
});

test("settings: defaults on first read, patches round-trip across a restart, bad fields are rejected", async () => {
  const s = await buildStack();
  const read = async (): Promise<HelmSettings> => (await (await s.api("GET", "/api/settings")).json()) as HelmSettings;

  assert.deepEqual(await read(), { theme: "system", defaultModel: null, defaultEffort: "medium", defaultCwd: join(s.home, "work") });

  const patched = await s.api("PATCH", "/api/settings", { theme: "dark", defaultModel: "claude-sonnet-5", defaultEffort: "high", defaultCwd: join(s.home, "work", "proj") });
  assert.equal(patched.status, 200);
  const saved = (await patched.json()) as HelmSettings;
  assert.deepEqual(saved, { theme: "dark", defaultModel: "claude-sonnet-5", defaultEffort: "high", defaultCwd: join(s.home, "work", "proj") });
  assert.deepEqual(await read(), saved, "a re-read matches what the patch returned");

  const bad = async (body: unknown): Promise<string> => ((await (await s.api("PATCH", "/api/settings", body)).json()) as { error: string }).error;
  assert.equal(await bad({ colour: "dark" }), "unknown field: colour");
  assert.equal(await bad({ theme: "neon" }), "theme must be one of system, light, dark");
  assert.equal(await bad({ defaultModel: "claude-haiku-4-5-20251001" }), "defaultModel is not in the live catalog");
  assert.equal(await bad({ defaultEffort: "ultra" }), "defaultEffort must be one of low, medium, high, xhigh, max");
  assert.equal(await bad({ defaultCwd: "relative/path" }), "defaultCwd must be an absolute path");
  assert.equal(await bad({ defaultCwd: join(s.home, "work", "nope") }), "defaultCwd is not an existing directory");
  assert.equal(await bad({}), "nothing to change");
  assert.equal((await s.api("PATCH", "/api/settings", { theme: "neon" })).status, 400);

  const cleared = await s.api("PATCH", "/api/settings", { defaultModel: null });
  assert.equal(((await cleared.json()) as HelmSettings).defaultModel, null, "null clears the preference");

  const r2 = await s.restart();
  assert.deepEqual(await (await r2.api("GET", "/api/settings")).json(), { theme: "dark", defaultModel: null, defaultEffort: "high", defaultCwd: join(s.home, "work", "proj") });
  assert.equal((await r2.fetch(new Request("https://mac.test.ts.net/api/settings"))).status, 401);
  await r2.cleanup();
});

test("about: version and host, behind the api door", async () => {
  const s = await buildStack();
  const res = await s.api("GET", "/api/about");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: "0.0.0-test", host: "mac.test.ts.net" });
  assert.equal((await s.fetch(new Request("https://mac.test.ts.net/api/about"))).status, 401);
  await s.cleanup();
});

test("passkeys: empty before enrollment, and the mapping never leaks the credential id", async () => {
  const s = await buildStack();
  const res = await s.api("GET", "/api/passkeys");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  assert.equal((await s.fetch(new Request("https://mac.test.ts.net/api/passkeys"))).status, 401);
  await s.cleanup();

  // A real registration ceremony needs an authenticator, so the shape is pinned on the pure mapping instead.
  const rows = passkeyRows([
    { credentialId: "Y3JlZC1pZA", label: "iphone", createdAt: "2026-09-01T10:00:00.000Z" },
    { credentialId: "b3RoZXI", label: "laptop", createdAt: "2026-09-02T10:00:00.000Z" },
  ]);
  assert.deepEqual(rows, [
    { label: "iphone", createdAt: "2026-09-01T10:00:00.000Z" },
    { label: "laptop", createdAt: "2026-09-02T10:00:00.000Z" },
  ]);
  assert.deepEqual(rows.flatMap((r) => Object.keys(r)), ["label", "createdAt", "label", "createdAt"], "no third key rides along");
});

test("files offered to the phone: logged as file.offered, served live by id, 404 when gone or unknown, 401 without auth, resolved after a restart", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(64, 7)]);
  const path = join(s.home, "work", "report.pdf");
  await writeFile(path, pdf);

  const sse = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "file.offered"));
  const offered = await s.offers.offer(THREAD as ThreadId, path, "the report you asked for", { via: "key", label: "model" });
  assert.equal(offered.name, "report.pdf");
  assert.equal(offered.mime, "application/pdf", "sniffed from the magic bytes");
  assert.equal(offered.bytes, pdf.length);
  assert.equal(offered.note, "the report you asked for");
  const ev = events(await sse).find((e) => e.kind === "file.offered");
  assert.ok(ev && ev.kind === "file.offered");
  assert.deepEqual(ev.file, offered);
  assert.equal(ev.origin.label, "model");

  const got = await s.api("GET", `/api/threads/${THREAD}/files/${offered.fileId}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/pdf");
  assert.equal(got.headers.get("content-length"), String(pdf.length));
  assert.equal(got.headers.get("content-disposition"), 'inline; filename="report.pdf"');
  assert.equal(got.headers.get("cache-control"), "private, no-store", "the bytes under an id can change, unlike an upload");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), pdf);

  assert.equal((await s.api("GET", `/api/threads/${THREAD}/files/${uuid(7)}`)).status, 404);
  assert.equal((await s.fetch(new Request(`https://mac.test.ts.net/api/threads/${THREAD}/files/${offered.fileId}`))).status, 401);

  const r2 = await s.restart();
  const afterRestart = await r2.api("GET", `/api/threads/${THREAD}/files/${offered.fileId}`);
  assert.equal(afterRestart.status, 200, "resolved from the log, not from memory");
  assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), pdf);

  await rm(path);
  assert.equal((await r2.api("GET", `/api/threads/${THREAD}/files/${offered.fileId}`)).status, 404, "served from the live path, so a deleted file is gone");
  await r2.cleanup();
});

test("offering a file refuses a relative path, a directory, a missing file, and one over the cap, each with a reason the model can relay", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const origin = { via: "key", label: "model" } as const;
  const t = THREAD as ThreadId;
  await assert.rejects(s.offers.offer(t, "work/report.pdf", null, origin), /absolute/);
  await assert.rejects(s.offers.offer(t, join(s.home, "work"), null, origin), /directory/);
  await assert.rejects(s.offers.offer(t, join(s.home, "work", "nope.txt"), null, origin), /no such file/);
  const big = join(s.home, "work", "big.bin");
  await truncate(big, LIMITS.OFFER_BYTES + 1).catch(async () => {
    await writeFile(big, "");
    await truncate(big, LIMITS.OFFER_BYTES + 1);
  });
  await assert.rejects(s.offers.offer(t, big, null, origin), /larger than/);
  const evs = events(await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync")));
  assert.ok(!evs.some((e) => e.kind === "file.offered"), "a refused offer leaves no event");

  const txt = join(s.home, "work", "notes.txt");
  await writeFile(txt, "hello");
  const offered = await s.offers.offer(t, txt, null, origin);
  assert.equal(offered.mime, "text/plain", "no magic bytes, so the extension decides");
  assert.equal(offered.note, null);
  await s.cleanup();
});

test("push fires on a finished turn only when no SSE viewer is attached", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push/phone", keys: { p256dh: "p", auth: "a" } } });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const log = await s.logs.get(THREAD as ThreadId);

  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "first" });
  await until(async () => s.pushed.length, (n) => n === 1);
  assert.equal(s.pushed[0]!.threadId, THREAD);

  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${log.getHead().lastSeq}`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await until(async () => log.viewerCount(), (n) => n === 1);
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "second" });
  await live;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.pushed.length, 1, "no push while a viewer had the thread open");
  await s.cleanup();
});
