import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LIMITS } from "../../shared/protocol";
import type { AskPayload, HelmSettings, SearchHit, SlashCommand, ThreadConfig, ThreadEvent, ThreadId, ThreadSummary } from "../../shared/protocol";
import { groupTurns } from "../../shared/turns";
import { guidanceOf } from "../../shared/vault";
import { parseAnswer, parseCreateThread, parsePatch, parseSave, parseSend, passkeyRows } from "./app";
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
    const f = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${c}&gen=0`), (fr) => fr.some((x) => x.kind === "sync"));
    assert.deepEqual(eventSeqs(f), Array.from({ length: head - c }, (_, i) => c + 1 + i), `cursor ${c}`);
    const sync = f.find((x): x is Extract<Frame, { kind: "sync" }> => x.kind === "sync")!;
    assert.equal(sync.frame.headSeq, head);
    assert.equal(sync.frame.session, "idle");
  }
  const viaHeader = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?gen=0`, undefined, { "last-event-id": String(head - 2) }), (fr) => fr.some((x) => x.kind === "sync"));
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
    const f = await readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=${c}&gen=0`), (fr) => fr.some((x) => x.kind === "sync"));
    assert.deepEqual(eventSeqs(f), Array.from({ length: head - c }, (_, i) => c + 1 + i), `cursor ${c}`);
  }

  // The next send resumes the same Claude session id from the log.
  const r2 = await r.restart(async (t) => {
    t.text("back");
    t.end();
  });
  const done = readSse(await r2.api("GET", `/api/threads/${THREAD}/events?after=${head}&gen=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
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
  await until(async () => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary, (t) => t.session === "running");
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
  const minted = parseCreateThread({ model: "m1", threadId: uuid(7) }, catalog, "/d");
  assert.equal(minted.ok && minted.value.threadId, uuid(7));
  for (const bad of ["not a uuid!", "abc", "x".repeat(41), 42, null]) {
    const r = parseCreateThread({ model: "m1", threadId: bad }, catalog, "/d");
    assert.equal(r.ok && r.value.threadId, undefined, `malformed thread id ${String(bad)} is replaced, not rejected`);
  }
  for (const bad of ["", "abc", "x".repeat(41), 42, undefined]) assert.equal(parseSend({ clientMsgId: bad, text: "x" }).ok, false, `message id ${String(bad)} is a 400`);
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
  const seed = { threadId: THREAD as never, cwd: "/v", model: "m" as never, effort: "high" as const, permissionMode: "bypass" as const, title: null, createdAt: "", archivedAt: null };
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
  const fullView = foldAll(emptyView(seed), events(frames));
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
    const before = foldAll(emptyView(seed), events(frames).slice(0, c));
    const tail = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${c}&gen=0`), (fr) => fr.some((x) => x.kind === "sync"));
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

  const second = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${done.headSeq}&gen=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
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

  assert.deepEqual(await read(), { theme: "system", defaultModel: null, defaultEffort: "medium", defaultCwd: join(s.home, "work"), defaultPermissionMode: "ask" });

  const patched = await s.api("PATCH", "/api/settings", { theme: "dark", defaultModel: "claude-sonnet-5", defaultEffort: "high", defaultCwd: join(s.home, "work", "proj"), defaultPermissionMode: "bypass" });
  assert.equal(patched.status, 200);
  const saved = (await patched.json()) as HelmSettings;
  assert.deepEqual(saved, { theme: "dark", defaultModel: "claude-sonnet-5", defaultEffort: "high", defaultCwd: join(s.home, "work", "proj"), defaultPermissionMode: "bypass" });
  assert.deepEqual(await read(), saved, "a re-read matches what the patch returned");

  const bad = async (body: unknown): Promise<string> => ((await (await s.api("PATCH", "/api/settings", body)).json()) as { error: string }).error;
  assert.equal(await bad({ colour: "dark" }), "unknown field: colour");
  assert.equal(await bad({ theme: "neon" }), "theme must be one of system, light, dark");
  assert.equal(await bad({ defaultModel: "claude-haiku-4-5-20251001" }), "defaultModel is not in the live catalog");
  assert.equal(await bad({ defaultEffort: "ultra" }), "defaultEffort must be one of low, medium, high, xhigh, max");
  assert.equal(await bad({ defaultCwd: "relative/path" }), "defaultCwd must be an absolute path");
  assert.equal(await bad({ defaultCwd: join(s.home, "work", "nope") }), "defaultCwd is not an existing directory");
  assert.equal(await bad({ defaultPermissionMode: "yolo" }), "defaultPermissionMode must be one of ask, bypass");
  assert.equal(await bad({}), "nothing to change");
  assert.equal((await s.api("PATCH", "/api/settings", { theme: "neon" })).status, 400);

  const cleared = await s.api("PATCH", "/api/settings", { defaultModel: null });
  assert.equal(((await cleared.json()) as HelmSettings).defaultModel, null, "null clears the preference");

  const r2 = await s.restart();
  assert.deepEqual(await (await r2.api("GET", "/api/settings")).json(), { theme: "dark", defaultModel: null, defaultEffort: "high", defaultCwd: join(s.home, "work", "proj"), defaultPermissionMode: "bypass" });
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

  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${log.getHead().lastSeq}&gen=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await until(async () => log.viewerCount(), (n) => n === 1);
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "second" });
  await live;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.pushed.length, 1, "no push while a viewer had the thread open");
  await s.cleanup();
});

const bashAsk: AskPayload = { kind: "tool", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "tu-1" as never, title: "Claude wants to run git push", description: null };

/** Every cursor replays to the same turns as the full stream: prefix seen live plus tail replayed from disk. */
async function assertReplayFolds(s: Stack, threadId: string, full: ThreadEvent[]): Promise<void> {
  const want = groupTurns(full);
  for (let c = 0; c <= full.length; c++) {
    const tail = await readSse(await s.api("GET", `/api/threads/${threadId}/events?after=${c}&gen=0`), (fr) => fr.some((x) => x.kind === "sync"));
    assert.deepEqual(eventSeqs(tail), full.slice(c).map((e) => e.seq), `cursor ${c}`);
    assert.deepEqual(groupTurns([...full.slice(0, c), ...events(tail)]), want, `cursor ${c} folds differently`);
  }
}

test("asks: a turn pauses on a permission, the first answer wins (204), the second is 409, a stranger is 404, and every cursor replays the same", async () => {
  const s = await buildStack(async (t) => {
    t.text("Pushing. ");
    const answer = await t.ask(bashAsk);
    t.text(`Got ${answer.kind}.`, 1);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5", permissionMode: "ask" });
  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "push it" });
  const waiting = await until(async () => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary, (t) => t.waiting);
  assert.deepEqual(waiting.doing, { kind: "tool", name: "Bash", arg: "git push origin main" });
  const askId = (await s.logs.get(THREAD as ThreadId)).getHead().pendingAsks[0]!.askId;

  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "answers", answers: [{ kind: "text", text: "x" }] } })).status, 400, "a tool ask takes no question answers");
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId: "nope", answer: { kind: "allow" } })).status, 404);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "allow" }, label: "laptop" })).status, 204);
  const dup = await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "deny", reason: "no" } });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: "already answered or expired" });

  const full = events(await live);
  const kinds = full.map((e) => e.kind);
  assert.deepEqual(kinds.slice(-5), ["assistant.text", "ask.opened", "ask.answered", "assistant.text", "turn.ended"]);
  const answered = full.find((e) => e.kind === "ask.answered");
  assert.ok(answered && answered.kind === "ask.answered");
  assert.deepEqual(answered.answer, { kind: "allow" });
  assert.deepEqual(answered.by, { by: "user", origin: { via: "key", label: "laptop" } });
  assert.ok(full.some((e) => e.kind === "assistant.text" && e.delta === "Got allow."), "the script received the answer");
  assert.equal(((await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary).waiting, false);
  await assertReplayFolds(s, THREAD, full);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "allow" } })).status, 409, "settled asks stay conflicts after the turn");
  await s.cleanup();
});

test("asks: a crash with an ask pending seals it as restart before the orphaned end, and nothing waits after reboot", async () => {
  const s = await buildStack(async (t) => {
    await t.ask(bashAsk);
    await t.interrupted;
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "go" });
  await until(async () => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary, (t) => t.waiting);
  const r = await s.restart();
  const after = events(await readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync")));
  const tail = after.slice(-2).map((e) => (e.kind === "ask.answered" ? `${e.kind}:${e.answer.kind}:${e.by.by === "system" ? e.by.reason : "?"}` : e.kind === "turn.ended" ? `${e.kind}:${e.outcome}` : e.kind));
  assert.deepEqual(tail, ["ask.answered:deny:restart", "turn.ended:orphaned"]);
  const summary = (await (await r.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary;
  assert.equal(summary.waiting, false);
  assert.equal(summary.session, "cold");
  assert.equal(groupTurns(after)[0]!.items.every((i) => i.kind !== "ask" || i.answer !== null), true, "no card is live after reboot");
  await r.cleanup();
});

test("asks: interrupt seals a pending ask as interrupted and the route then 409s", async () => {
  const s = await buildStack(async (t) => {
    await t.ask(bashAsk);
    await t.interrupted;
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "go" });
  await until(async () => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary, (t) => t.waiting);
  const askId = (await s.logs.get(THREAD as ThreadId)).getHead().pendingAsks[0]!.askId;
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/interrupt`)).status, 204);
  const full = events(await done);
  const sealed = full.find((e) => e.kind === "ask.answered");
  assert.ok(sealed && sealed.kind === "ask.answered");
  assert.deepEqual(sealed.by, { by: "system", reason: "interrupted" });
  const end = full.at(-1);
  assert.equal(end?.kind === "turn.ended" && end.outcome, "interrupted");
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "allow" } })).status, 409);
  await s.cleanup();
});

