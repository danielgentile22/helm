import assert from "node:assert/strict";
import test from "node:test";

import { DENIED, UNPLAYABLE, advance, hot } from "./turn";
import { todoId } from "./types";
import type { Phase, TurnAction } from "./turn";

const IDLE: Phase = { name: "idle" };
const LISTENING: Phase = { name: "listening" };
const TRANSCRIBING: Phase = { name: "transcribing" };
const WORKING: Phase = { name: "working", refused: false };

const ROW: TurnAction = {
  op: "add",
  id: todoId("0123456789ab"),
  dept: "Projects",
  row: "- [ ] ship the opening explorer (due: 2026-09-25)",
};

test("a press opens the microphone from idle, offline, or a failed turn", () => {
  assert.deepEqual(advance(IDLE, { kind: "press" }), LISTENING);
  assert.deepEqual(advance({ name: "offline" }, { kind: "press" }), LISTENING);
  assert.deepEqual(advance({ name: "error", message: "anything" }, { kind: "press" }), LISTENING);
});

test("a refused microphone says so, and only from listening", () => {
  assert.deepEqual(advance(LISTENING, { kind: "mic-denied" }), { name: "error", message: DENIED });
  assert.deepEqual(advance(IDLE, { kind: "mic-denied" }), IDLE);
});

test("released goes to transcribing, a clip too short to be speech goes back to idle", () => {
  assert.deepEqual(advance(LISTENING, { kind: "released" }), TRANSCRIBING);
  assert.deepEqual(advance(LISTENING, { kind: "released-short" }), IDLE);
  assert.deepEqual(advance(LISTENING, { kind: "dropped" }), IDLE);
  assert.deepEqual(advance(TRANSCRIBING, { kind: "dropped" }), IDLE);
});

test("heard goes to working, and only from transcribing", () => {
  assert.deepEqual(advance(TRANSCRIBING, { kind: "heard", turn: "2026-09-22T21-04-11-3f9c" }), WORKING);
  assert.deepEqual(advance(IDLE, { kind: "heard", turn: "2026-09-22T21-04-11-3f9c" }), IDLE);
});

test("a press while working is refused, and the refusal rides on the phase", () => {
  const after = advance(WORKING, { kind: "press" });
  assert.deepEqual(after, { name: "working", refused: true });
  assert.deepEqual(advance(after, { kind: "press" }), { name: "working", refused: true });
});

test("a poll that is still running holds working, and clears nothing", () => {
  const refused: Phase = { name: "working", refused: true };
  const same = advance(refused, { kind: "poll", phase: "working", confirmation: null, actions: [] });
  assert.deepEqual(same, refused);
  assert.deepEqual(advance(refused, { kind: "poll", phase: "heard", confirmation: null, actions: [] }), refused);
});

test("poll done goes to speaking with the confirmation, and drops the refusal", () => {
  const after = advance(
    { name: "working", refused: true },
    { kind: "poll", phase: "done", confirmation: "Added two to Projects under Compiler", actions: [ROW] },
  );
  assert.deepEqual(after, { name: "speaking", says: "Added two to Projects under Compiler" });
});

test("poll failed goes to speaking with its confirmation", () => {
  const after = advance(WORKING, {
    kind: "poll",
    phase: "failed",
    confirmation: "I could not find a todo about Acme to tick",
    actions: [],
  });
  assert.deepEqual(after, { name: "speaking", says: "I could not find a todo about Acme to tick" });
});

test("a turn with nothing to do still speaks its sentence", () => {
  const after = advance(WORKING, {
    kind: "poll",
    phase: "done",
    confirmation: "Nothing to do there",
    actions: [],
  });
  assert.deepEqual(after, { name: "speaking", says: "Nothing to do there" });
});

test("a landed turn with no sentence to speak goes straight to idle", () => {
  assert.deepEqual(advance(WORKING, { kind: "poll", phase: "done", confirmation: null, actions: [] }), IDLE);
});

test("poll cancelled goes to idle, and never speaks", () => {
  assert.deepEqual(
    advance(WORKING, { kind: "poll", phase: "cancelled", confirmation: "Cancelled", actions: [] }),
    IDLE,
  );
});

test("a poll outside working changes nothing", () => {
  assert.deepEqual(advance(IDLE, { kind: "poll", phase: "done", confirmation: "Added one", actions: [] }), IDLE);
});

test("cancel while working goes to idle, and cancel while listening drops the clip", () => {
  assert.deepEqual(advance(WORKING, { kind: "cancel" }), IDLE);
  assert.deepEqual(advance({ name: "working", refused: true }, { kind: "cancel" }), IDLE);
  assert.deepEqual(advance(LISTENING, { kind: "cancel" }), IDLE);
});

test("cancel leaves a phase that is not cancellable alone", () => {
  const speaking: Phase = { name: "speaking", says: "Added one to Chess" };
  assert.deepEqual(advance(speaking, { kind: "cancel" }), speaking);
  assert.deepEqual(advance(TRANSCRIBING, { kind: "cancel" }), TRANSCRIBING);
});

test("spoken goes to idle, and a reply that will not play is an error", () => {
  const speaking: Phase = { name: "speaking", says: "Added one to Chess" };
  assert.deepEqual(advance(speaking, { kind: "spoken" }), IDLE);
  assert.deepEqual(advance(speaking, { kind: "unplayable" }), { name: "error", message: UNPLAYABLE });
  assert.deepEqual(advance(IDLE, { kind: "spoken" }), IDLE);
});

test("a failure is an error from any hot phase and is ignored from a cold one", () => {
  assert.deepEqual(advance(WORKING, { kind: "failed", message: "gone" }), { name: "error", message: "gone" });
  assert.deepEqual(advance(TRANSCRIBING, { kind: "failed", message: "gone" }), { name: "error", message: "gone" });
  assert.deepEqual(advance(IDLE, { kind: "failed", message: "gone" }), IDLE);
});

test("health-down while hot is ignored, so a slow run never reads as offline", () => {
  assert.deepEqual(advance(WORKING, { kind: "health-down" }), WORKING);
  assert.deepEqual(advance(LISTENING, { kind: "health-down" }), LISTENING);
  assert.deepEqual(advance({ name: "speaking", says: "Added one" }, { kind: "health-down" }), {
    name: "speaking",
    says: "Added one",
  });
  assert.deepEqual(advance(IDLE, { kind: "health-down" }), { name: "offline" });
});

test("health-up only lifts offline", () => {
  assert.deepEqual(advance({ name: "offline" }, { kind: "health-up" }), IDLE);
  assert.deepEqual(advance(WORKING, { kind: "health-up" }), WORKING);
});

test("working is hot, so the health poll leaves a run alone", () => {
  assert.equal(hot(WORKING), true);
  assert.equal(hot(IDLE), false);
  assert.equal(hot({ name: "offline" }), false);
});
