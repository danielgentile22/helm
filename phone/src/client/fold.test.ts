import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, ThreadEvent, ThreadId, TurnId } from "../shared/protocol";
import { addPendingPrompt, applySync, emptyView, fold, foldAll, isWaiting } from "./fold";

const threadId = "t-1" as ThreadId;
const config = { threadId, cwd: "/v", model: "m" as never, effort: "high", permissionMode: "ask", title: null, createdAt: "", archivedAt: null } as const;
const origin = { via: "pwa", label: "iphone" } as const;
let seq = 0;
const ev = (body: object): ThreadEvent => ({ seq: ++seq as Seq, ts: "2026-09-11T10:00:00.000Z", ...body }) as ThreadEvent;

const shot = { uploadId: "u1", path: "/tmp/u1", name: "shot.png", mime: "image/png", bytes: 12 };
const note = { uploadId: "u2", path: "/tmp/u2", name: "notes.txt", mime: "text/plain", bytes: 3 };

function turn(): ThreadEvent[] {
  seq = 0;
  const t = "t:3" as TurnId;
  return [
    ev({ kind: "thread.created", config }),
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [shot, note], origin }),
    ev({ kind: "turn.started", turnId: t, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "session.bound", sessionId: "s" as never }),
    ev({ kind: "assistant.thinking", turnId: t, delta: "hm" }),
    ev({ kind: "assistant.thinking", turnId: t, delta: "m" }),
    ev({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "Hel" }),
    ev({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "lo" }),
    ev({ kind: "tool.started", turnId: t, toolUseId: "tu1" as never, name: "Read", input: { path: "/x" } }),
    ev({ kind: "tool.finished", turnId: t, toolUseId: "tu1" as never, output: "data", isError: false }),
    ev({ kind: "assistant.text", turnId: t, blockIx: 1, delta: "Done" }),
    ev({ kind: "turn.ended", turnId: t, outcome: "ok", sessionId: "s" as never, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.1, contextTokens: 4, durationMs: 5 }, error: null }),
  ];
}

test("fold builds prompt, thinking, text blocks, merged tool rows, and the turn end", () => {
  const view = foldAll(emptyView(config), turn());
  assert.equal(view.headSeq, 12);
  assert.equal(view.openTurn, null);
  assert.equal(view.contextTokens, 4);
  assert.equal(view.turns.length, 1);
  const t = view.turns[0]!;
  assert.equal(t.prompt && `prompt:${t.prompt.state}:${t.prompt.label}:${t.prompt.text}`, "prompt:started:iphone:hi");
  assert.deepEqual(
    t.items.map((l) => (l.kind === "text" ? `text${l.blockIx}:${l.text}` : l.kind === "thinking" ? `think:${l.text}` : l.kind === "tool" ? `tool:${l.name}:${l.output}:${l.isError}` : l.kind === "file" ? `file:${l.name}` : l.kind === "note" ? `note:${l.text}` : `ask:${l.askId}`)),
    ["think:hmm", "text0:Hello", "tool:Read:data:false", "text1:Done"],
  );
  assert.equal(t.end?.outcome, "ok");
});

test("a queued prompt keeps every upload's id, name and mime so images can be fetched back", () => {
  const view = foldAll(emptyView(config), turn().slice(0, 2));
  const prompt = view.turns[0]?.prompt;
  assert.ok(prompt);
  assert.deepEqual(prompt.uploads, [
    { uploadId: "u1", name: "shot.png", mime: "image/png" },
    { uploadId: "u2", name: "notes.txt", mime: "text/plain" },
  ]);
});

test("fold marks the turn open while running and refuses any seq but head plus one", () => {
  const events = turn();
  const mid = foldAll(emptyView(config), events.slice(0, 7));
  assert.equal(mid.openTurn, "t:3");
  assert.throws(() => fold(mid, events[9]!), /seq/);
  assert.throws(() => fold(mid, events[6]!), /seq/);
});

test("title, model, context window and usage totals are folded from the log, the same way the server's head derives them", () => {
  const events = turn();
  seq = events.length;
  const view = foldAll(emptyView(config), [
    ...events,
    ev({ kind: "thread.config", patch: { title: "Listing" }, origin }),
    ev({ kind: "thread.config", patch: { model: "claude-sonnet-5" as never }, origin }),
    ev({ kind: "turn.started", turnId: "t:4" as TurnId, clientMsgId: "c2" as never, model: "m" as never, effort: "high", spawned: false }),
    ev({ kind: "turn.ended", turnId: "t:4" as TurnId, outcome: "ok", sessionId: "s" as never, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 1, costUsd: null, contextTokens: 40, contextWindow: 200_000, durationMs: 5 }, error: null }),
  ]);
  assert.equal(view.config.title, "Listing");
  assert.equal(view.config.model, "claude-sonnet-5");
  assert.equal(view.config.cwd, "/v", "a patch keeps the fields it does not name");
  assert.equal(view.contextTokens, 40);
  assert.equal(view.contextWindow, 200_000);
  assert.deepEqual(view.usageTotal, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 1 });
  const ended = fold(view, ev({ kind: "turn.ended", turnId: "t:5" as TurnId, outcome: "ok", sessionId: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costUsd: null, contextTokens: 41, durationMs: 1 }, error: null }));
  assert.equal(ended.contextWindow, 200_000, "a turn without a window keeps the last one");
});

