import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadLog } from "./log";
import { Mirror, isRecorded, lastMarker, markRecorded, mirrorPath, renderTurn } from "./mirror";
import { FIRST_GENERATION } from "../../shared/protocol";
import { ThreadStore } from "./thread-store";
import { groupTurns, isCompleted } from "../../shared/turns";
import type {
  MessageUuid,
  ClaudeSessionId,
  ClientMsgId,
  ModelId,
  Seq,
  StagedUpload,
  ThreadEvent,
  ThreadEventBody,
  ThreadId,
  ToolUseId,
  TurnId,
  Usage,
} from "../../shared/protocol";

const threadId = "0f0f0f0f-0000-4000-8000-000000000001" as ThreadId;
const otherThreadId = "0f0f0f0f-0000-4000-8000-000000000002" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
const sessionId = "sess-1" as ClaudeSessionId;
const model = "claude-opus-5" as ModelId;

function ev(seq: number, body: ThreadEventBody): ThreadEvent {
  return { seq: seq as Seq, ts: `2026-09-11T00:00:${String(seq).padStart(2, "0")}.000Z`, ...body } as ThreadEvent;
}

const upload: StagedUpload = {
  uploadId: "u1" as never,
  path: "/tmp/staged/shot.png",
  name: "shot.png",
  mime: "image/png",
  bytes: 1234,
};

const usage: Usage = {
  inputTokens: 120,
  outputTokens: 45,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  costUsd: 0.0031,
  contextTokens: 130,
  durationMs: 1200,
};

const turnOf = (events: ThreadEvent[]) => groupTurns(events).filter(isCompleted)[0]!;
const render = (events: ThreadEvent[]): string => renderTurn(turnOf(events), FIRST_GENERATION);

async function readEvents(log: ThreadLog): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for await (const e of log.read(0)) out.push(e);
  return out;
}

/** A fixture turn: two text blocks, a thinking delta, one failed tool call, an error outcome. */
function fixtureTurn(): ThreadEvent[] {
  return [
    ev(2, { kind: "input.queued", clientMsgId: "m1" as ClientMsgId, text: "hello\nworld", uploads: [upload], origin }),
    ev(4, { kind: "turn.started", turnId: "t:4" as TurnId, clientMsgId: "m1" as ClientMsgId, model, effort: "high", spawned: true }),
    ev(5, { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "Hel" }),
    ev(6, { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "lo." }),
    ev(7, { kind: "assistant.thinking", turnId: "t:4" as TurnId, delta: "secret reasoning" }),
    ev(8, { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 1, delta: "Second block." }),
    ev(9, { kind: "tool.started", turnId: "t:4" as TurnId, toolUseId: "tu1" as ToolUseId, name: "Read", input: { file_path: "/x/y.md" } }),
    ev(10, { kind: "tool.finished", turnId: "t:4" as TurnId, toolUseId: "tu1" as ToolUseId, output: "boom", isError: true }),
    ev(11, { kind: "turn.ended", turnId: "t:4" as TurnId, outcome: "error", sessionId, usage, error: "the tool blew up" }),
  ];
}