test("asks: a question round-trips option labels and free text; the same ask cannot take a plain allow", async () => {
  const q: AskPayload = { kind: "question", questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: true }, { question: "Name?", header: "Name", options: [{ label: "x", description: "" }, { label: "y", description: "" }], multiSelect: false }] };
  const s = await buildStack(async (t) => {
    const a = await t.ask(q);
    t.text(a.kind === "answers" ? a.answers.map((x) => (x.kind === "options" ? x.labels.join("+") : x.text)).join("|") : a.kind);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "ask me" });
  const waiting = await until(async () => (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary, (t) => t.waiting);
  assert.deepEqual(waiting.doing, { kind: "tool", name: "Question", arg: "Which?" });
  const askId = (await s.logs.get(THREAD as ThreadId)).getHead().pendingAsks[0]!.askId;
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "allow" } })).status, 400);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "answers", answers: [] } })).status, 400);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "answers", answers: [{ kind: "options", labels: ["A", "B"] }, { kind: "text", text: "zed" }] } })).status, 204);
  const full = events(await done);
  assert.ok(full.some((e) => e.kind === "assistant.text" && e.delta === "A+B|zed"));
  await s.cleanup();
});

test("thread creation: vault cwd starts in bypass, another cwd takes the server default, an explicit mode wins; PATCH records and applies the mode live", async () => {
  const s = await buildStack(async (t) => {
    t.text("ok");
    t.end();
  });
  const mode = async (body: Record<string, unknown>): Promise<string> => ((await (await s.api("POST", "/api/threads", { model: "claude-opus-5", ...body })).json()) as ThreadConfig).permissionMode;
  assert.equal(await mode({}), "bypass", "the vault root, whatever the default");
  assert.equal(await mode({ cwd: join(s.home, "work", "proj") }), "ask", "the server default outside the vault");
  assert.equal(await mode({ cwd: join(s.home, "work", "proj"), permissionMode: "bypass" }), "bypass");
  assert.equal(await mode({ permissionMode: "ask" }), "ask", "explicit wins in the vault too");
  assert.equal((await s.api("POST", "/api/threads", { model: "claude-opus-5", permissionMode: "yolo" })).status, 400);
  await s.api("PATCH", "/api/settings", { defaultPermissionMode: "bypass" });
  assert.equal(await mode({ cwd: join(s.home, "work", "proj") }), "bypass", "the server default moved");

  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5", permissionMode: "ask" });
  const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "hi" });
  await done;
  await untilIdle(s, THREAD);
  assert.equal(s.agents.last.spawnOpts.permissionMode, "ask");
  const patched = await s.api("PATCH", `/api/threads/${THREAD}`, { permissionMode: "bypass" });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as ThreadConfig).permissionMode, "bypass");
  assert.deepEqual(s.agents.last.setPermissionModeCalls, ["bypass"]);
  const evs = events(await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync")));
  assert.ok(evs.some((e) => e.kind === "thread.config" && e.patch.permissionMode === "bypass"));
  assert.equal((await s.api("PATCH", `/api/threads/${THREAD}`, { permissionMode: "maybe" })).status, 400);
  await s.cleanup();
});

