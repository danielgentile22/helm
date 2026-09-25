import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_GENERATION } from "../shared/protocol";
import type { Seq, ThreadEvent, ThreadId, TurnId } from "../shared/protocol";
import { applySync, emptyView, foldAll, type ThreadView } from "./fold";
import { answerLine, diffLines, jumpCount, summarize, toBlocks as toSections, toolDiff, type Block, type Section } from "./transcript";

const threadId = "t-1" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
const T = "t:3" as TurnId;

let seq = 0;
let clock = 0;
const at = (s: number): string => new Date(Date.UTC(2026, 8, 11, 10, 0, s)).toISOString();
const ev = (body: object): ThreadEvent => ({ seq: ++seq as Seq, ts: at(clock++), ...body }) as ThreadEvent;

const started = (turnId: TurnId = T): ThreadEvent[] => {
  seq = 0;
  clock = 0;
  return [
    ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [], origin }),
    ev({ kind: "turn.started", turnId, clientMsgId: "c1" as never, model: "m" as never, effort: "high", spawned: true }),
  ];
};

const tool = (name: string, input: unknown = {}): ThreadEvent[] => {
  const id = `tu${seq + 1}`;
  return [ev({ kind: "tool.started", turnId: T, toolUseId: id as never, name, input }), ev({ kind: "tool.finished", turnId: T, toolUseId: id as never, output: "ok", isError: false })];
};

const ended = (outcome = "ok", durationMs = 42_000, error: string | null = null): ThreadEvent =>
  ev({
    kind: "turn.ended",
    turnId: T,
    outcome,
    sessionId: "s" as never,
    usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, costUsd: 0.1, contextTokens: 4, contextWindow: 200_000, durationMs },
    error,
  });

/** Fold the events, then mark the stream live with the turn left open or closed. */
function build(events: ThreadEvent[], openTurn: TurnId | null): ThreadView {
  const view = foldAll(emptyView({ threadId: threadId, cwd: "/v", model: "m" as never, effort: "high", permissionMode: "ask", title: null, createdAt: "", archivedAt: null }), events);
  return applySync(view, { headSeq: view.headSeq, generation: FIRST_GENERATION, session: openTurn ? "running" : "idle", openTurn, queuedCount: 0 });
}

const toBlocks = (view: ThreadView): readonly Block[] => toSections(view).flatMap((s) => s.blocks);
const kinds = (blocks: readonly Block[]): string[] => blocks.map((b) => b.kind);
const activity = (blocks: readonly Block[]): Extract<Block, { kind: "activity" }>[] => blocks.filter((b): b is Extract<Block, { kind: "activity" }> => b.kind === "activity");

test("consecutive tool lines of one turn coalesce into one activity block", () => {
  const blocks = toBlocks(build([...started(), ...tool("Read"), ...tool("Bash"), ...tool("Edit"), ended()], null));
  assert.deepEqual(kinds(blocks), ["prompt", "activity"]);
  const [act] = activity(blocks);
  assert.equal(act!.tools.length, 3);
  assert.deepEqual(act!.counts, { read: 1, run: 1, edit: 1, other: 0 });
  assert.equal(summarize(act!.counts), "read 1 file, ran 1 command, edited 1 file");
});

test("a text block between two tools splits the activity in two", () => {
  const events = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash"), ended()];
  const blocks = toBlocks(build(events, null));
  assert.deepEqual(kinds(blocks), ["prompt", "activity", "text", "activity"]);
  const acts = activity(blocks);
  assert.notEqual(acts[0]!.key, acts[1]!.key);
});

test("only the turn's last activity block is running; an earlier one closed off by text stops its clock", () => {
  const events = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash")];
  const acts = activity(toBlocks(build(events, T)));
  assert.equal(acts[0]!.running, false);
  assert.equal(acts[0]!.durationMs, 1000);
  assert.equal(acts[1]!.running, true);
  assert.equal(acts[1]!.durationMs, null);
});