test("renderTurn renders the prompt, text blocks, tool lines, footer, and marker", () => {
  const md = render(fixtureTurn());

  assert.match(md, /^## 2026-09-11T00:00:02\.000Z .*iphone/m, "heading carries the timestamp and the origin label");
  assert.match(md, /^> hello$/m, "prompt is a blockquote, line by line");
  assert.match(md, /^> world$/m);
  assert.match(md, /shot\.png/, "uploads are listed by filename");
  assert.match(md, /^Hello\.$/m, "text deltas of a block are concatenated in seq order");
  assert.match(md, /^Second block\.$/m, "a second block is its own paragraph");
  assert.ok(!md.includes("secret reasoning"), "thinking is omitted");
  assert.match(md, /^> Read \/x\/y\.md/m, "a tool call is one line with no output");
  assert.ok(!md.includes("boom"), "tool output is never mirrored");
  assert.match(md, /failed/, "a failed tool is marked by a word, not by color alone");
  assert.match(md, /error/, "the outcome is in the footer");
  assert.match(md, /the tool blew up/, "the error message is in the footer");
  assert.match(md, /120/, "input tokens are in the footer");
  assert.match(md, /45/, "output tokens are in the footer");
  assert.match(md, /\$0\.0031/, "cost is in the footer");
  assert.match(md, /<!-- helm:seq=11 gen=0 -->\s*$/, "the marker is last and names the turn.ended seq and its generation");
  assert.ok(!md.includes("—") && !md.includes("–"), "no em or en dashes");
});

test("renderTurn on a clean ok turn with no usage omits the usage half of the footer", () => {
  const md = render([
    ev(1, { kind: "input.queued", clientMsgId: "m9" as ClientMsgId, text: "hi", uploads: [], origin }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m9" as ClientMsgId, model, effort: "low", spawned: false }),
    ev(3, { kind: "assistant.text", turnId: "t:2" as TurnId, blockIx: 0, delta: "yes" }),
    ev(4, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "ok", sessionId, usage: null, error: null }),
  ]);
  assert.match(md, /^> hi$/m);
  assert.match(md, /^yes$/m);
  assert.ok(!md.includes("tokens"), "no usage line when the turn carried none");
  assert.match(md, /<!-- helm:seq=4 gen=0 -->\s*$/);
});

test("lastMarker reads the highest marker with its generation, an old marker as generation 0, and nothing as seq 0", () => {
  assert.deepEqual(lastMarker(""), { seq: 0, generation: 0 });
  assert.deepEqual(lastMarker("# A note\n\nno markers here\n"), { seq: 0, generation: 0 });
  assert.deepEqual(lastMarker("block\n<!-- helm:seq=7 -->\n"), { seq: 7, generation: 0 });
  assert.deepEqual(lastMarker("block\n<!-- helm:seq=7 gen=3 -->\n"), { seq: 7, generation: 3 });
  assert.deepEqual(lastMarker("a\n<!-- helm:seq=7 -->\nb\n<!-- helm:seq=19 gen=1 -->\nc\n<!-- helm:seq=12 gen=2 -->\n"), { seq: 19, generation: 1 });
});

test("mirrorPath is one note per thread under Inbox/helm2-phone-chats", () => {
  assert.equal(mirrorPath("/v", threadId), `/v/Inbox/helm2-phone-chats/${threadId}.md`);
});

// ---------------------------------------------------------------------------
// Integration over a real ThreadLog and a real vault directory
// ---------------------------------------------------------------------------

interface Harness {
  readonly vault: string;
  readonly threadsRoot: string;
  readonly store: ThreadStore;
  readonly log: ThreadLog;
  readonly note: string;
}

async function harness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "helm2-mirror-"));
  const vault = join(home, "vault");
  const threadsRoot = join(home, "threads");
  const cwd = join(home, "work");
  await mkdir(vault, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const store = new ThreadStore(threadsRoot);
  await store.create({ threadId, cwd, model, effort: "high", permissionMode: "bypass", title: "Vault triage" });
  const log = await ThreadLog.open(threadId, join(threadsRoot, threadId));
  return { vault, threadsRoot, store, log, note: mirrorPath(vault, threadId) };
}

/** Append one complete turn to a real log and resolve once turn.ended is on disk. */
async function appendTurn(log: ThreadLog, msgId: string, prompt: string, reply: string): Promise<Seq> {
  await log.append({ kind: "input.queued", clientMsgId: msgId as ClientMsgId, text: prompt, uploads: [], origin });
  const start = await log.append((seq) => ({
    kind: "turn.started" as const,
    turnId: `t:${seq}` as TurnId,
    clientMsgId: msgId as ClientMsgId,
    model,
    effort: "high" as const,
    spawned: false,
  }));
  await log.append({ kind: "assistant.text", turnId: start.turnId, blockIx: 0, delta: reply });
  await log.append({ kind: "tool.started", turnId: start.turnId, toolUseId: `tu-${msgId}` as ToolUseId, name: "Read", input: { file_path: "/x/y.md" } });
  await log.append({ kind: "tool.finished", turnId: start.turnId, toolUseId: `tu-${msgId}` as ToolUseId, output: "contents", isError: false });
  const end = await log.append({ kind: "turn.ended", turnId: start.turnId, outcome: "ok", sessionId, usage, error: null });
  return end.seq;
}