test("parsers: answer", () => {
  assert.equal(parseAnswer(null).ok, false);
  assert.equal(parseAnswer({ askId: "", answer: { kind: "allow" } }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: "allow" }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "maybe" } }).ok, false);
  assert.deepEqual(parseAnswer({ askId: "a", answer: { kind: "allowTurn" }, label: " laptop " }), { ok: true, value: { askId: "a", answer: { kind: "allowTurn" }, label: "laptop" } });
  assert.deepEqual(parseAnswer({ askId: "a", answer: { kind: "deny" } }), { ok: true, value: { askId: "a", answer: { kind: "deny", reason: null }, label: undefined } });
  assert.deepEqual(parseAnswer({ askId: "a", answer: { kind: "deny", reason: "  " } }), { ok: true, value: { askId: "a", answer: { kind: "deny", reason: null }, label: undefined } });
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "deny", reason: 5 } }).ok, false);
  const long = parseAnswer({ askId: "a", answer: { kind: "deny", reason: "x".repeat(LIMITS.ANSWER_CHARS + 1) } });
  assert.equal(!long.ok && long.status, 413);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "answers", answers: [] } }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "answers", answers: [{ kind: "options", labels: [] }] } }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "answers", answers: [{ kind: "text", text: " " }] } }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "answers", answers: Array(5).fill({ kind: "text", text: "x" }) } }).ok, false);
  assert.equal(parseAnswer({ askId: "a", answer: { kind: "answers", answers: [{ kind: "options", labels: ["A"] }, { kind: "text", text: "t" }] } }).ok, true);
});

test("push fires for an ask left pending with no viewer attached, and not for a rule denial or while a viewer watches", async () => {
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const s = await buildStack(async (t) => {
    t.emit({ kind: "ask.opened", turnId: t.input.turnId, askId: "rule:tu-0" as never, ask: bashAsk });
    t.emit({ kind: "ask.answered", turnId: t.input.turnId, askId: "rule:tu-0" as never, answer: { kind: "deny", reason: "rule" }, by: { by: "system", reason: "rule" } });
    await gate;
    await t.ask(bashAsk);
    await t.interrupted;
  });
  await s.api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push/phone", keys: { p256dh: "p", auth: "a" } } });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const log = await s.logs.get(THREAD as ThreadId);
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "go" });
  await until(async () => log.getHead().recentAskIds.size, (n) => n === 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.pushed.length, 0, "an auto-denial is not a question for the phone");

  openGate();
  await until(async () => s.pushed.length, (n) => n === 1);
  assert.equal(s.pushed[0]!.kind, "ask");
  assert.equal(s.pushed[0]!.body, "Claude wants to run git push");
  assert.equal(s.pushed[0]!.threadId, THREAD);

  const askId = log.getHead().pendingAsks[0]!.askId;
  await s.api("POST", `/api/threads/${THREAD}/answer`, { askId, answer: { kind: "deny", reason: null } });
  await s.api("POST", `/api/threads/${THREAD}/interrupt`);
  await untilIdle(s, THREAD);
  await until(async () => s.pushed.length, (n) => n === 2);
  assert.equal(s.pushed[1]!.kind, "interrupted");

  const live = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${log.getHead().lastSeq}&gen=0`), (f) => events(f).some((e) => e.kind === "ask.opened" && !e.askId.startsWith("rule:")));
  await until(async () => log.viewerCount(), (n) => n === 1);
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "again" });
  await live;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.pushed.length, 2, "no push for the ask while a viewer had the thread open");
  await s.cleanup();
});

test("search: prompts and replies match, tool output does not, terms narrow, a phrase is one term, archived is opt-in", async () => {
  const s = await buildStack(async (t) => {
    const p = t.input.text;
    if (p.includes("grep")) {
      t.tool("Grep", { pattern: "needle" }, "needle in the output");
      t.text("Nothing to report.");
    } else if (p.includes("crash")) {
      t.text("A fatal error came from launchd.");
    } else if (p.includes("weather")) {
      t.text("It was a fatal mistake to ignore the error.");
    } else {
      t.text("Uploads are staged in a temp dir, then moved.");
    }
    t.end();
  });
  const ask = async (n: number, text: string): Promise<string> => {
    const threadId = uuid(n);
    await s.api("POST", "/api/threads", { threadId, model: "claude-opus-5" });
    const done = readSse(await s.api("GET", `/api/threads/${threadId}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
    await s.api("POST", `/api/threads/${threadId}/send`, { clientMsgId: uuid(100 + n), text });
    await done;
    await untilIdle(s, threadId);
    return threadId;
  };
  const find = async (st: Stack, q: string, extra = ""): Promise<SearchHit[]> =>
    (await (await st.api("GET", `/api/threads/search?q=${encodeURIComponent(q)}${extra}`)).json()) as SearchHit[];
  const ids = async (q: string, extra = ""): Promise<string[]> => (await find(s, q, extra)).map((h) => h.summary.config.threadId);

  const staging = await ask(1, "how are uploads staged, roughly");
  const grep = await ask(2, "check the logs with grep");
  const crash = await ask(3, "tell me about the crash");
  const weather = await ask(4, "the weather today");

  assert.deepEqual(await ids("roughly"), [staging], "a word only the prompt said");
  assert.deepEqual(await ids("temp"), [staging], "a word only the reply said");
  assert.deepEqual(await ids("needle"), [], "tool output is not searched");
  assert.deepEqual(await ids("upload"), [staging], "case folds and the prefix of Uploads matches");
  assert.deepEqual(await ids("load"), [], "a prefix only, never mid-word");
  assert.deepEqual(await ids("uploads temp"), [staging], "both terms in one thread");
  assert.deepEqual(await ids("uploads launchd"), [], "adding a term narrows to nothing");
  assert.deepEqual((await ids("fatal error")).sort(), [crash, weather].sort(), "two terms, anywhere");
  assert.deepEqual(await ids('"fatal error"'), [crash], "the quoted phrase only");

  assert.equal((await s.api("DELETE", `/api/threads/${weather}`)).status, 204);
  assert.deepEqual(await ids("fatal"), [crash], "an archived thread is out by default");
  const withArchived = await find(s, "fatal", "&archived=1");
  assert.deepEqual(withArchived.map((h) => h.summary.config.threadId).sort(), [crash, weather].sort());
  assert.ok(withArchived.find((h) => h.summary.config.threadId === weather)!.summary.config.archivedAt, "the row says it is archived");

  assert.equal((await s.api("GET", "/api/threads/search")).status, 400);
  assert.equal((await s.api("GET", "/api/threads/search?q=%20%20")).status, 400);
  assert.equal((await s.api("GET", "/api/threads/search?q=fatal&limit=two")).status, 400);
  assert.equal((await s.api("GET", "/api/threads/search?q=fatal&limit=")).status, 400);
  assert.equal((await s.api("GET", "/api/threads/search?q=fatal&limit=1e2")).status, 400);
  assert.equal((await find(s, "fatal", "&archived=1&limit=1")).length, 1, "limit clamps the rows");
  assert.equal((await find(s, "fatal", "&archived=1&limit=0")).length, 1, "and clamps up from nothing");
  assert.equal((await find(s, "fatal", "&archived=1&limit=999")).length, 2, "and down from too many");
  assert.equal((await (await s.api("GET", `/api/threads/${grep}`)).json() as ThreadSummary).config.threadId, grep, "the static segment does not shadow the id route");
  await s.cleanup();
});

