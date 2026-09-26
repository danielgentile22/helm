import { test } from "node:test";
import assert from "node:assert/strict";
import { forkedEvents, forkTitle } from "./fork";
import type { ClaudeSessionId, ClientMsgId, MessageUuid, ModelId, Seq, ThreadConfig, ThreadEvent, ThreadEventBody, ThreadId, ToolUseId, TurnId } from "../../shared/protocol";

const sourceId = "0f0f0f0f-0000-4000-8000-000000000001" as ThreadId;
const forkId = "0f0f0f0f-0000-4000-8000-000000000002" as ThreadId;
const otherId = "0f0f0f0f-0000-4000-8000-000000000003" as ThreadId;
const origin = { via: "pwa", label: "iphone" } as const;
const model = "claude-opus-5" as ModelId;
const NOW = "2026-09-14T12:00:00.000Z";

function ev(seq: number, body: ThreadEventBody): ThreadEvent {
  return { seq: seq as Seq, ts: `2026-09-11T00:00:${String(seq).padStart(2, "0")}.000Z`, ...body } as ThreadEvent;
}

function config(over: Partial<ThreadConfig> = {}): ThreadConfig {
  return { threadId: sourceId, cwd: "/w", model, effort: "high", permissionMode: "bypass", title: "Source", createdAt: "2026-09-11T00:00:00.000Z", archivedAt: null, ...over };
}

const forkConfig = config({ threadId: forkId, title: "Source (fork)", createdAt: NOW });

/**
 * Two complete turns plus a third left running, with one of everything the
 * copy is supposed to drop between them. The second turn's id must be remapped
 * because two events before it are skipped.
 */
function source(): ThreadEvent[] {
  return [
    ev(1, { kind: "thread.created", config: config() }),
    ev(2, { kind: "input.queued", clientMsgId: "m1" as ClientMsgId, text: "first", uploads: [], origin }),
    ev(3, { kind: "session.bound", sessionId: "sess-1" as ClaudeSessionId }),
    ev(4, { kind: "turn.started", turnId: "t:4" as TurnId, clientMsgId: "m1" as ClientMsgId, model, effort: "high", spawned: true }),
    ev(5, { kind: "assistant.text", turnId: "t:4" as TurnId, blockIx: 0, delta: "Hello" }),
    ev(6, { kind: "turn.ended", turnId: "t:4" as TurnId, outcome: "ok", sessionId: "sess-1" as ClaudeSessionId, usage: null, error: null, forkPoint: "msg-1" as MessageUuid }),
    ev(7, { kind: "thread.forked.out", to: otherId, toTitle: "Source (fork)", atTurn: "t:4" as TurnId }),
    ev(8, { kind: "thread.archived" }),
    ev(9, { kind: "thread.config", patch: { title: "Renamed" }, origin }),
    ev(10, { kind: "input.queued", clientMsgId: "m2" as ClientMsgId, text: "second", uploads: [], origin }),
    ev(11, { kind: "input.queued", clientMsgId: "m3" as ClientMsgId, text: "third", uploads: [], origin }),
    ev(12, { kind: "turn.started", turnId: "t:12" as TurnId, clientMsgId: "m2" as ClientMsgId, model, effort: "high", spawned: false }),
    ev(13, { kind: "upload.staged", upload: { uploadId: "u1" as never, path: "/w/.helm2-uploads/u1-a.png", name: "a.png", mime: "image/png", bytes: 9 }, origin }),
    ev(14, { kind: "tool.started", turnId: "t:12" as TurnId, toolUseId: "tu1" as ToolUseId, name: "Read", input: { file_path: "/x" } }),
    ev(15, { kind: "tool.finished", turnId: "t:12" as TurnId, toolUseId: "tu1" as ToolUseId, output: "ok", isError: false }),
    ev(16, { kind: "turn.ended", turnId: "t:12" as TurnId, outcome: "ok", sessionId: "sess-2" as ClaudeSessionId, usage: null, error: null, forkPoint: "msg-2" as MessageUuid }),
    ev(17, { kind: "turn.started", turnId: "t:17" as TurnId, clientMsgId: "m3" as ClientMsgId, model, effort: "high", spawned: false }),
  ];
}