test("current is the last unfinished tool while the turn is open and null once it ends", () => {
  const open = [...started(), ...tool("Read"), ev({ kind: "tool.started", turnId: T, toolUseId: "tu9" as never, name: "Bash", input: { command: "npm test" } })];
  const live = activity(toBlocks(build(open, T)))[0]!;
  assert.equal(live.running, true);
  assert.equal(live.current?.name, "Bash");
  assert.equal(live.durationMs, null);

  const done = activity(toBlocks(build(open, null)))[0]!;
  assert.equal(done.running, false);
  assert.equal(done.current, null);
});

test("a lone activity block reports the turn's own duration; several time themselves from their stamps", () => {
  const one = activity(toBlocks(build([...started(), ...tool("Read"), ended("ok", 42_000)], null)))[0]!;
  assert.equal(one.durationMs, 42_000);

  const split = [...started(), ...tool("Read"), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "midway" }), ...tool("Bash"), ended("ok", 42_000)];
  const acts = activity(toBlocks(build(split, null)));
  assert.equal(acts.length, 2);
  assert.equal(acts[0]!.durationMs, 1000, "one second between its own start and end stamps");
  assert.equal(acts[1]!.durationMs, 1000);
});

test("thinking collapses once the turn speaks or ends, and streams only as the last open line", () => {
  const thinkOnly = [...started(), ev({ kind: "assistant.thinking", turnId: T, delta: "hm" })];
  const live = toBlocks(build(thinkOnly, T)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([live.collapsed, live.streaming], [false, true]);

  const spoke = [...thinkOnly, ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "Hello" })];
  const afterText = toBlocks(build(spoke, T)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([afterText.collapsed, afterText.streaming], [true, false]);

  const closed = toBlocks(build(thinkOnly, null)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([closed.collapsed, closed.streaming], [true, false]);
});

test("a queued prompt or a loose note never streams while no turn is open", () => {
  seq = 0;
  clock = 0;
  const events = [ev({ kind: "input.queued", clientMsgId: "c1" as never, text: "hi", uploads: [], origin }), ev({ kind: "thread.config", patch: { title: "T" }, origin })];
  const blocks = toBlocks(build(events, null));
  assert.deepEqual(kinds(blocks), ["prompt", "note"]);
  const think = [...started(), ev({ kind: "assistant.thinking", turnId: T, delta: "hm" }), ended()];
  const closed = toBlocks(build(think, null)).find((b) => b.kind === "thinking")!;
  assert.deepEqual([closed.collapsed, closed.streaming], [true, false]);
});

test("text streams only as the last line of an open turn", () => {
  const events = [...started(), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "one" }), ev({ kind: "assistant.text", turnId: T, blockIx: 1, delta: "two" })];
  const live = toBlocks(build(events, T)).filter((b) => b.kind === "text");
  assert.deepEqual(live.map((b) => b.streaming), [false, true]);
  assert.deepEqual(toBlocks(build(events, null)).filter((b) => b.kind === "text").map((b) => b.streaming), [false, false]);
});

test("an ok end leaves no block; interrupted, error and orphaned each leave one", () => {
  assert.deepEqual(kinds(toBlocks(build([...started(), ended("ok")], null))), ["prompt"]);
  for (const outcome of ["interrupted", "error", "orphaned"] as const) {
    const blocks = toBlocks(build([...started(), ended(outcome, 1, "the SDK closed the stream")], null));
    assert.deepEqual(kinds(blocks), ["prompt", "end"]);
    const end = blocks[1]!;
    assert.equal(end.kind === "end" && end.outcome, outcome);
  }
});

test("summarize omits empty categories, keeps singulars, and names an empty block", () => {
  assert.equal(summarize({ read: 6, run: 2, edit: 3, other: 1 }), "read 6 files, ran 2 commands, edited 3 files, 1 other");
  assert.equal(summarize({ read: 1, run: 0, edit: 0, other: 0 }), "read 1 file");
  assert.equal(summarize({ read: 0, run: 0, edit: 0, other: 0 }), "working");
});