test("search: one row per thread at its best turn, live turns included, and identical rows after a restart", async () => {
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const script = async (t: { input: { text: string }; text: (d: string) => void; end: () => void }): Promise<void> => {
    if (t.input.text.includes("hold")) {
      t.text("Pineapple is the answer.");
      await gate;
    }
    t.text("Noted.");
    t.end();
  };
  const s = await buildStack(script);
  const find = async (st: Stack, q: string): Promise<SearchHit[]> => (await (await st.api("GET", `/api/threads/search?q=${encodeURIComponent(q)}`)).json()) as SearchHit[];
  const turnStarts = async (st: Stack): Promise<number[]> =>
    events(await readSse(await st.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync"))).filter((e) => e.kind === "turn.started").map((e) => e.seq);

  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const say = async (n: number, text: string): Promise<void> => {
    const done = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).filter((e) => e.kind === "turn.ended").length >= n);
    await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(n), text });
    await done;
    await untilIdle(s, THREAD);
  };

  await say(1, "first question about uploads");
  const first = await find(s, "uploads");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.seq, (await turnStarts(s))[0], "the first turn's boundary");

  await say(2, "second question about uploads and staging");
  const starts = await turnStarts(s);
  assert.equal((await find(s, "uploads"))[0]!.seq, starts[1], "a tie on terms lands on the later turn");

  const best = await find(s, "uploads staging");
  assert.equal(best.length, 1, "a thread matching twice is still one row");
  assert.equal(best[0]!.seq, starts[1], "the turn covering both terms");
  for (const term of ["uploads", "staging"]) {
    const range = best[0]!.ranges.find(([start, end]) => best[0]!.snippet.slice(start, end).toLowerCase() === term);
    assert.ok(range, `${term} is highlighted in ${JSON.stringify(best[0]!.snippet)}`);
  }

  const r = await s.restart(script);
  const again = await find(r, "uploads staging");
  assert.deepEqual(
    again.map((h) => [h.summary.config.threadId, h.seq, h.snippet, h.ranges]),
    best.map((h) => [h.summary.config.threadId, h.seq, h.snippet, h.ranges]),
    "search survives a restart with no warm-up",
  );

  const held = readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "assistant.text" && e.delta.includes("Pineapple")));
  await r.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(3), text: "hold this one" });
  await held;
  const live = await until(() => find(r, "pineapple"), (rows) => rows.length === 1);
  assert.equal(live[0]!.seq, (await turnStarts(r)).at(-1), "the turn still running is searchable");

  await r.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(4), text: "and later, mangosteen" });
  const queued = await until(() => find(r, "mangosteen"), (rows) => rows.length === 1);
  const queuedSeq = events(await readSse(await r.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync"))).findLast((e) => e.kind === "input.queued")!.seq;
  assert.equal(queued[0]!.seq, queuedSeq, "a prompt still waiting for its turn lands on the queued event");
  openGate();
  await untilIdle(r, THREAD);
  await r.cleanup();
});

/** Run one turn on a thread and resolve once it is on disk and the session is idle. */
async function runTurn(s: Stack, threadId: string, n: number, text = `message ${n}`): Promise<void> {
  await s.api("POST", `/api/threads/${threadId}/send`, { clientMsgId: uuid(n), text });
  await untilIdle(s, threadId);
}

const replay = async (s: Stack, threadId: string): Promise<ThreadEvent[]> =>
  events(await readSse(await s.api("GET", `/api/threads/${threadId}/events?after=0`), (f) => f.some((x) => x.kind === "sync")));

const turnIds = (evs: ThreadEvent[]): string[] => evs.filter((e) => e.kind === "turn.started").map((e) => e.turnId);

