import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq, ThreadEvent, ThreadId, TurnId } from "../shared/protocol";
import { addPendingPrompt, applySync, emptyView, fold, foldAll } from "./fold";

const threadId = "t-1" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
let seq = 0;
const ev = (body: object): ThreadEvent => ({ seq: ++seq as Seq, ts: "2026-09-11T10:00:00.000Z", ...body }) as ThreadEvent;

const shot = { uploadId: "u1", path: "/tmp/u1", name: "shot.png", mime: "image/png", bytes: 12 };
const note = { uploadId: "u2", path: "/tmp/u2", name: "notes.txt", mime: "text/plain", bytes: 3 };

function turn(): ThreadEvent[] {
  seq = 0;
  const t = "t:3" as TurnId;
  return [
    ev({ kind: "thread.created", config: { threadId, cwd: "/v", model: "m" as never, effort: "high", title: null, createdAt: "", archivedAt: null } }),
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
  const view = foldAll(emptyView(threadId), turn());
  assert.equal(view.headSeq, 12);
  assert.equal(view.openTurn, null);
  assert.equal(view.contextTokens, 4);
  assert.equal(view.turns.length, 1);
  const t = view.turns[0]!;
  assert.equal(t.prompt && `prompt:${t.prompt.state}:${t.prompt.label}:${t.prompt.text}`, "prompt:started:iphone:hi");
  assert.deepEqual(
    t.items.map((l) => (l.kind === "text" ? `text${l.blockIx}:${l.text}` : l.kind === "thinking" ? `think:${l.text}` : l.kind === "tool" ? `tool:${l.name}:${l.output}:${l.isError}` : l.kind === "file" ? `file:${l.name}` : `note:${l.text}`)),
    ["think:hmm", "text0:Hello", "tool:Read:data:false", "text1:Done"],
  );
  assert.equal(t.end?.outcome, "ok");
});

test("a queued prompt keeps every upload's id, name and mime so images can be fetched back", () => {
  const view = foldAll(emptyView(threadId), turn().slice(0, 2));
  const prompt = view.turns[0]?.prompt;
  assert.ok(prompt);
  assert.deepEqual(prompt.uploads, [
    { uploadId: "u1", name: "shot.png", mime: "image/png" },
    { uploadId: "u2", name: "notes.txt", mime: "text/plain" },
  ]);
});

test("fold marks the turn open while running and requires seq to be exactly head plus one", () => {
  const events = turn();
  const mid = foldAll(emptyView(threadId), events.slice(0, 7));
  assert.equal(mid.openTurn, "t:3");
  assert.throws(() => fold(mid, events[9]!), /seq/);
  assert.throws(() => fold(mid, events[6]!), /seq/);
});

test("a pending prompt is replaced by its input.queued and dropped inputs are marked", () => {
  const events = turn();
  let view = fold(emptyView(threadId), events[0]!);
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
  let view = emptyView(threadId);
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

test("applySync marks live and copies session state; a stale head resets to empty so the client reattaches from zero", () => {
  const view = foldAll(emptyView(threadId), turn());
  const live = applySync(view, { headSeq: 12 as Seq, session: "idle", openTurn: null, queuedCount: 0 });
  assert.equal(live.replaying, false);
  assert.equal(live.session, "idle");
  const reset = applySync(view, { headSeq: 5 as Seq, session: "cold", openTurn: null, queuedCount: 0 });
  assert.equal(reset.headSeq, 0);
  assert.equal(reset.turns.length, 0);
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
  const view = foldAll(emptyView(threadId), evs);
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
