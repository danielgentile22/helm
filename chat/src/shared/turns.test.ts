import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_GENERATION } from "./protocol";
import type { Seq, ThreadEvent, TurnId } from "./protocol";
import { foldTurn, groupTurns, isCompleted, pendingPrompt, type Turn } from "./turns";
import { applySync, emptyView, foldAll } from "../client/fold";
import { toBlocks } from "../client/transcript";
import { renderTurn } from "../server/core/mirror";

const origin = { via: "pwa", label: "iphone" } as const;
let seq = 0;
const ev = (body: object): ThreadEvent => ({ seq: ++seq as Seq, ts: `2026-09-11T10:00:${String(seq).padStart(2, "0")}.000Z`, ...body }) as ThreadEvent;
const T1 = "t:2" as TurnId;
const T2 = "t:9" as TurnId;

/** Two prompts, the second queued while the first turn runs and answered by its own turn. */
function twoTurns(): ThreadEvent[] {
  seq = 0;
  return [
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: T1, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "assistant.thinking", turnId: T1, delta: "hm" }),
    ev({ kind: "assistant.thinking", turnId: T1, delta: "m" }),
    ev({ kind: "assistant.text", turnId: T1, blockIx: 0, delta: "Hel" }),
    ev({ kind: "input.queued", clientMsgId: "c2" as never, text: "and then", uploads: [], origin }),
    ev({ kind: "assistant.text", turnId: T1, blockIx: 0, delta: "lo" }),
    ev({ kind: "tool.started", turnId: T1, toolUseId: "tu1" as never, name: "Read", input: { file_path: "/x" } }),
    ev({ kind: "turn.started", turnId: T2, clientMsgId: "c2" as never, model: "m" as never, effort: "high", spawned: false }),
  ];
}

test("groupTurns joins prompt to turn, deltas by block, and tool start to finish", () => {
  seq = 0;
  const events = [
    ev({ kind: "thread.created", config: { threadId: "x" as never, cwd: "/v", model: "m" as never, effort: "high", permissionMode: "ask", title: null, createdAt: "", archivedAt: null } }),
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [{ uploadId: "u1", path: "/tmp/u1", name: "shot.png", mime: "image/png", bytes: 12 }], origin }),
    ev({ kind: "turn.started", turnId: T1, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "assistant.text", turnId: T1, blockIx: 0, delta: "Hel" }),
    ev({ kind: "assistant.text", turnId: T1, blockIx: 0, delta: "lo" }),
    ev({ kind: "tool.started", turnId: T1, toolUseId: "tu1" as never, name: "Read", input: { file_path: "/x" } }),
    ev({ kind: "assistant.text", turnId: T1, blockIx: 0, delta: "Again" }),
    ev({ kind: "tool.finished", turnId: T1, toolUseId: "tu1" as never, output: "data", isError: true }),
    ev({ kind: "turn.ended", turnId: T1, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
  ];
  const turns = groupTurns(events);
  assert.equal(turns.length, 1);
  const t = turns[0]!;
  assert.equal(t.key, "p:c1");
  assert.equal(t.turnId, T1);
  assert.equal(t.startedAt, events[2]!.ts);
  assert.deepEqual(t.prompt, { clientMsgId: "c1", text: "hi", uploads: [{ uploadId: "u1", name: "shot.png", mime: "image/png" }], label: "iphone", state: "started", ts: events[1]!.ts });
  assert.deepEqual(
    t.items.map((i) => (i.kind === "text" ? `text${i.blockIx}:${i.text}` : i.kind === "tool" ? `tool:${i.name}:${i.output}:${i.isError}:${i.endedAt !== null}` : i.kind)),
    ["text0:Hello", "tool:Read:data:true:true", "text0:Again"],
    "a delta joins only the text item directly before it, so a block index reused after a tool opens a new item",
  );
  assert.equal(t.end?.outcome, "ok");
  assert.equal(t.end?.seq, 9);
});

test("a prompt queued mid-turn gets its own turn, and content routes by turn id even with a queued prompt after it", () => {
  const turns = groupTurns(twoTurns());
  assert.deepEqual(
    turns.map((t) => [t.key, t.turnId, t.prompt?.state, t.end?.outcome ?? null]),
    [
      ["p:c1", T1, "started", null],
      ["p:c2", T2, "started", null],
    ],
  );
  assert.deepEqual(turns[0]!.items.map((i) => i.kind), ["thinking", "text", "tool"]);
  assert.equal(turns[0]!.items[0]?.kind === "thinking" && turns[0]!.items[0].text, "hmm");
});