test("fork: the copy ends at the chosen turn, the source gains a link to it, and the fork sorts to the top of the list", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  await runTurn(s, THREAD, 2, "second");
  const sourceEvents = await replay(s, THREAD);
  const [firstTurn, secondTurn] = turnIds(sourceEvents);

  const res = await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: firstTurn });
  assert.equal(res.status, 201);
  const fork = (await res.json()) as ThreadSummary;
  assert.equal(fork.config.title, "first (fork)", "the title says where it came from");
  assert.equal(fork.config.cwd, sourceEvents[0]!.kind === "thread.created" && sourceEvents[0]!.config.cwd);
  assert.notEqual(fork.config.threadId, THREAD);

  const copied = await replay(s, fork.config.threadId);
  assert.deepEqual(copied.map((e) => e.seq), Array.from({ length: copied.length }, (_, i) => i + 1), "the fork's log is contiguous from 1");
  assert.equal(copied[0]!.kind, "thread.created");
  assert.equal(copied.at(-1)!.kind, "thread.forked", "the divider is the last thing in the copy");
  const divider = copied.at(-1)!;
  assert.ok(divider.kind === "thread.forked");
  assert.equal(divider.from, THREAD);
  assert.equal(divider.atTurn, firstTurn, "atTurn names the turn in the source, which is what the link back resolves");
  assert.ok(!copied.some((e) => e.kind === "turn.started" && e.turnId === secondTurn), "nothing from the discarded turn is copied");
  assert.equal(turnIds(copied).length, 1);

  const folded = groupTurns(copied);
  assert.equal(folded.length, 2, "one copied turn plus the divider");
  assert.equal(folded[0]!.prompt?.text, "first");
  assert.deepEqual(folded[1]!.items.map((i) => i.kind), ["fork"]);

  const back = (await replay(s, THREAD)).at(-1)!;
  assert.ok(back.kind === "thread.forked.out");
  assert.deepEqual({ to: back.to, toTitle: back.toTitle, atTurn: back.atTurn }, { to: fork.config.threadId, toTitle: "first (fork)", atTurn: firstTurn });
  assert.equal(groupTurns(await replay(s, THREAD))[0]!.items.filter((i) => i.kind === "forkOut").length, 1, "the source marks the turn it was forked from");

  const list = (await (await s.api("GET", "/api/threads")).json()) as ThreadSummary[];
  assert.deepEqual(list.map((t) => t.config.threadId), [fork.config.threadId, THREAD], "a fork carries old copied turn ends and must still sort to the top");
  await s.cleanup();
});

test("fork: a running thread forks at its completed turns only, and 409s on the turn still in flight", async () => {
  let release = (): void => {};
  const s = await buildStack(async (t) => {
    if (t.input.text === "second") await new Promise<void>((r) => (release = r));
    t.text(`reply to ${t.input.text}`);
    t.end();
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  void s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(2), text: "second" });
  const open = await until(async () => await replay(s, THREAD), (evs) => evs.some((e) => e.kind === "turn.started" && turnIds(evs).length === 2));
  const [firstTurn, openTurn] = turnIds(open);

  assert.equal((await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: openTurn })).status, 409, "only completed turns fork");
  const res = await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: firstTurn });
  assert.equal(res.status, 201, "the completed turn forks without waiting for the running one");
  const fork = (await res.json()) as ThreadSummary;
  const copied = await replay(s, fork.config.threadId);
  assert.deepEqual(turnIds(copied).length, 1);
  assert.ok(!copied.some((e) => e.kind === "input.queued" && e.text === "second"), "the running turn's prompt is not copied either");

  release();
  await untilIdle(s, THREAD);
  await s.cleanup();
});

test("fork: an archived thread forks, and its archive is not inherited by the copy", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  const turnId = turnIds(await replay(s, THREAD))[0]!;
  assert.equal((await s.api("DELETE", `/api/threads/${THREAD}`)).status, 204);

  const res = await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId });
  assert.equal(res.status, 201, "old work resumes without unarchiving the original");
  const fork = (await res.json()) as ThreadSummary;
  assert.equal(fork.config.archivedAt, null);
  const copied = await replay(s, fork.config.threadId);
  assert.ok(!copied.some((e) => e.kind === "thread.archived"));
  assert.equal((await s.api("POST", `/api/threads/${fork.config.threadId}/send`, { clientMsgId: uuid(5), text: "go on" })).status, 200);
  await untilIdle(s, fork.config.threadId);
  await s.cleanup();
});

test("fork: the first send resumes the source session at the copied fork point, and the SDK's new session id lands in the fork's log", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  const sourceEvents = await replay(s, THREAD);
  const turnId = turnIds(sourceEvents)[0]!;
  const sourceEnd = sourceEvents.find((e) => e.kind === "turn.ended")!;
  assert.ok(sourceEnd.kind === "turn.ended");

  const fork = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  await runTurn(s, fork.config.threadId, 3, "try again");

  const opts = s.agents.last.spawnOpts;
  assert.equal(opts.resume, sourceEnd.sessionId, "the fork's first spawn resumes the session the source was on at the fork point");
  assert.equal(opts.forkAt, sourceEnd.forkPoint, "and truncates it there rather than continuing it");

  const copied = await replay(s, fork.config.threadId);
  const bound = copied.filter((e) => e.kind === "session.bound").at(-1)!;
  assert.ok(bound.kind === "session.bound");
  assert.notEqual(bound.sessionId, sourceEnd.sessionId, "the SDK mints a new session for the fork, so the source's session file is never written to");
  await s.cleanup();
});

test("fork: a turn that recorded no fork point forks with Claude starting fresh, and its first spawn resumes nothing", async () => {
  const s = await buildStack((t) => {
    t.text("no fork point here");
    t.emit({ kind: "turn.ended", turnId: t.input.turnId, outcome: "ok", sessionId: "fake-session-1" as never, usage: null, error: null });
  });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  const turnId = turnIds(await replay(s, THREAD))[0]!;

  const fork = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  const divider = (await replay(s, fork.config.threadId)).at(-1)!;
  assert.ok(divider.kind === "thread.forked");
  assert.equal(divider.resume, null, "a turn logged before forking existed degrades honestly rather than guessing a fork point");

  await runTurn(s, fork.config.threadId, 3, "try again");
  assert.deepEqual({ resume: s.agents.last.spawnOpts.resume, forkAt: s.agents.last.spawnOpts.forkAt }, { resume: null, forkAt: null });
  await s.cleanup();
});