test("diffLines keeps common lines and marks removals before the additions that replace them", () => {
  const d = diffLines("a\nb\nc", "a\nx\ny\nc");
  assert.deepEqual(d.map((l) => `${l.op}${l.text}`), [" a", "-b", "+x", "+y", " c"]);
  assert.deepEqual(diffLines("same", "same").map((l) => l.op), [" "]);
});

test("toolDiff reads an Edit as a diff, a Write as all additions, and anything else as nothing", () => {
  const line = (name: string, input: unknown): Parameters<typeof toolDiff>[0] => ({ kind: "tool", toolUseId: "x" as never, name, input, output: null, isError: null, startedAt: at(0), endedAt: null });
  const edit = toolDiff(line("Edit", { file_path: "/v/a.ts", old_string: "one\ntwo", new_string: "one\nthree" }));
  assert.equal(edit?.file, "/v/a.ts");
  assert.deepEqual(edit?.lines.map((l) => `${l.op}${l.text}`), [" one", "-two", "+three"]);

  const write = toolDiff(line("Write", { file_path: "/v/b.ts", content: "x\ny" }));
  assert.deepEqual(write?.lines.map((l) => `${l.op}${l.text}`), ["+x", "+y"]);

  assert.equal(toolDiff(line("MultiEdit", { file_path: "/v/c.ts", edits: [] })), null);
  assert.equal(toolDiff(line("Bash", { command: "ls" })), null);
});

test("jumpCount counts blocks past what the reader has seen and never goes negative", () => {
  const sections: readonly Section[] = toSections(build([...started(), ...tool("Read"), ended()], null));
  assert.equal(sections.length, 1);
  assert.equal(jumpCount(sections, 0), 2);
  assert.equal(jumpCount(sections, 1), 1);
  assert.equal(jumpCount(sections, 5), 0);
});

test("config changes and the archive marker survive as note blocks", () => {
  seq = 0;
  clock = 0;
  const view = build([ev({ kind: "thread.config", patch: { model: "claude-opus-5" as never }, origin }), ev({ kind: "thread.archived" })], null);
  assert.deepEqual(kinds(toBlocks(view)), ["note", "note"]);
});

test("a file line is its own block and does not split or join the activity around it", () => {
  const file = { fileId: "f1", path: "/x/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 10, note: null };
  const evs = [...started(), ...tool("Bash"), ev({ kind: "file.offered", file, origin: { via: "key", label: "model" } }), ...tool("Read"), ended()];
  const blocks = toBlocks(build(evs, null));
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["prompt", "activity", "file", "activity"],
  );
  const f = blocks[2];
  assert.ok(f?.kind === "file" && f.file.fileId === "f1" && f.file.name === "report.pdf");
});

const askEv = (askId: string, toolUseId: string): ThreadEvent =>
  ev({ kind: "ask.opened", turnId: T, askId, ask: { kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId, title: null, description: null } });

const answeredEv = (askId: string, answer: object, by: object): ThreadEvent => ev({ kind: "ask.answered", turnId: T, askId, answer, by });

test("an ask is its own block, breaks a run of tools, and is live only while the turn waits on it", () => {
  const events = [...started(), ...tool("Read"), askEv("a1", "tu9"), ...tool("Bash")];
  const blocks = toBlocks(build(events, T));
  assert.deepEqual(kinds(blocks), ["prompt", "activity", "ask", "activity"]);
  const card = blocks[2]!;
  assert.ok(card.kind === "ask");
  assert.equal(card.live, true);
  assert.equal(card.ask.askId, "a1");

  const closed = toBlocks(build(events, null)).find((b) => b.kind === "ask")!;
  assert.equal(closed.live, false, "a turn that is no longer open draws no buttons");

  const settled = toBlocks(build([...events, answeredEv("a1", { kind: "allow" }, { by: "user", origin })], T)).find((b) => b.kind === "ask")!;
  assert.equal(settled.live, false);
});