test("watch appends one block per completed turn, seeds frontmatter once", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  mirror.watch(h.log);

  await appendTurn(h.log, "m1", "first prompt", "first reply");
  const secondEnd = await appendTurn(h.log, "m2", "second prompt", "second reply");
  await mirror.idle();

  const md = await readFile(h.note, "utf8");
  assert.equal(md.match(/^---$/gm)?.length, 2, "frontmatter fences appear exactly once");
  assert.match(md, new RegExp(`^thread: ${threadId}$`, "m"));
  assert.match(md, /^type: chat$/m);
  assert.match(md, /^tags: \[chat\]$/m);
  assert.match(md, /^# Vault triage$/m, "heading is the title when one is known");
  assert.equal(md.match(/^## /gm)?.length, 2, "two turn blocks");
  assert.equal(md.match(/<!-- helm:seq=\d+ gen=\d+ -->/g)?.length, 2, "two markers");
  assert.match(md, /first prompt/);
  assert.match(md, /second reply/);
  assert.equal(lastMarker(md).seq, secondEnd, "the last marker is the last turn.ended seq");

  await rm(h.vault, { recursive: true });
});

test("resume catches up a turn the mirror missed, and a second resume is byte identical", async () => {
  const h = await harness();
  const watched = new Mirror(h.vault, h.store);
  const detach = watched.watch(h.log);
  await appendTurn(h.log, "m1", "first prompt", "first reply");
  await appendTurn(h.log, "m2", "second prompt", "second reply");
  await watched.idle();
  const before = await readFile(h.note, "utf8");

  // Crash between log and mirror: a third turn lands with nobody watching.
  detach();
  const thirdEnd = await appendTurn(h.log, "m3", "third prompt", "third reply");
  assert.equal(lastMarker(before).seq < thirdEnd, true);

  const fresh = new Mirror(h.vault, h.store);
  await fresh.resume(h.log);
  const after = await readFile(h.note, "utf8");
  assert.equal(after.match(/^## /gm)?.length, 3, "exactly one new block");
  assert.equal(after.match(/<!-- helm:seq=\d+ gen=\d+ -->/g)?.length, 3);
  assert.equal(after.startsWith(before), true, "the existing note is appended to, never rewritten");
  assert.equal(lastMarker(after).seq, thirdEnd);

  await fresh.resume(h.log);
  assert.equal(await readFile(h.note, "utf8"), after, "a second resume appends nothing");

  await rm(h.vault, { recursive: true });
});

test("a prompt queued below the last marker still heads its own turn's block", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  mirror.watch(h.log);
  await h.log.append({ kind: "input.queued", clientMsgId: "m1" as ClientMsgId, text: "first prompt", uploads: [], origin });
  const first = await h.log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m1" as ClientMsgId, model, effort: "high" as const, spawned: false }));
  await h.log.append({ kind: "input.queued", clientMsgId: "m2" as ClientMsgId, text: "second prompt", uploads: [], origin });
  await h.log.append({ kind: "turn.ended", turnId: first.turnId, outcome: "ok", sessionId, usage, error: null });
  await mirror.idle();
  const one = await readFile(h.note, "utf8");
  assert.equal(one.match(/^## /gm)?.length, 1);
  assert.ok(!one.includes("second prompt"), "the queued prompt is not mirrored until its turn ends");

  const second = await h.log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m2" as ClientMsgId, model, effort: "high" as const, spawned: false }));
  await h.log.append({ kind: "assistant.text", turnId: second.turnId, blockIx: 0, delta: "second reply" });
  await h.log.append({ kind: "turn.ended", turnId: second.turnId, outcome: "ok", sessionId, usage, error: null });
  await mirror.idle();
  const two = await readFile(h.note, "utf8");
  assert.equal(two.match(/^## /gm)?.length, 2);
  assert.match(two, /^> second prompt$/m, "the prompt sits below the first marker and is still found");
  assert.match(two, /^second reply$/m);

  await rm(h.vault, { recursive: true });
});

test("resume skips a turn that has no turn.ended", async () => {
  const h = await harness();
  await appendTurn(h.log, "m1", "first prompt", "first reply");
  await h.log.append({ kind: "input.queued", clientMsgId: "m2" as ClientMsgId, text: "second prompt", uploads: [], origin });
  await h.log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m2" as ClientMsgId, model, effort: "high" as const, spawned: false }));

  const mirror = new Mirror(h.vault, h.store);
  await mirror.resume(h.log);
  const md = await readFile(h.note, "utf8");
  assert.equal(md.match(/^## /gm)?.length, 1, "only the completed turn is mirrored");
  assert.ok(!md.includes("second prompt"));

  await rm(h.vault, { recursive: true });
});

test("prune removes only thread notes older than the retention window", async () => {
  const h = await harness();
  const dir = join(h.vault, "Inbox", "helm2-phone-chats");
  await mkdir(dir, { recursive: true });
  const old = join(dir, `${threadId}.md`);
  const recent = join(dir, `${otherThreadId}.md`);
  const unrelated = join(dir, "README.md");
  for (const f of [old, recent, unrelated]) await writeFile(f, "x\n");

  const ancient = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  await utimes(old, ancient, ancient);
  await utimes(unrelated, ancient, ancient);

  await new Mirror(h.vault, h.store).prune();

  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, [`${otherThreadId}.md`, "README.md"].sort(), "only the stale thread note is gone");
  await stat(unrelated); // still there

  await rm(h.vault, { recursive: true });
});

test("prune is a no-op when the vault has no chats directory, and creates nothing", async () => {
  const h = await harness();
  await new Mirror(h.vault, h.store).prune();
  assert.deepEqual(await readdir(h.vault), [], "nothing else is ever written into the vault");
  await rm(h.vault, { recursive: true });
});

test("renderTurn lists a file sent to the phone with its size and note, never its path", () => {
  const md = render([
    ev(1, { kind: "input.queued", clientMsgId: "m9" as ClientMsgId, text: "send me the report", uploads: [], origin }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m9" as ClientMsgId, model, effort: "low", spawned: false }),
    ev(3, { kind: "file.offered", file: { fileId: "f1" as never, path: "/Users/d/Desktop/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 2_400_000, note: "the Q3 one" }, origin: { via: "key", label: "model" } }),
    ev(4, { kind: "assistant.text", turnId: "t:2" as TurnId, blockIx: 0, delta: "Sent." }),
    ev(5, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "ok", sessionId, usage: null, error: null }),
  ]);
  assert.match(md, /^> sent to phone: report\.pdf \(2\.4 MB\): the Q3 one$/m);
  assert.ok(!md.includes("/Users/d"), "the path stays out of the vault note");
  assert.match(md, /^Sent\.$/m);
});

test("renderTurn writes an ask as what was asked and how it was answered, with expiry and rule denials told apart from a person's deny", () => {
  const ask = (n: number, askId: string, payload: unknown) => ev(n, { kind: "ask.opened", turnId: "t:2" as TurnId, askId: askId as never, ask: payload as never });
  const answered = (n: number, askId: string, answer: unknown, by: unknown) => ev(n, { kind: "ask.answered", turnId: "t:2" as TurnId, askId: askId as never, answer: answer as never, by: by as never });
  const bash = (command: string) => ({ kind: "tool", toolName: "Bash", input: { command }, toolUseId: "tu" as never, title: null, description: null });
  const md = render([
    ev(1, { kind: "input.queued", clientMsgId: "m9" as ClientMsgId, text: "ship it", uploads: [], origin }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m9" as ClientMsgId, model, effort: "low", spawned: false }),
    ask(3, "a1", bash("git push")),
    answered(4, "a1", { kind: "allow" }, { by: "user", origin: { via: "pwa", label: "iphone" } }),
    ask(5, "a2", bash("rm -rf build")),
    answered(6, "a2", { kind: "deny", reason: "keep it" }, { by: "user", origin: { via: "key", label: "laptop" } }),
    ask(7, "a3", bash("npm test")),
    answered(8, "a3", { kind: "allowTurn" }, { by: "user", origin: { via: "pwa", label: "iphone" } }),
    ask(9, "a4", { kind: "question", questions: [{ question: "Tabs or spaces?", header: "Style", options: [], multiSelect: false }] }),
    answered(10, "a4", { kind: "answers", answers: [{ kind: "options", labels: ["Tabs"] }] }, { by: "user", origin: { via: "pwa", label: "iphone" } }),
    ask(11, "a5", { ...bash("curl x"), title: "Claude wants to fetch x" }),
    answered(12, "a5", { kind: "deny", reason: "Bash(curl:*) is denied by a rule" }, { by: "system", reason: "rule" }),
    ask(13, "a6", bash("git push --force")),
    answered(14, "a6", { kind: "deny", reason: null }, { by: "system", reason: "interrupted" }),
    ask(15, "a7", bash("never answered")),
    ev(16, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "interrupted", sessionId, usage: null, error: null }),
  ]);
  const lines = md.split("\n").filter((l) => l.startsWith("> a"));
  assert.deepEqual(lines, [
    "> asked: Bash git push",
    "> answered: allowed [iphone]",
    "> asked: Bash rm -rf build",
    "> answered: denied: keep it [laptop]",
    "> asked: Bash npm test",
    "> answered: allowed for the turn [iphone]",
    "> asked: Tabs or spaces?",
    "> answered: Tabs [iphone]",
    "> asked: Claude wants to fetch x",
    "> answered: auto-denied: Bash(curl:*) is denied by a rule",
    "> asked: Bash git push --force",
    "> answered: expired (interrupted)",
    "> asked: Bash never answered",
    "> answered: (none)",
  ]);
});

test("a fork's note opens by naming where it came from, so it does not read as a duplicated conversation", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  const end = await appendTurn(h.log, "m1", "copied prompt", "copied reply");
  const forkPoint = (await readEvents(h.log)).find((e) => e.seq === end)!.ts;
  await h.log.append({ kind: "thread.forked", from: otherThreadId, fromTitle: "Vault triage", atTurn: "t:9" as TurnId, resume: { sessionId, at: "msg-1" as MessageUuid } });
  await mirror.resume(h.log);

  const md = await readFile(h.note, "utf8");
  assert.match(md, new RegExp(`^forked_from: "${otherThreadId}"$`, "m"), "the frontmatter names the source thread");
  const body = md.split("\n# ")[1]!;
  assert.match(body, new RegExp(`copied from \\[\\[${otherThreadId}\\|Vault triage\\]\\]`), "the source is an Obsidian wikilink to its own note");
  assert.match(body, new RegExp(`forked at ${forkPoint}`), "the fork point is the stamp of the last copied turn.ended");
  assert.match(body, /remembers the turns above/, "a fork with a session to resume says Claude carries the copied turns");
  assert.ok(body.indexOf("copied from") < body.indexOf("## "), "the sentence is the first body line, above the copied turns");

  await rm(h.vault, { recursive: true });
});

test("a fork with no session to resume says so, rather than implying Claude remembers the copied turns", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  await appendTurn(h.log, "m1", "copied prompt", "copied reply");
  await h.log.append({ kind: "thread.forked", from: otherThreadId, fromTitle: null, atTurn: "t:9" as TurnId, resume: null });
  await mirror.resume(h.log);

  const md = await readFile(h.note, "utf8");
  assert.match(md, new RegExp(`\\[\\[${otherThreadId}\\|${otherThreadId}\\]\\]`), "an untitled source is linked by its id");
  assert.match(md, /does not remember the turns above/);
  assert.ok(!md.includes("—") && !md.includes("–"), "no dashes as sentence punctuation in vault prose");

  await rm(h.vault, { recursive: true });
});

test("renderTurn marks the turn someone forked from with a line naming the copy", () => {
  const events = [...fixtureTurn(), ev(12, { kind: "thread.forked.out", to: otherThreadId, toTitle: "Vault triage (fork)", atTurn: "t:4" as TurnId })];
  const md = render(events);
  assert.match(md, /^> forked to: Vault triage \(fork\)$/m);
});

test("a note in generation 0 against a log in generation 1 is rebuilt once, whole, and then appended to", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  mirror.watch(h.log);
  await appendTurn(h.log, "m1", "first prompt", "first reply");
  await h.log.append({ kind: "input.queued", clientMsgId: "m2" as ClientMsgId, text: "second prompt", uploads: [], origin });
  const second = await h.log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m2" as ClientMsgId, model, effort: "high" as const, spawned: false }));
  for (const word of ["second ", "re", "ply"]) await h.log.append({ kind: "assistant.text", turnId: second.turnId, blockIx: 0, delta: word });
  await h.log.append({ kind: "turn.ended", turnId: second.turnId, outcome: "ok", sessionId, usage, error: null });
  await mirror.idle();
  const old = await readFile(h.note, "utf8");
  assert.deepEqual(lastMarker(old).generation, 0);

  assert.equal((await h.log.compact()).ok, true);
  assert.equal(h.log.getHead().generation, 1);
  const thirdEnd = await appendTurn(h.log, "m3", "third prompt", "third reply");
  await mirror.idle();

  const rebuilt = await readFile(h.note, "utf8");
  assert.equal(rebuilt.match(/^---$/gm)?.length, 2, "frontmatter once");
  assert.equal(rebuilt.match(/^## /gm)?.length, 3, "every turn exactly once");
  assert.equal(rebuilt.match(/first reply/g)?.length, 1);
  assert.equal(rebuilt.match(/second reply/g)?.length, 1);
  assert.equal(rebuilt.match(/third reply/g)?.length, 1);
  assert.deepEqual(rebuilt.match(/gen=\d+/g), ["gen=1", "gen=1", "gen=1"], "every marker names the generation the note was written from");
  assert.deepEqual(lastMarker(rebuilt), { seq: thirdEnd, generation: 1 });
  assert.equal(rebuilt.startsWith(old), false, "the old note was replaced, not appended to");

  const fourthEnd = await appendTurn(h.log, "m4", "fourth prompt", "fourth reply");
  await mirror.idle();
  const appended = await readFile(h.note, "utf8");
  assert.equal(appended.startsWith(rebuilt), true, "within a generation the note is appended to");
  assert.equal(appended.match(/^## /gm)?.length, 4);
  assert.deepEqual(lastMarker(appended), { seq: fourthEnd, generation: 1 });

  await rm(h.vault, { recursive: true });
});

const recorded = (rel: string, summary: string, fileId = "n1") => ({
  file: { fileId: fileId as never, path: `/v/${rel}`, name: rel.split("/").at(-1)!, mime: "text/markdown", bytes: 20, note: null },
  rel,
  summary,
});

test("renderTurn lists the notes a save wrote as wikilinks with what changed in each", () => {
  const md = render([
    ev(1, { kind: "input.queued", clientMsgId: "s1" as ClientMsgId, text: "Record this conversation", uploads: [], origin: { via: "pwa", label: "vault" } }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "s1" as ClientMsgId, model, effort: "high", spawned: false }),
    ev(3, { kind: "note.recorded", note: recorded("Atlas/Decisions/2026-09-13-backups.md", "added 2026-09-13 bullet on backups"), origin: { via: "key", label: "model" } }),
    ev(4, { kind: "note.recorded", note: recorded("Atlas/Areas/Health.md", "noted the new routine", "n2"), origin: { via: "key", label: "model" } }),
    ev(5, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "ok", sessionId, usage: null, error: null }),
  ]);
  assert.match(md, /^Recorded to:$/m);
  assert.match(md, /^- \[\[Atlas\/Decisions\/2026-09-13-backups\|2026-09-13-backups\]\]: added 2026-09-13 bullet on backups$/m, "the wikilink drops the extension, the alias is the note's own name");
  assert.match(md, /^- \[\[Atlas\/Areas\/Health\|Health\]\]: noted the new routine$/m);
  assert.ok(md.indexOf("Recorded to:") < md.indexOf("_ok_"), "the block sits above the footer");
});

test("markRecorded adds the frontmatter field once, and isRecorded reads only the leading block", () => {
  const note = "---\nthread: abc\ntags: [chat]\n---\n\n# Title\n";
  const marked = markRecorded(note);
  assert.equal(marked, "---\nthread: abc\ntags: [chat]\nrecorded: true\n---\n\n# Title\n");
  assert.equal(markRecorded(marked), marked, "idempotent: a note already marked is returned unchanged");
  assert.equal(markRecorded("# no frontmatter\n"), "# no frontmatter\n");

  assert.equal(isRecorded(marked), true);
  assert.equal(isRecorded(note), false);
  assert.equal(isRecorded("# no frontmatter\nrecorded: true\n"), false, "a line in the body is not frontmatter");
  assert.equal(isRecorded("---\nthread: abc\n---\n\nbody\n\n---\nrecorded: true\n---\n"), false, "only the leading block counts");
});

test("catchUp flips an existing note's frontmatter to recorded, and prune then keeps it past the retention window", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  const detach = mirror.watch(h.log);

  await appendTurn(h.log, "m1", "ordinary work", "done");
  await mirror.idle();
  assert.equal(isRecorded(await readFile(h.note, "utf8")), false, "frontmatter is seeded once, without the field");

  await h.log.append({ kind: "note.recorded", note: recorded("Atlas/Decisions/backups.md", "added the bullet"), origin: { via: "key", label: "model" } });
  await appendTurn(h.log, "m2", "save it", "recorded one note");
  await mirror.idle();
  detach();

  const text = await readFile(h.note, "utf8");
  assert.equal(isRecorded(text), true, "the existing note is rewritten rather than appended to");
  assert.match(text, /^# Vault triage$/m, "and keeps everything it already had");
  assert.match(text, /ordinary work/);
  assert.equal(text.match(/^---$/gm)?.length, 2, "exactly one frontmatter block");

  const stale = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  const plain = join(h.vault, "Inbox", "helm2-phone-chats", `${otherThreadId}.md`);
  await writeFile(plain, "---\nthread: other\n---\n\n# other\n");
  await utimes(plain, stale, stale);
  await utimes(h.note, stale, stale);

  await mirror.prune();
  assert.deepEqual(await readdir(join(h.vault, "Inbox", "helm2-phone-chats")), [`${threadId}.md`], "a recorded note is kept so its provenance links do not go dead");
  await rm(h.vault, { recursive: true });
});

test("a rebuilt note carries the recorded field from the events themselves", async () => {
  const h = await harness();
  const mirror = new Mirror(h.vault, h.store);
  await h.log.append({ kind: "note.recorded", note: recorded("Atlas/Decisions/backups.md", "added the bullet"), origin: { via: "key", label: "model" } });
  await appendTurn(h.log, "m1", "save it", "recorded one note");
  await mirror.resume(h.log);
  assert.equal(isRecorded(await readFile(h.note, "utf8")), true);
  await rm(h.vault, { recursive: true });
});
