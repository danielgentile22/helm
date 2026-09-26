import assert from "node:assert/strict";
import test from "node:test";

import { draftOf, isEmpty, patchOf } from "./edit";
import { ms, thingId, todoId } from "./types";
import type { Draft, TodoThing } from "./edit";

const TZ = "America/New_York";

function todo(over: Partial<TodoThing> = {}): TodoThing {
  return {
    kind: "todo",
    id: thingId("todo:0123456789ab"),
    todoId: todoId("0123456789ab"),
    dept: "Chess",
    project: "Camps",
    label: "book the summer camp",
    at: ms(Date.parse("2026-09-25T21:00:00Z")),
    due: "2026-09-25",
    since: ms(0),
    doneToday: false,
    notes: "",
    subs: [],
    path: "Vault/Atlas/Chess/Chess.md",
    line: 12,
    doneWhen: null,
    ...over,
  };
}

const BASE: Draft = draftOf(todo(), TZ);

test("a draft reads the todo in the shapes the inputs want", () => {
  assert.deepEqual(BASE, { text: "book the summer camp", when: "due", due: "2026-09-25", at: "", project: "Camps" });
  assert.equal(draftOf(todo({ due: null, at: null, project: null }), TZ).when, "undated");
  const event = draftOf({ ...todo(), kind: "event", due: null, at: ms(Date.parse("2026-09-24T22:30:00Z")) }, TZ);
  assert.equal(event.when, "event");
  assert.equal(event.at, "2026-09-24T18:30");
  assert.equal(draftOf({ ...todo(), kind: "daily", due: null }, TZ).when, "daily");
});

test("an untouched form sends nothing", () => {
  const out = patchOf(BASE, { ...BASE, text: "  book the   summer camp " });
  assert.ok("patch" in out && isEmpty(out.patch));
});

test("only the fields that moved are named", () => {
  assert.deepEqual(patchOf(BASE, { ...BASE, text: "book the winter camp" }), { patch: { text: "book the winter camp" } });
  assert.deepEqual(patchOf(BASE, { ...BASE, due: "2026-10-01" }), {
    patch: { when: { kind: "todo", due: "2026-10-01" } },
  });
  assert.deepEqual(patchOf(BASE, { ...BASE, when: "undated" }), { patch: { when: { kind: "todo", due: null } } });
  assert.deepEqual(patchOf(BASE, { ...BASE, when: "daily" }), { patch: { when: { kind: "daily" } } });
  assert.deepEqual(patchOf(BASE, { ...BASE, when: "event", at: "2026-09-30T09:15" }), {
    patch: { when: { kind: "event", at: "2026-09-30 09:15" } },
  });
});

test("clearing the directive unfiles the todo, and a new name moves it", () => {
  assert.deepEqual(patchOf(BASE, { ...BASE, project: " " }), { patch: { project: null } });
  assert.deepEqual(patchOf(BASE, { ...BASE, project: "Tournaments" }), { patch: { project: "Tournaments" } });
});

test("a form that cannot be saved says why", () => {
  assert.deepEqual(patchOf(BASE, { ...BASE, text: "   " }), { problem: "a todo needs some words" });
  assert.deepEqual(patchOf(BASE, { ...BASE, due: "" }), { problem: "pick a due date" });
  assert.deepEqual(patchOf(BASE, { ...BASE, when: "event" }), { problem: "pick a day and time" });
});
