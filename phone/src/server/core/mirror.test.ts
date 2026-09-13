import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadLog } from "./log";
import { Mirror, lastMirroredSeq, mirrorPath, renderTurn } from "./mirror";
import { ThreadStore } from "./thread-store";
import { groupTurns } from "../../shared/turns";
import type {
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

const turnOf = (events: ThreadEvent[]) => groupTurns(events)[0]!;

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
  const md = renderTurn(groupTurns(fixtureTurn())[0]!);

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
  assert.match(md, /<!-- helm:seq=11 -->\s*$/, "the marker is last and names the turn.ended seq");
  assert.ok(!md.includes("—") && !md.includes("–"), "no em or en dashes");
});

test("renderTurn on a clean ok turn with no usage omits the usage half of the footer", () => {
  const md = renderTurn(turnOf([
    ev(1, { kind: "input.queued", clientMsgId: "m9" as ClientMsgId, text: "hi", uploads: [], origin }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m9" as ClientMsgId, model, effort: "low", spawned: false }),
    ev(3, { kind: "assistant.text", turnId: "t:2" as TurnId, blockIx: 0, delta: "yes" }),
    ev(4, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "ok", sessionId, usage: null, error: null }),
  ]));
  assert.match(md, /^> hi$/m);
  assert.match(md, /^yes$/m);
  assert.ok(!md.includes("tokens"), "no usage line when the turn carried none");
  assert.match(md, /<!-- helm:seq=4 -->\s*$/);
});

test("renderTurn throws when the turn has no turn.ended", () => {
  assert.throws(() => renderTurn(turnOf([ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m1" as ClientMsgId, model, effort: "high", spawned: true })])));
});

test("lastMirroredSeq reads the highest marker, 0 when there is none", () => {
  assert.equal(lastMirroredSeq(""), 0);
  assert.equal(lastMirroredSeq("# A note\n\nno markers here\n"), 0);
  assert.equal(lastMirroredSeq("block\n<!-- helm:seq=7 -->\n"), 7);
  assert.equal(lastMirroredSeq("a\n<!-- helm:seq=7 -->\nb\n<!-- helm:seq=19 -->\nc\n<!-- helm:seq=12 -->\n"), 19);
});

test("mirrorPath is one note per thread under inbox/chats", () => {
  assert.equal(mirrorPath("/v", threadId), `/v/inbox/chats/${threadId}.md`);
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
  await store.create({ threadId, cwd, model, effort: "high", title: "Vault triage" });
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
  assert.equal(md.match(/<!-- helm:seq=\d+ -->/g)?.length, 2, "two markers");
  assert.match(md, /first prompt/);
  assert.match(md, /second reply/);
  assert.equal(lastMirroredSeq(md), secondEnd, "the last marker is the last turn.ended seq");

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
  assert.equal(lastMirroredSeq(before) < thirdEnd, true);

  const fresh = new Mirror(h.vault, h.store);
  await fresh.resume(h.log);
  const after = await readFile(h.note, "utf8");
  assert.equal(after.match(/^## /gm)?.length, 3, "exactly one new block");
  assert.equal(after.match(/<!-- helm:seq=\d+ -->/g)?.length, 3);
  assert.equal(after.startsWith(before), true, "the existing note is appended to, never rewritten");
  assert.equal(lastMirroredSeq(after), thirdEnd);

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
  const dir = join(h.vault, "inbox", "chats");
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
  const md = renderTurn(turnOf([
    ev(1, { kind: "input.queued", clientMsgId: "m9" as ClientMsgId, text: "send me the report", uploads: [], origin }),
    ev(2, { kind: "turn.started", turnId: "t:2" as TurnId, clientMsgId: "m9" as ClientMsgId, model, effort: "low", spawned: false }),
    ev(3, { kind: "file.offered", file: { fileId: "f1" as never, path: "/Users/d/Desktop/report.pdf", name: "report.pdf", mime: "application/pdf", bytes: 2_400_000, note: "the Q3 one" }, origin: { via: "key", label: "model" } }),
    ev(4, { kind: "assistant.text", turnId: "t:2" as TurnId, blockIx: 0, delta: "Sent." }),
    ev(5, { kind: "turn.ended", turnId: "t:2" as TurnId, outcome: "ok", sessionId, usage: null, error: null }),
  ]));
  assert.match(md, /^> sent to phone: report\.pdf \(2\.4 MB\): the Q3 one$/m);
  assert.ok(!md.includes("/Users/d"), "the path stays out of the vault note");
  assert.match(md, /^Sent\.$/m);
});