test("foldTurn keeps the identity of every turn it does not touch", () => {
  const events = twoTurns();
  let turns: readonly Turn[] = [];
  for (const e of events) turns = foldTurn(turns, e);
  const before = turns;
  const after = foldTurn(before, ev({ kind: "assistant.text", turnId: T2, blockIx: 0, delta: "yo" }));
  assert.equal(after[0], before[0], "the first turn is untouched");
  assert.notEqual(after[1], before[1]);
  assert.equal(foldTurn(after, ev({ kind: "session.bound", sessionId: "s" as never })), after, "an event outside the turn model returns the same list");
});

test("a pending prompt is replaced in place by its input.queued; a dropped input is marked", () => {
  seq = 0;
  let turns = pendingPrompt([], "c1", "hi", "iphone", [{ uploadId: "u1" as never, name: "shot.png", mime: "image/png" }]);
  assert.equal(turns[0]?.prompt?.state, "pending");
  assert.equal(turns[0]?.prompt?.uploads[0]?.name, "shot.png");
  turns = foldTurn(turns, ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [], origin }));
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.prompt?.state, "queued");
  turns = foldTurn(turns, ev({ kind: "input.dropped", clientMsgId: "c1" as never, reason: "restart" }));
  assert.equal(turns[0]?.prompt?.state, "dropped");
});