test("fork: uploads named in the copied turns still resolve through the fork's id", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const body = Buffer.from("hello");
  const up = await s.fetch(
    new Request(`https://x/api/threads/${THREAD}/uploads`, { method: "POST", headers: { "x-helm-key": API_KEY, "content-type": "text/plain", "content-length": String(body.length), "x-upload-name": "notes.txt" }, body }),
  );
  const [staged] = (await up.json()) as { uploadId: string }[];
  const uploadId = staged!.uploadId;
  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "look", uploadIds: [uploadId] });
  await untilIdle(s, THREAD);
  const turnId = turnIds(await replay(s, THREAD))[0]!;

  const fork = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  const bytes = await s.api("GET", `/api/threads/${fork.config.threadId}/uploads/${uploadId}`);
  assert.equal(bytes.status, 200, "the copied upload.staged event is what the fork's index finds on its first miss");
  assert.equal(await bytes.text(), "hello");
  await s.cleanup();
});

test("fork: forking a fork works and the titles number themselves; two forks of one turn are two threads", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  const turnId = turnIds(await replay(s, THREAD))[0]!;

  const one = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  const two = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  assert.notEqual(one.config.threadId, two.config.threadId, "forking is not idempotent by design: two calls make two threads to compare");
  assert.equal(two.config.title, "first (fork)");

  await runTurn(s, one.config.threadId, 4, "retry");
  const inner = turnIds(await replay(s, one.config.threadId)).at(-1)!;
  const deep = (await (await s.api("POST", `/api/threads/${one.config.threadId}/fork`, { turnId: inner })).json()) as ThreadSummary;
  assert.equal(deep.config.title, "first (fork 2)", "branching is not one level deep");
  const copied = await replay(s, deep.config.threadId);
  const dividers = copied.filter((e) => e.kind === "thread.forked");
  assert.equal(dividers.length, 2, "the source's own divider is a fact of the copied transcript and is kept; the new one is appended after it");
  assert.deepEqual(dividers.map((e) => e.from), [THREAD, one.config.threadId]);
  assert.equal(turnIds(copied).length, 2, "both the copied turn and the retry come across");
  await s.cleanup();
});

test("fork: copied events never pass through append, so no notification fires for them", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/push/subscribe", { subscription: { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } } });
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  const turnId = turnIds(await replay(s, THREAD))[0]!;
  const before = s.pushed.length;

  const fork = (await (await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId })).json()) as ThreadSummary;
  await replay(s, fork.config.threadId);
  assert.equal(s.pushed.length, before, "copying a transcript is not a turn finishing, so nobody's phone buzzes");
  await s.cleanup();
});

test("fork: bad turn ids and unknown threads are refused at the boundary", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  await runTurn(s, THREAD, 1, "first");
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/fork`, {})).status, 400);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: 4 })).status, 400);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: "turn-4" })).status, 400);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/fork`, { turnId: "t:999" })).status, 404, "a well-formed id for a turn this log never had");
  assert.equal((await s.api("POST", `/api/threads/${uuid(9)}/fork`, { turnId: "t:4" })).status, 404);
  await s.cleanup();
});