test("a pending prompt is replaced by its input.queued and dropped inputs are marked", () => {
  const events = turn();
  let view = fold(emptyView(config), events[0]!);
  view = addPendingPrompt(view, "c1", "hi", "iphone", [{ uploadId: shot.uploadId as never, name: shot.name, mime: shot.mime }]);
  assert.equal(view.turns.length, 1);
  assert.equal(view.turns[0]?.prompt?.state, "pending");
  assert.deepEqual(view.turns[0]?.prompt?.uploads.map((u) => u.name), ["shot.png"], "the pending prompt already carries what was staged");
  view = fold(view, events[1]!);
  assert.equal(view.turns.length, 1, "pending prompt replaced, not duplicated");
  assert.equal(view.turns[0]?.prompt?.state, "queued");
  view = fold(view, { seq: 3 as Seq, ts: "", kind: "input.dropped", clientMsgId: "c1" as never, reason: "restart" });
  assert.equal(view.turns[0]?.prompt?.state, "dropped");
});

test("config changes, archive, and orphaned ends render as notes and ends", () => {
  seq = 0;
  let view = emptyView(config);
  view = fold(view, ev({ kind: "thread.config", patch: { model: "claude-sonnet-5" as never }, origin }));
  view = fold(view, ev({ kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "c9" as never, model: "m" as never, effort: "low", spawned: false }));
  view = fold(view, ev({ kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "orphaned", sessionId: null, usage: null, error: null }));
  view = fold(view, ev({ kind: "thread.archived" }));
  assert.deepEqual(
    view.turns.map((t) => [t.turnId, t.items.map((i) => i.kind), t.end?.outcome ?? null]),
    [
      [null, ["note"], null],
      ["t:2", [], "orphaned"],
      [null, ["note"], null],
    ],
  );
  assert.equal(view.openTurn, null);
});

test("applySync marks live and copies the session state and the server's head", () => {
  const view = foldAll(emptyView(config), turn());
  const live = applySync(view, { headSeq: 12 as Seq, session: "idle", openTurn: null, queuedCount: 0 });
  assert.equal(live.replaying, false);
  assert.equal(live.session, "idle");
  assert.equal(live.logHead, 12);
});

test("a file offered to the phone becomes a file line carrying what the card needs, mid-turn or after it", () => {
  const t = "t:3" as TurnId;
  const file = { fileId: "f1", path: "/Users/d/Desktop/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 4096, note: "the report" };
  seq = 0;
  const evs = [
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "send it", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: t, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "file.offered", file, origin: { via: "key", label: "model" } }),
    ev({ kind: "assistant.text", turnId: t, blockIx: 0, delta: "Sent." }),
    ev({ kind: "turn.ended", turnId: t, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
    ev({ kind: "file.offered", file: { ...file, fileId: "f2", note: null }, origin: { via: "key", label: "model" } }),
  ];
  const view = foldAll(emptyView(config), evs);
  assert.deepEqual(
    view.turns.map((t) => t.items.map((i) => i.kind)),
    [["file", "text"], ["file"]],
    "the first file lands in the turn it was offered during, the second stands on its own",
  );
  const first = view.turns[0]?.items[0];
  assert.deepEqual(first, { kind: "file", fileId: "f1", name: "report.pdf", mime: "application/pdf", bytes: 4096, note: "the report", ts: "2026-09-11T10:00:00.000Z" });
  const second = view.turns[1]?.items[0];
  assert.ok(second?.kind === "file" && second.note === null);
});

test("the pending set is opened minus answered, an expired ask leaves it too, and a turn's end clears what it answers", () => {
  const t = "t:3" as TurnId;
  const toolAsk = { kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "tu1", title: null, description: null };
  seq = 0;
  const open = [
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "clean", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: t, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "ask.opened", turnId: t, askId: "a1" as never, ask: toolAsk }),
    ev({ kind: "ask.opened", turnId: t, askId: "a2" as never, ask: { kind: "question", questions: [{ question: "Which?", header: "pick", options: [], multiSelect: false }] } }),
  ];
  const waiting = foldAll(emptyView(config), open);
  assert.deepEqual(waiting.pendingAsks.map((a) => a.askId), ["a1", "a2"]);
  assert.equal(isWaiting(waiting), true);

  const answered = fold(waiting, ev({ kind: "ask.answered", turnId: t, askId: "a1" as never, answer: { kind: "allow" }, by: { by: "user", origin } }));
  assert.deepEqual(answered.pendingAsks.map((a) => a.askId), ["a2"]);
  assert.equal(answered.turns[0]?.items[0]?.kind === "ask" && answered.turns[0].items[0].answer?.by.by, "user");

  const expired = fold(answered, ev({ kind: "ask.answered", turnId: t, askId: "a2" as never, answer: { kind: "deny", reason: null }, by: { by: "system", reason: "interrupted" } }));
  assert.deepEqual(expired.pendingAsks, []);
  assert.equal(isWaiting(expired), false);
});

test("a turn that ends while an ask is open clears the pending set, and a closed turn is never waiting", () => {
  const t = "t:2" as TurnId;
  seq = 0;
  const view = foldAll(emptyView(config), [
    ev({ kind: "turn.started", turnId: t, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "ask.opened", turnId: t, askId: "a1" as never, ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu1", title: null, description: null } }),
  ]);
  assert.equal(isWaiting(view), true);
  const ended = fold(view, ev({ kind: "turn.ended", turnId: t, outcome: "interrupted", sessionId: null, usage: null, error: null }));
  assert.deepEqual(ended.pendingAsks, []);
  assert.equal(isWaiting(ended), false);
});