test("a tool the turn denied is marked denied for its activity block, and an allowed one is not", () => {
  const events = [
    ...started(),
    ev({ kind: "ask.opened", turnId: T, askId: "a1", ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu-denied", title: null, description: null } }),
    answeredEv("a1", { kind: "deny", reason: "not that one" }, { by: "user", origin }),
    ev({ kind: "ask.opened", turnId: T, askId: "a2", ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu-allowed", title: null, description: null } }),
    answeredEv("a2", { kind: "allow" }, { by: "user", origin }),
    ev({ kind: "ask.opened", turnId: T, askId: "a3", ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu-expired", title: null, description: null } }),
    answeredEv("a3", { kind: "deny", reason: null }, { by: "system", reason: "interrupted" }),
    ...tool("Bash"),
  ];
  const act = activity(toBlocks(build(events, null)))[0]!;
  assert.deepEqual([...act.denied].sort(), ["tu-denied", "tu-expired"]);
});

test("a decision Claude Code made alone marks the tool row denied and draws no card", () => {
  const events = [
    ...started(),
    ev({ kind: "ask.opened", turnId: T, askId: "r1", ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu-rule", title: null, description: null } }),
    answeredEv("r1", { kind: "deny", reason: "deny rule" }, { by: "system", reason: "rule" }),
    ...tool("Bash"),
  ];
  const blocks = toBlocks(build(events, T));
  assert.deepEqual(kinds(blocks), ["prompt", "activity"]);
  assert.deepEqual([...activity(blocks)[0]!.denied], ["tu-rule"]);
});

test("answerLine names who answered and what, and tells an expiry apart from a denial", () => {
  const item = (answer: object, by: object): Parameters<typeof answerLine>[0] => ({
    kind: "ask",
    askId: "a1" as never,
    ask: { kind: "tool", toolName: "Bash", input: {}, toolUseId: "tu1" as never, title: null, description: null },
    openedAt: at(0),
    answer: { answer: answer as never, by: by as never, ts: at(0) },
  });
  const user = { by: "user", origin: { via: "pwa", label: "laptop" } };
  const stamp = answerLine(item({ kind: "allow" }, user)).split(" · ")[1]!;
  assert.equal(answerLine(item({ kind: "allow" }, user)), `Allowed by laptop · ${stamp}`);
  assert.equal(answerLine(item({ kind: "allowTurn" }, user)), `Allowed for this turn by laptop · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: "wrong branch" }, user)), `Denied by laptop: wrong branch · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: null }, user)), `Denied by laptop · ${stamp}`);
  assert.equal(answerLine(item({ kind: "answers", answers: [{ kind: "options", labels: ["Rebase"] }, { kind: "text", text: "both" }] }, user)), `Answered: Rebase · both · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: null }, { by: "system", reason: "interrupted" })), `Expired (interrupted) · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: null }, { by: "system", reason: "restart" })), `Expired (server restarted) · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: null }, { by: "system", reason: "archived" })), `Expired (archived) · ${stamp}`);
  assert.equal(answerLine(item({ kind: "deny", reason: "a deny rule matched" }, { by: "system", reason: "rule" })), `Auto-denied by a rule: a deny rule matched · ${stamp}`);
});

test("a fork's divider stands in its own unfinished section below the copied turn, pointing at the source turn's seq", () => {
  const copied = (): ThreadEvent[] => [...started(), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "Hi" }), ended()];
  const fresh = toSections(build([...copied(), ev({ kind: "thread.forked", from: "t-src" as ThreadId, fromTitle: "Listing", atTurn: "t:17" as TurnId, resume: null })], null));
  assert.deepEqual(
    fresh.map((s) => [s.ended, s.blocks.map((b) => b.kind)]),
    [
      [true, ["prompt", "text"]],
      [false, ["fork"]],
    ],
  );
  const divider = fresh[1]!.blocks[0]!;
  assert.ok(divider.kind === "fork");
  assert.deepEqual([divider.from, divider.fromTitle, divider.memory, divider.atSeq], ["t-src", "Listing", "fresh", 17]);
  assert.equal(divider.key, `fork:${fresh[1]!.key}`);

  const resumed = toSections(build([...copied(), ev({ kind: "thread.forked", from: "t-src" as ThreadId, fromTitle: null, atTurn: "t:17" as TurnId, resume: { sessionId: "s" as never, at: "uuid-9" } })], null));
  const kept = resumed[1]!.blocks[0]!;
  assert.ok(kept.kind === "fork");
  assert.deepEqual([kept.memory, kept.fromTitle], ["session", null], "a resumable source leaves the copied turns in Claude's memory");
});

test("the link to a fork lands inside the turn it was forked from", () => {
  const events = [...started(), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "Hi" }), ended(), ev({ kind: "thread.forked.out", to: "t-fork" as ThreadId, toTitle: "Listing (fork)", atTurn: T })];
  const sections = toSections(build(events, null));
  assert.equal(sections.length, 1, "the link belongs to the forked turn, not to a section of its own");
  assert.deepEqual(sections[0]!.blocks.map((b) => b.kind), ["prompt", "text", "forkOut"]);
  const link = sections[0]!.blocks[2]!;
  assert.ok(link.kind === "forkOut");
  assert.deepEqual([link.to, link.toTitle, link.key], ["t-fork", "Listing (fork)", "forkOut:t-fork"]);
});

test("a section is ended only once its turn has, which is what gates forking from it", () => {
  const open = [...started(), ev({ kind: "assistant.text", turnId: T, blockIx: 0, delta: "working" })];
  assert.deepEqual(toSections(build(open, T)).map((s) => [s.turnId, s.ended]), [[T, false]]);
  assert.deepEqual(toSections(build([...open, ended()], null)).map((s) => [s.turnId, s.ended]), [[T, true]]);
  seq = 0;
  clock = 0;
  assert.deepEqual(toSections(build([ev({ kind: "thread.archived" })], null)).map((s) => [s.turnId, s.ended]), [[null, false]], "a loose note has no turn to fork");
});

test("a recorded note is its own block and does not merge the activity around it", () => {
  const recorded = {
    file: { fileId: "n1", path: "/v/Atlas/Decisions/backups.md", name: "backups.md", mime: "text/markdown", bytes: 20, note: null },
    rel: "Atlas/Decisions/backups.md",
    summary: "added the 2026-09-13 bullet",
  };
  const sections = toSections(
    build([
      ...started(),
      ev({ kind: "tool.started", turnId: T, toolUseId: "tu1" as never, name: "Write", input: { file_path: "/v/Atlas/Decisions/backups.md" } }),
      ev({ kind: "tool.finished", turnId: T, toolUseId: "tu1" as never, output: "ok", isError: false }),
      ev({ kind: "note.recorded", note: recorded, origin: { via: "key", label: "model" } }),
      ev({ kind: "tool.started", turnId: T, toolUseId: "tu2" as never, name: "Bash", input: { command: "git commit" } }),
      ev({ kind: "tool.finished", turnId: T, toolUseId: "tu2" as never, output: "ok", isError: false }),
    ], null),
  );
  const blocks = sections[0]!.blocks;
  assert.deepEqual(blocks.map((b) => b.kind), ["prompt", "activity", "recorded", "activity"], "the card breaks the run of tool calls, the way a file card does");
  const card = blocks.find((b) => b.kind === "recorded");
  assert.ok(card && card.kind === "recorded");
  assert.equal(card.key, "recorded:n1", "keyed by the file id, so the card keeps its identity across renders");
  assert.equal(card.note.rel, "Atlas/Decisions/backups.md");
});