test("compaction: park compacts a chatty thread behind a new generation; the transcript, totals, session, mirror and search are unchanged; the route answers 204 / 409 viewer / 409 running", async () => {
  let stack: Stack | null = null;
  let openGate = (): void => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const s = await buildStack(
    async (t) => {
      if (t.input.text.startsWith("long")) {
        // The writer coalesces same-key deltas over 40 ms; flushing after each one makes every delta its own line, the way a slow stream does.
        const log = await stack!.logs.get(THREAD as ThreadId);
        for (let i = 0; i < 130; i++) {
          t.text(i === 40 ? "needle " : `w${i} `);
          await new Promise((r) => setTimeout(r, 0));
          await log.flushDeltas();
        }
        t.tool("Read", { file_path: "/x" }, "contents");
        for (let i = 0; i < 90; i++) {
          t.thinking(`h${i} `);
          await new Promise((r) => setTimeout(r, 0));
          await log.flushDeltas();
        }
        t.text("done", 1);
        t.end();
        return;
      }
      if (t.input.text.startsWith("hold")) {
        t.text("holding");
        await gate;
      }
      t.text(`Echo: ${t.input.text}`);
      t.end();
    },
    undefined,
    { idleParkMs: 30 },
  );
  stack = s;
  const log = await s.logs.get(THREAD as ThreadId);
  const note = join(s.home, "work", "inbox", "chats", `${THREAD}.md`);
  const transcript = (evs: ThreadEvent[]): unknown => groupTurns(evs).map((t) => ({ prompt: t.prompt?.text ?? null, items: t.items.map((i) => (i.kind === "text" ? `text${i.blockIx}:${i.text}` : i.kind === "thinking" ? `think:${i.text}` : i.kind === "tool" ? `tool:${i.name}:${i.output}` : i.kind)), outcome: t.end?.outcome ?? null, usage: t.end?.usage ?? null }));
  const replay = async (after: number, gen: number): Promise<Frame[]> => readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${after}&gen=${gen}`), (f) => f.some((x) => x.kind === "sync"));
  const sync = (frames: Frame[]): Extract<Frame, { kind: "sync" }> => frames.find((f): f is Extract<Frame, { kind: "sync" }> => f.kind === "sync")!;
  const find = async (q: string): Promise<SearchHit[]> => (await (await s.api("GET", `/api/threads/search?q=${encodeURIComponent(q)}`)).json()) as SearchHit[];
  const send = (n: number, text: string) => s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(n), text });

  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const first = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "turn.ended"));
  await send(1, "long one");
  const before = events(await first);
  await untilIdle(s, THREAD);
  const headBefore = log.getHead();
  assert.equal(headBefore.generation, 0);
  assert.ok(headBefore.collapsible >= LIMITS.COMPACT_MIN_LINES, `collapsible ${headBefore.collapsible}`);
  assert.ok(before.length > LIMITS.COMPACT_MIN_LINES);
  const summaryBefore = (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary;
  const hitBefore = (await find("needle"))[0]!;
  await until(() => readFile(note, "utf8").catch(() => ""), (md) => md.includes("gen=0"));

  await until(async () => log.viewerCount(), (n) => n === 0);
  await until(async () => log.getHead().generation, (g) => g === 1);
  assert.equal(s.supervisor.status(THREAD as ThreadId).session, "parked");
  const headAfter = log.getHead();
  assert.equal(headAfter.collapsible, 0);
  assert.ok(headAfter.lastSeq < before.length / 10, `${headAfter.lastSeq} lines after compaction`);
  assert.equal(headAfter.sessionId, headBefore.sessionId);

  const stale = await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=${before.length}&gen=0`), () => false);
  assert.deepEqual(stale.map((f) => f.kind), ["sync"], "an old cursor gets one sync and the stream ends");
  assert.equal(sync(stale).frame.generation, 1);
  const fresh = await replay(0, 1);
  const after = events(fresh);
  assert.equal(after[0]?.kind, "log.generation");
  assert.deepEqual(eventSeqs(fresh), after.map((_, i) => i + 1));
  assert.deepEqual(transcript(after), transcript(before), "the transcript folds the same");
  assert.equal(sync(fresh).frame.generation, 1);
  assert.equal(sync(fresh).frame.headSeq, headAfter.lastSeq);
  const summaryAfter = (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary;
  assert.deepEqual({ ...summaryAfter, headSeq: 0, session: "" }, { ...summaryBefore, headSeq: 0, session: "" }, "the summary is unchanged but for the head and the parked state");
  const hitAfter = (await find("needle"))[0]!;
  assert.equal(hitAfter.snippet, hitBefore.snippet);
  assert.deepEqual(hitAfter.ranges, hitBefore.ranges);
  assert.equal(hitAfter.seq, after.find((e) => e.kind === "turn.started")?.seq, "the hit lands on the turn boundary in the new numbering");

  const held = await s.api("GET", `/api/threads/${THREAD}/events?after=0`);
  await until(async () => log.viewerCount(), (n) => n === 1);
  const second = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).filter((e) => e.kind === "turn.ended").length >= 2);
  await send(2, "long two");
  await second;
  await untilIdle(s, THREAD);
  await until(async () => s.supervisor.status(THREAD as ThreadId).session, (st) => st === "parked");
  await until(async () => log.viewerCount(), (n) => n === 1);
  assert.equal(log.getHead().generation, 1, "park leaves the log alone while a viewer is attached");
  assert.ok(log.getHead().collapsible >= LIMITS.COMPACT_MIN_LINES);
  const viewer = await s.api("POST", `/api/threads/${THREAD}/compact`);
  assert.deepEqual([viewer.status, await viewer.json()], [409, { error: "a viewer is attached" }]);
  await held.body!.cancel();
  await until(async () => log.viewerCount(), (n) => n === 0);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/compact`)).status, 204);
  assert.equal(log.getHead().generation, 2);
  assert.equal((await s.api("POST", `/api/threads/${THREAD}/compact`)).status, 204, "nothing to compact is still 204");
  assert.equal(log.getHead().generation, 2);

  const md = await until(() => readFile(note, "utf8"), (m) => (m.match(/^## /gm)?.length ?? 0) === 2);
  assert.equal(md.match(/^---$/gm)?.length, 2, "frontmatter once");
  assert.equal(md.match(/needle/g)?.length, 2, "each turn's text appears once");
  assert.deepEqual(md.match(/gen=\d+/g), ["gen=1", "gen=1"], "the note was rebuilt in the generation the second turn ended in");

  const running = readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => events(f).some((e) => e.kind === "assistant.text" && e.delta === "holding"));
  await send(3, "hold it");
  await running;
  const busy = await s.api("POST", `/api/threads/${THREAD}/compact`);
  assert.deepEqual([busy.status, await busy.json()], [409, { error: "a turn is running" }]);
  openGate();
  await untilIdle(s, THREAD);
  const final = await until(() => readFile(note, "utf8"), (m) => (m.match(/^## /gm)?.length ?? 0) === 3);
  assert.deepEqual(final.match(/gen=\d+/g), ["gen=2", "gen=2", "gen=2"], "the note followed the log into generation 2, once, with every turn");
  const last = transcript(events(await replay(0, 2))) as unknown[];
  assert.equal(last.length, 3, "three turns after two compactions");
  assert.deepEqual(last[0], (transcript(before) as unknown[])[0], "the first turn reads the same two generations later");
  await s.cleanup();
});

test("save to vault: the server's prompt runs as a vault-labelled turn, the note is logged, served and reported as recorded", async () => {
  let stack!: Stack;
  const s = await buildStack(async (t) => {
    const path = join(stack.home, "work", "Atlas", "Decisions", "backups.md");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "# Backups\n\n- 2026-09-13 nightly to the NAS\n");
    await stack.offers.record(THREAD as ThreadId, path, "added the 2026-09-13 bullet on backups", { via: "key", label: "model" });
    t.text("Recorded one decision note.");
    t.end();
  });
  stack = s;
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });

  const res = await s.api("POST", `/api/threads/${THREAD}/save`, {});
  assert.equal(res.status, 200);
  const body = (await res.json()) as { accepted: boolean; state: string };
  assert.deepEqual([body.accepted, body.state], [true, "running"]);

  const log = await s.logs.get(THREAD as ThreadId);
  const evs = await until(
    async () => {
      const out: ThreadEvent[] = [];
      for await (const e of log.read(0)) out.push(e);
      return out;
    },
    (list) => list.some((e) => e.kind === "note.recorded") && list.some((e) => e.kind === "turn.ended"),
  );

  const queued = evs.find((e) => e.kind === "input.queued");
  assert.ok(queued && queued.kind === "input.queued");
  assert.equal(queued.origin.label, "vault", "the origin label is what tells the phone to draw the compact row");
  assert.match(queued.text, new RegExp(join(s.home, "work")), "the prompt names the vault root");
  assert.match(queued.text, /record_note/, "and the tool that reports what it wrote");

  const rec = evs.find((e) => e.kind === "note.recorded");
  assert.ok(rec && rec.kind === "note.recorded");
  assert.equal(rec.note.rel, "Atlas/Decisions/backups.md", "the path the card and the wikilink show, relative to the vault");
  assert.equal(rec.note.summary, "added the 2026-09-13 bullet on backups");
  assert.equal(rec.note.file.mime, "text/markdown");

  const got = await s.api("GET", `/api/threads/${THREAD}/files/${rec.note.file.fileId}`);
  assert.equal(got.status, 200, "a recorded note is served by the same file route an offer is");
  assert.equal(got.headers.get("content-type"), "text/markdown");
  assert.match(await got.text(), /nightly to the NAS/);

  const summary = (await (await s.api("GET", `/api/threads/${THREAD}`)).json()) as ThreadSummary;
  assert.equal(summary.recorded, true, "the thread reads as promoted to the vault");

  await s.mirrorIdle();
  const mirrored = await readFile(join(s.home, "work", "inbox", "chats", `${THREAD}.md`), "utf8");
  assert.match(mirrored, /^recorded: true$/m, "the chat mirror is marked so prune keeps it");
  assert.match(mirrored, /^- \[\[Atlas\/Decisions\/backups\|backups\]\]: added the 2026-09-13 bullet on backups$/m, "and links to the note the save wrote");
  await s.cleanup();
});

test("a save while a turn is running queues behind it, and a second save leaves the first save's events intact", async () => {
  let release = (): void => {};
  const held = new Promise<void>((r) => (release = r));
  let stack!: Stack;
  let saves = 0;
  const s = await buildStack(async (t) => {
    if (t.input.text.includes("record_note")) {
      saves += 1;
      const path = join(stack.home, "work", `note-${saves}.md`);
      await writeFile(path, `# note ${saves}\n`);
      await stack.offers.record(THREAD as ThreadId, path, `wrote note ${saves}`, { via: "key", label: "model" });
      t.end();
      return;
    }
    await held;
    t.end();
  });
  stack = s;
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });

  await s.api("POST", `/api/threads/${THREAD}/send`, { clientMsgId: uuid(1), text: "work on it" });
  const queuedSave = (await (await s.api("POST", `/api/threads/${THREAD}/save`, {})).json()) as { state: string };
  assert.equal(queuedSave.state, "queued", "a save is never refused; it waits its turn");
  release();

  const log = await s.logs.get(THREAD as ThreadId);
  const read = async (): Promise<ThreadEvent[]> => {
    const out: ThreadEvent[] = [];
    for await (const e of log.read(0)) out.push(e);
    return out;
  };
  const first = await until(read, (l) => l.filter((e) => e.kind === "note.recorded").length === 1);
  const firstRec = first.find((e) => e.kind === "note.recorded");

  await s.api("POST", `/api/threads/${THREAD}/save`, { guidance: "focus on the backup decision" });
  const both = await until(read, (l) => l.filter((e) => e.kind === "note.recorded").length === 2);
  assert.deepEqual(
    both.filter((e) => e.kind === "note.recorded").map((e) => (e.kind === "note.recorded" ? e.note.rel : "")),
    ["note-1.md", "note-2.md"],
    "the second save appends; the first save's event is untouched",
  );
  assert.deepEqual(both.find((e) => e.seq === firstRec!.seq), firstRec);
  await s.cleanup();
});