test("a tool.finished with no start still lands as a tool item; a turn.ended with no start opens a turn of its own", () => {
  seq = 0;
  const turns = groupTurns([
    ev({ kind: "tool.finished", turnId: T1, toolUseId: "tu9" as never, output: "late", isError: false }),
    ev({ kind: "turn.ended", turnId: T1, outcome: "orphaned", sessionId: null, usage: null, error: null }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.key, `t:${T1}`);
  assert.equal(turns[0]?.prompt, null);
  assert.equal(turns[0]?.items[0]?.kind === "tool" && turns[0].items[0].name, "?");
  assert.equal(turns[0]?.end?.outcome, "orphaned");
});

test("files and notes join the running turn, else the last unended turn, else stand as their own loose section", () => {
  seq = 0;
  const file = { fileId: "f1", path: "/x/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 10, note: null };
  const turns = groupTurns([
    ev({ kind: "thread.config", patch: { model: "claude-opus-5" as never }, origin }),
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "send it", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: T1, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "input.queued", clientMsgId: "c2" as never, text: "later", uploads: [], origin }),
    ev({ kind: "file.offered", file, origin: { via: "key", label: "model" } }),
    ev({ kind: "turn.ended", turnId: T1, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
    ev({ kind: "file.offered", file: { ...file, fileId: "f2" }, origin: { via: "key", label: "model" } }),
    ev({ kind: "thread.archived" }),
  ]);
  assert.deepEqual(
    turns.map((t) => [t.key, t.items.map((i) => i.kind)]),
    [
      ["n:1", ["note"]],
      ["p:c1", ["file"]],
      ["p:c2", ["file", "note"]],
    ],
  );
  assert.equal(turns[0]?.items[0]?.kind === "note" && turns[0].items[0].text, "[iphone] model set to claude-opus-5");
  assert.equal(turns[2]?.items[1]?.kind === "note" && turns[2].items[1].text, "thread archived");
});

test("the mirror and the phone agree on turn count, prompts, tool joins and text blocks for one event list", () => {
  const events = [
    ...twoTurns(),
    ev({ kind: "tool.finished", turnId: T1, toolUseId: "tu1" as never, output: "data", isError: true }),
    ev({ kind: "turn.ended", turnId: T1, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
    ev({ kind: "assistant.text", turnId: T2, blockIx: 0, delta: "Second" }),
    ev({ kind: "tool.started", turnId: T2, toolUseId: "tu2" as never, name: "Bash", input: { command: "ls" } }),
    ev({ kind: "tool.finished", turnId: T2, toolUseId: "tu2" as never, output: "a", isError: false }),
    ev({ kind: "assistant.text", turnId: T2, blockIx: 1, delta: " reply" }),
    ev({ kind: "turn.ended", turnId: T2, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
  ];
  const view = foldAll(emptyView({ threadId: "x" as never, cwd: "/v", model: "m" as never, effort: "high", permissionMode: "ask", title: null, createdAt: "", archivedAt: null }), events);
  const sections = toBlocks(applySync(view, { headSeq: view.headSeq, generation: FIRST_GENERATION, session: "idle", openTurn: null, queuedCount: 0 }));
  const notes = groupTurns(events).filter(isCompleted).map((t) => renderTurn(t, FIRST_GENERATION));

  assert.equal(sections.length, 2);
  assert.equal(notes.length, 2);
  const prompts = sections.map((s) => s.blocks.find((b) => b.kind === "prompt")).map((b) => b?.kind === "prompt" && b.prompt.text);
  assert.deepEqual(prompts, ["hi", "and then"]);
  assert.match(notes[0]!, /^> hi$/m);
  assert.match(notes[1]!, /^> and then$/m);

  const tools = sections.map((s) => s.blocks.flatMap((b) => (b.kind === "activity" ? b.tools.map((t) => `${t.name}:${t.isError}`) : [])));
  assert.deepEqual(tools, [["Read:true"], ["Bash:false"]]);
  assert.match(notes[0]!, /^> Read \/x \(failed\)$/m);
  assert.match(notes[1]!, /^> Bash ls$/m);
  assert.doesNotMatch(notes[1]!, /failed/);

  const texts = sections.map((s) => s.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])));
  assert.deepEqual(texts, [["Hello"], ["Second", " reply"]]);
  assert.match(notes[0]!, /^Hello$/m);
  assert.match(notes[1]!, /^Second$/m);
  assert.match(notes[1]!, /^reply$/m);
});

test("an ask lands in the turn it was opened in, its answer joins by askId, and an answer for an unknown ask changes nothing", () => {
  seq = 0;
  const ask = { kind: "tool", toolName: "Bash", input: { command: "git push" }, toolUseId: "tu1", title: "Claude wants to run git push", description: null };
  const turns = groupTurns([
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "push it", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: T1, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "ask.opened", turnId: T1, askId: "a1" as never, ask }),
    ev({ kind: "ask.answered", turnId: T1, askId: "a1" as never, answer: { kind: "deny", reason: "not yet" }, by: { by: "user", origin } }),
    ev({ kind: "ask.answered", turnId: T1, askId: "ghost" as never, answer: { kind: "allow" }, by: { by: "user", origin } }),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]!.items.map((i) => i.kind), ["ask"]);
  const item = turns[0]!.items[0]!;
  assert.ok(item.kind === "ask");
  assert.equal(item.askId, "a1");
  assert.equal(item.ask.kind === "tool" && item.ask.toolUseId, "tu1");
  assert.deepEqual(item.answer?.answer, { kind: "deny", reason: "not yet" });
  assert.deepEqual(item.answer?.by, { by: "user", origin });
});

test("a permission mode change reads as a note beside the model changes", () => {
  seq = 0;
  const turns = groupTurns([ev({ kind: "thread.config", patch: { permissionMode: "ask" }, origin })]);
  assert.equal(turns[0]?.items[0]?.kind === "note" && turns[0].items[0].text, "[iphone] permissions set to ask");
});

test("a recorded note joins the running turn the way an offered file does", () => {
  seq = 0;
  const note = {
    file: { fileId: "n1", path: "/v/Atlas/Decisions/backups.md", name: "backups.md", mime: "text/markdown", bytes: 40, note: null },
    rel: "Atlas/Decisions/backups.md",
    summary: "added the 2026-09-13 bullet",
  };
  const turns = groupTurns([
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "save it", uploads: [], origin }),
    ev({ kind: "turn.started", turnId: T1, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
    ev({ kind: "note.recorded", note, origin: { via: "key", label: "model" } }),
    ev({ kind: "turn.ended", turnId: T1, outcome: "ok", sessionId: "s" as never, usage: null, error: null }),
    ev({ kind: "note.recorded", note: { ...note, file: { ...note.file, fileId: "n2" } }, origin: { via: "key", label: "model" } }),
  ]);
  assert.deepEqual(
    turns.map((t) => [t.key, t.items.map((i) => i.kind)]),
    [
      ["p:c1", ["recorded"]],
      ["n:5", ["recorded"]],
    ],
  );
  const item = turns[0]?.items[0];
  assert.ok(item?.kind === "recorded");
  assert.deepEqual([item.fileId, item.rel, item.summary], ["n1", "Atlas/Decisions/backups.md", "added the 2026-09-13 bullet"]);
});
