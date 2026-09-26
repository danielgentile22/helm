import assert from "node:assert/strict";
import test from "node:test";

import { WAKE_MS, heat, phase } from "./phase";
import { ms, thingId, todoId } from "./types";
import type { Ms, Thing } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = ms(Date.parse("2026-09-17T12:00:00-04:00"));

const at = (offsetMs: number): Ms => ms(NOW + offsetMs);

function aJob(when: Ms): Thing {
  return { kind: "job", id: thingId("routine:capture"), dept: "Projects", label: "capture",
           at: when, schedule: "every 30m", path: "runner/routines/capture.sh" };
}

function aTodo(when: Ms | null, since: Ms): Thing {
  return { kind: "todo", id: thingId("todo:0123456789ab"), todoId: todoId("0123456789ab"),
           dept: "Chess", project: null, label: "enter the October open", at: when, due: null, since,
           doneToday: false, notes: "", subs: [], path: "Chess/Chess.md", line: 12, doneWhen: null };
}

test("a thing still ahead is arriving, and says how long by", () => {
  assert.deepEqual(phase(aJob(at(HOUR_MS)), NOW), { state: "arriving", inMs: HOUR_MS });
  assert.deepEqual(phase(aTodo(at(2 * DAY_MS), at(-DAY_MS)), NOW), { state: "arriving", inMs: 2 * DAY_MS });
});

test("a job is landed an hour after it starts, and never a negative age", () => {
  assert.deepEqual(phase(aJob(at(-2 * HOUR_MS)), NOW), { state: "landed", agoMs: HOUR_MS });
  assert.deepEqual(phase(aJob(at(-HOUR_MS / 2)), NOW), { state: "landed", agoMs: 0 });
  assert.deepEqual(phase(aJob(NOW), NOW), { state: "landed", agoMs: 0 });
});

test("a dated todo is late the moment its date passes, never landed", () => {
  assert.equal(phase(aTodo(at(-1), at(-DAY_MS)), NOW).state, "late");
  const fourDays = phase(aTodo(at(-4 * DAY_MS), at(-5 * DAY_MS)), NOW);
  assert.deepEqual(fourDays, { state: "late", lateMs: 4 * DAY_MS, heat: 1 });
  assert.equal(phase(aTodo(NOW, at(-DAY_MS)), NOW).state, "late", "at the instant it is due");
});

test("an undated todo is open with an age, never late", () => {
  assert.deepEqual(phase(aTodo(null, at(-10 * DAY_MS)), NOW), { state: "open", ageMs: 10 * DAY_MS });
  assert.deepEqual(phase(aTodo(null, at(-5 * 60_000)), NOW), { state: "open", ageMs: 5 * 60_000 });
});

test("an undated todo opened after now has an age of zero, never a negative one", () => {
  assert.deepEqual(phase(aTodo(null, at(HOUR_MS)), NOW), { state: "open", ageMs: 0 });
});

test("a todo one millisecond past its date is late, so a date is what makes lateness", () => {
  const dated = phase(aTodo(at(-WAKE_MS - 1), at(-WAKE_MS - 1)), NOW);
  assert.equal(dated.state, "late");
  assert.equal(phase(aTodo(null, at(-WAKE_MS - 1)), NOW).state, "open");
});

test("heat is 1 at seven days late and 0 at thirty seven", () => {
  assert.equal(heat(WAKE_MS), 1);
  assert.equal(heat(37 * DAY_MS), 0);
  assert.equal(heat(0), 1, "nothing is hotter than newly late");
  assert.equal(heat(100 * DAY_MS), 0, "and nothing is colder than cold");
  assert.equal(heat(22 * DAY_MS), 0.5, "halfway between the two");
});