test("recording a note refuses a path outside the vault, a non-markdown file, a missing file and an empty summary, each with a reason", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });
  const origin = { via: "key", label: "model" } as const;
  const t = THREAD as ThreadId;

  const outside = join(s.home, "elsewhere.md");
  await writeFile(outside, "# not in the vault\n");
  await assert.rejects(s.offers.record(t, outside, "nope", origin), /not inside the vault/);

  const notMd = join(s.home, "work", "notes.txt");
  await writeFile(notMd, "plain");
  await assert.rejects(s.offers.record(t, notMd, "nope", origin), /not a markdown file/);

  await assert.rejects(s.offers.record(t, join(s.home, "work", "gone.md"), "nope", origin), /no such file/);
  await assert.rejects(s.offers.record(t, "work/rel.md", "nope", origin), /absolute/);

  const real = join(s.home, "work", "real.md");
  await writeFile(real, "# real\n");
  await assert.rejects(s.offers.record(t, real, "   ", origin), /summary must say what changed/);

  const evs = events(await readSse(await s.api("GET", `/api/threads/${THREAD}/events?after=0`), (f) => f.some((x) => x.kind === "sync")));
  assert.ok(!evs.some((e) => e.kind === "note.recorded"), "a refused record leaves no event");
  await s.cleanup();
});

test("save guidance lands as the prompt's last line and is capped", async () => {
  const s = await buildStack();
  await s.api("POST", "/api/threads", { threadId: THREAD, model: "claude-opus-5" });

  await s.api("POST", `/api/threads/${THREAD}/save`, { guidance: "  focus on the backup decision  " });
  const log = await s.logs.get(THREAD as ThreadId);
  const queued = await until(
    async () => {
      const out: ThreadEvent[] = [];
      for await (const e of log.read(0)) out.push(e);
      return out.find((e) => e.kind === "input.queued");
    },
    (e) => e !== undefined,
  );
  assert.ok(queued && queued.kind === "input.queued");
  assert.equal(guidanceOf(queued.text), "focus on the backup decision", "trimmed, and readable back out by the phone");

  const tooLong = await s.api("POST", `/api/threads/${THREAD}/save`, { guidance: "x".repeat(LIMITS.ANSWER_CHARS + 1) });
  assert.equal(tooLong.status, 413);
  assert.deepEqual(parseSave({ guidance: "   " }), { ok: true, value: { guidance: null } }, "blank guidance is no guidance");
  assert.equal(parseSave({ guidance: 7 }).ok, false);
  await s.cleanup();
});
