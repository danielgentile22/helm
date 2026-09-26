import assert from "node:assert/strict";
import test from "node:test";

import { freshness, glyphFor, glyphKind, health } from "./derive";
import { phase } from "./phase";
import { ms, thingId, todoId } from "./types";
import type { Department, Ms, Source, Thing } from "./types";

const NOW = ms(Date.parse("2026-09-17T12:00:00-04:00"));
const CADENCE_MS = 30 * 60_000;

function source(over: Partial<Source> = {}): Source {
  return { name: "todos", file: "agenda", produced: ms(NOW - 60_000), attempted: NOW,
           ok: true, reason: null, count: 3, cadenceMs: CADENCE_MS, ...over };
}

test("a failing source reads as failed, however recent its rows are", () => {
  const rowsFrom = ms(NOW - 60_000);
  assert.deepEqual(freshness(source({ ok: false, reason: "auth: the token expired" }), NOW),
                   { state: "failed", reason: "auth: the token expired", rowsFrom });
});

test("a failing source with no reason recorded still says so in words", () => {
  const out = freshness(source({ ok: false, reason: null }), NOW);
  assert.equal(out.state === "failed" && out.reason, "no reason recorded");
});

test("a source that has never produced is never, not stale", () => {
  assert.deepEqual(freshness(source({ produced: null }), NOW), { state: "never" });
});

test("rows older than twice the cadence are stale, and fresh right up to it", () => {
  const limit = 2 * CADENCE_MS;
  assert.deepEqual(freshness(source({ produced: ms(NOW - limit) }), NOW), { state: "fresh" });
  assert.deepEqual(freshness(source({ produced: ms(NOW - limit - 1) }), NOW),
                   { state: "stale", ageMs: limit + 1 });
});

test("a zero cadence means no limit, as it does in check_freshness.py", () => {
  assert.deepEqual(freshness(source({ cadenceMs: 0, produced: ms(NOW - 400 * 86_400_000) }), NOW),
                   { state: "fresh" });
});

test("every source fresh reads as ok", () => {
  assert.deepEqual(health(["fresh", "fresh", "fresh"]), { ok: true, label: "sources ok" });
});

test("one failed source among fresh ones names the count in the singular", () => {
  assert.deepEqual(health(["fresh", "failed", "fresh"]), { ok: false, label: "1 source failing" });
});

test("two stale sources are counted together", () => {
  assert.deepEqual(health(["stale", "fresh", "stale"]), { ok: false, label: "2 sources stale" });
});

test("failed beats never beats stale, and only the winning state is counted", () => {
  assert.deepEqual(health(["stale", "never", "failed", "stale"]),
                   { ok: false, label: "1 source failing" });
  assert.deepEqual(health(["stale", "never", "stale", "never"]),
                   { ok: false, label: "2 sources never produced" });
});

test("a lone never-produced source says so", () => {
  assert.deepEqual(health(["never"]), { ok: false, label: "1 source never produced" });
});

test("no sources at all reads as ok", () => {
  assert.deepEqual(health([]), { ok: true, label: "sources ok" });
});

const DAY_MS = 86_400_000;

function aTodo(label: string, at: Ms | null, since: Ms, dept: Department = "Work"): Thing {
  return { kind: "todo", id: thingId(`todo:${label}`), todoId: todoId("0123456789ab"),
           dept, project: null, label, at, due: null, since, doneToday: false, notes: "", subs: [],
           path: "Work/Work.md", line: 1, doneWhen: null };
}

function aJob(label: string, at: Ms, dept: Department = "Work"): Thing {
  return { kind: "job", id: thingId(`routine:${label}`), dept, label, at,
           schedule: "daily", path: "runner/routines/x.sh" };
}

function glyphOf(thing: Thing): string {
  return glyphFor(thing, phase(thing, NOW));
}

function aBox(kind: "daily" | "event", doneToday: boolean, at: Ms | null): Thing {
  const base = aTodo(kind, at, ms(NOW - DAY_MS));
  if (base.kind === "job") throw new Error("aTodo makes a todo");
  return { ...base, kind, doneToday };
}

test("a daily is a circle, filled once done today, and an event is a bar", () => {
  assert.equal(glyphOf(aBox("daily", false, null)), "○");
  assert.equal(glyphOf(aBox("daily", true, null)), "●");
  assert.equal(glyphOf(aBox("event", false, ms(NOW + DAY_MS))), "▮");
  assert.equal(glyphOf(aBox("event", false, ms(NOW - DAY_MS))), "▮", "an event is never late");
});

test("late wears a triangle, undated a hollow diamond, dated a filled one, a job a square", () => {
  assert.equal(glyphOf(aTodo("late", ms(NOW - DAY_MS), ms(NOW - 2 * DAY_MS))), "▲");
  assert.equal(glyphOf(aTodo("undated", null, ms(NOW - DAY_MS))), "◇");
  assert.equal(glyphOf(aTodo("dated", ms(NOW + DAY_MS), ms(NOW - DAY_MS))), "◆");
  assert.equal(glyphOf(aJob("soon", ms(NOW + DAY_MS))), "■");
});

test("a job keeps its square once it has run, because a job is never late", () => {
  assert.equal(glyphOf(aJob("ran", ms(NOW - DAY_MS))), "■");
});


test("every glyph has a word for its title and a screen reader", () => {
  const kindOf = (thing: Thing): string => glyphKind(thing, phase(thing, NOW));
  assert.equal(kindOf(aTodo("late", ms(NOW - DAY_MS), ms(NOW - 2 * DAY_MS))), "late");
  assert.equal(kindOf(aTodo("dated", ms(NOW + DAY_MS), ms(NOW - DAY_MS))), "dated");
  assert.equal(kindOf(aTodo("undated", null, ms(NOW - DAY_MS))), "undated");
  assert.equal(kindOf(aBox("daily", true, null)), "daily");
  assert.equal(kindOf(aBox("event", false, ms(NOW + DAY_MS))), "event");
  assert.equal(kindOf(aJob("soon", ms(NOW + DAY_MS))), "routine");
});