test("forkedEvents copies the log up to the chosen turn.ended, skipping what a new thread must not inherit", () => {
  const out = forkedEvents(source(), "t:12" as TurnId, forkConfig, NOW)!;
  assert.ok(out);

  assert.deepEqual(
    out.map((e) => e.kind),
    ["thread.created", "input.queued", "session.bound", "turn.started", "assistant.text", "turn.ended", "thread.config", "input.queued", "turn.started", "upload.staged", "tool.started", "tool.finished", "turn.ended", "thread.forked"],
    "the source's own thread.created, its archive, its outbound fork link and the input.queued whose turn is past the fork point are all dropped",
  );
  assert.deepEqual(out.map((e) => e.seq), Array.from({ length: out.length }, (_, i) => i + 1), "seqs are contiguous from 1");

  const copiedQueued = out.filter((e) => e.kind === "input.queued");
  assert.deepEqual(copiedQueued.map((e) => e.clientMsgId), ["m1", "m2"], "only prompts whose turn is inside the copied range");
  assert.equal(copiedQueued[0]!.ts, "2026-09-11T00:00:02.000Z", "a copied event keeps the timestamp it happened at");
  assert.equal(out[0]!.ts, NOW, "thread.created and thread.forked are new facts and carry the fork's own stamp");
  assert.equal(out.at(-1)!.ts, NOW);
  assert.equal(out[0]!.kind === "thread.created" && out[0]!.config.threadId, forkId);
});

test("forkedEvents remaps every turn id, because a TurnId names the seq of its own turn.started", () => {
  const out = forkedEvents(source(), "t:12" as TurnId, forkConfig, NOW)!;
  const starts = out.filter((e) => e.kind === "turn.started");
  assert.deepEqual(starts.map((e) => [e.seq, e.turnId]), [[4, "t:4"], [9, "t:9"]], "the second turn shifts up by the two skipped events");
  const owned = out.filter((e) => "turnId" in e).map((e) => (e as { turnId: TurnId }).turnId);
  assert.deepEqual(owned, ["t:4", "t:4", "t:4", "t:9", "t:9", "t:9", "t:9"], "the turn's content follows its turn.started's new id");
  assert.ok(!owned.includes("t:12" as TurnId), "no event still points at a seq from the source log");
});

test("forkedEvents carries the session and fork point of the copied turn, and the source's title as it stood there", () => {
  const out = forkedEvents(source(), "t:12" as TurnId, forkConfig, NOW)!;
  const divider = out.at(-1)!;
  assert.equal(divider.kind, "thread.forked");
  assert.ok(divider.kind === "thread.forked");
  assert.equal(divider.from, sourceId);
  assert.equal(divider.fromTitle, "Renamed", "the title the source carried at the fork point, not the one it was created with");
  assert.equal(divider.atTurn, "t:12", "atTurn names the turn in the SOURCE log, which is what a link back resolves against");
  assert.deepEqual(divider.resume, { sessionId: "sess-2", at: "msg-2" });
});

test("forkedEvents resumes nothing when the copied turn recorded no fork point, so Claude starts fresh there", () => {
  const events = source().map((e) => (e.kind === "turn.ended" && e.turnId === "t:12" ? ({ ...e, forkPoint: undefined } as ThreadEvent) : e));
  const divider = forkedEvents(events, "t:12" as TurnId, forkConfig, NOW)!.at(-1)!;
  assert.ok(divider.kind === "thread.forked");
  assert.equal(divider.resume, null);
});

test("forkedEvents refuses a turn this log does not have and a turn that has not ended", () => {
  assert.equal(forkedEvents(source(), "t:99" as TurnId, forkConfig, NOW), null, "unknown turn");
  assert.equal(forkedEvents(source(), "t:17" as TurnId, forkConfig, NOW), null, "the running turn has no turn.ended to copy up to");
});

test("forkTitle numbers repeated forks so a list of retries reads in order", () => {
  const table: [string | null, string][] = [
    ["Vault triage", "Vault triage (fork)"],
    ["Vault triage (fork)", "Vault triage (fork 2)"],
    ["Vault triage (fork 2)", "Vault triage (fork 3)"],
    ["Vault triage (fork 9)", "Vault triage (fork 10)"],
    [null, "Untitled (fork)"],
    ["Notes (forked)", "Notes (forked) (fork)"],
  ];
  for (const [input, want] of table) assert.equal(forkTitle(input), want, String(input));
});
