import assert from "node:assert/strict";
import test from "node:test";

import { RANK_WEIGHT, daysUntil, deptView, first, pressure, tally } from "./pressure";
import { ms, thingId, todoId } from "./types";
import type { Model, Ms, Thing, TodoKind } from "./types";

const TZ = "America/New_York";
const NOW = ms(Date.parse("2026-09-22T17:31:00-04:00"));
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const at = (offsetMs: number): Ms => ms(NOW + offsetMs);

function box(kind: TodoKind, label: string, when: Ms | null, over: Partial<Extract<Thing, { kind: TodoKind }>> = {}): Thing {
  return { kind, id: thingId(`todo:${label}`), todoId: todoId("0123456789ab"), dept: "Work", project: null,
           label, at: when, due: null, since: at(-DAY_MS), doneToday: false, notes: "", subs: [],
           path: "Vault/Atlas/Work/Work.md", line: 1, doneWhen: null, ...over };
}

function aModel(things: Thing[]): Model {
  return { tz: TZ, produced: { agenda: NOW, projects: NOW }, things, directives: [], repos: [], sources: [], dropped: 0 };
}

test("days are counted on the local calendar, not in 24 hour spans", () => {
  assert.equal(daysUntil(at(7 * HOUR_MS), NOW, TZ), 1, "12:31am tomorrow is tomorrow");
  assert.equal(daysUntil(at(-18 * HOUR_MS), NOW, TZ), -1);
  assert.equal(daysUntil(NOW, NOW, TZ), 0);
});

test("late pulls hardest and climbs with age, and the reason says how late", () => {
  const five = pressure(box("todo", "a", at(-5 * DAY_MS)), NOW, TZ);
  const one = pressure(box("todo", "b", at(-DAY_MS)), NOW, TZ);
  assert.ok(five.value > one.value && one.value > 3);
  assert.deepEqual(five, { value: 4.25, reason: "5d late", late: true, soon: false });
});

test("due today beats tomorrow beats this week beats later beats undated", () => {
  const values = [HOUR_MS, DAY_MS, 3 * DAY_MS, 6 * DAY_MS, 20 * DAY_MS].map((d) => pressure(box("todo", "x", at(d)), NOW, TZ).value);
  assert.deepEqual(values, [2.6, 2.0, 1.4, 0.9, 0.4]);
  assert.deepEqual(pressure(box("todo", "u", null), NOW, TZ), { value: 0.35, reason: "no date", late: false, soon: false });
});

test("a daily is a small constant until it is done, then nothing", () => {
  assert.deepEqual(pressure(box("daily", "d", null), NOW, TZ), { value: 0.7, reason: "daily, not yet", late: false, soon: false });
  assert.deepEqual(pressure(box("daily", "d", null, { doneToday: true }), NOW, TZ), { value: 0, reason: "done today", late: false, soon: false });
});

test("an event is hard within three hours, carries its time, and is gone once it happened", () => {
  assert.deepEqual(pressure(box("event", "e", at(2 * HOUR_MS)), NOW, TZ), { value: 2.8, reason: "at 7:31 PM", late: false, soon: true });
  assert.equal(pressure(box("event", "e", at(DAY_MS)), NOW, TZ).reason, "tomorrow 5:31 PM");
  assert.equal(pressure(box("event", "e", at(-2 * HOUR_MS)), NOW, TZ).value, 0);
  assert.equal(pressure(box("event", "e", at(-DAY_MS)), NOW, TZ).late, false, "an event is never late");
});

test("a department view groups by directive, largest first, and sums in words", () => {
  const view = deptView(aModel([
    box("todo", "late one", at(-2 * DAY_MS), { project: "Launch" }),
    box("todo", "soon", at(DAY_MS), { project: "Launch" }),
    box("todo", "quiet", at(20 * DAY_MS), { project: "Day job" }),
    box("todo", "loose", null),
  ]), "Work", NOW);
  assert.deepEqual(view.directives.map((d) => d.name), ["Launch", "Day job", null]);
  assert.equal(view.directives[0]?.lead?.thing.label, "late one");
  assert.equal(view.summary, "1 late, 1 due soon");
  assert.equal(view.late, 1);
});

test("routines are background and never reach the map", () => {
  const job: Thing = { kind: "job", id: thingId("routine:capture"), dept: "Work", label: "capture",
                       at: at(HOUR_MS), schedule: "every 30m", path: "runner/routines/capture.sh" };
  const view = deptView(aModel([job, box("todo", "loose", null)]), "Work", NOW);
  assert.deepEqual(view.directives.map((d) => d.name), [null]);
  assert.equal(view.open, 1);
});

test("an empty department says nothing is pulling, and a done daily does not count as open", () => {
  assert.equal(deptView(aModel([]), "Chess", NOW).summary, "nothing pulling");
  const view = deptView(aModel([box("daily", "d", null, { doneToday: true })]), "Work", NOW);
  assert.equal(view.summary, "nothing pulling");
  assert.equal(view.open, 0);
});

test("first is the strongest pull on the whole board, ties broken by name", () => {
  const model = aModel([
    box("todo", "b late", at(-DAY_MS), { project: "x" }),
    box("todo", "a late", at(-DAY_MS)),
    box("event", "soon", at(HOUR_MS)),
  ]);
  const lead = first([deptView(model, "Work", NOW)]);
  assert.equal(lead?.thing.label, "a late");
  assert.equal(first([deptView(aModel([]), "Work", NOW)]), null);
});

test("the tally counts late things and what lands today, never a daily or a past event", () => {
  const model = aModel([
    box("todo", "late", at(-DAY_MS)),
    box("todo", "tonight", at(3 * HOUR_MS), { dept: "Chess" }),
    box("event", "call", at(HOUR_MS), { dept: "Life" }),
    box("event", "over", at(-3 * HOUR_MS)),
    box("event", "after midnight", at(7 * HOUR_MS)),
    box("todo", "tomorrow", at(DAY_MS)),
    box("todo", "undated", null),
    box("daily", "stretch", null),
  ]);
  const views = (["Work", "Chess", "Life"] as const).map((dept) => deptView(model, dept, NOW));
  assert.deepEqual(tally(views, NOW, TZ), { late: 1, today: 2 });
  assert.deepEqual(tally([deptView(aModel([]), "Work", NOW)], NOW, TZ), { late: 0, today: 0 });
});

test("a starred directive multiplies its todos' pull by its rank, and never its date words", () => {
  const due = at(3 * DAY_MS);
  const plain = pressure(box("todo", "p", due), NOW, TZ);
  const ranks = ([1, 2, 3] as const).map((star) => pressure(box("todo", "s", due, { star }), NOW, TZ));
  assert.deepEqual(ranks.map((p) => p.value), [1.4 * RANK_WEIGHT[1], 1.4 * RANK_WEIGHT[2], 1.4 * RANK_WEIGHT[3]].map((v) => Math.round(v * 100) / 100));
  assert.ok(ranks.every((p) => p.reason === plain.reason && p.soon), "still due soon, still the same words");
  // A starred far-off todo is weighted up but is not due soon: the warm hue is for dates only.
  const far = pressure(box("todo", "f", at(6 * DAY_MS), { star: 1 }), NOW, TZ);
  assert.ok(far.value > 1.4 && !far.soon);
});

test("a late side-project chore cannot outrank the launch when the launch is as urgent", () => {
  const chore = pressure(box("todo", "chore", at(-30 * DAY_MS)), NOW, TZ);
  const jobLate = pressure(box("todo", "job", at(-HOUR_MS * 20), { star: 1 }), NOW, TZ);
  assert.ok(jobLate.value > chore.value, "any late launch todo beats the latest possible chore");
  const fresh = pressure(box("todo", "fresh chore", at(-HOUR_MS)), NOW, TZ);
  const jobToday = pressure(box("todo", "job today", at(3 * HOUR_MS), { star: 1 }), NOW, TZ);
  assert.ok(jobToday.value > fresh.value, "due today on the launch beats a chore that just went late");
  const view = deptView(aModel([
    box("todo", "chore", at(-HOUR_MS), { project: "Compiler" }),
    box("todo", "apply", at(3 * HOUR_MS), { project: "Launch", star: 1 }),
  ]), "Work", NOW);
  assert.deepEqual(view.directives.map((d) => [d.name, d.star]), [["Launch", 1], ["Compiler", null]]);
});

test("a starred directive with nothing under it gets a place after every real one, and pulls nothing", () => {
  const model: Model = {
    ...aModel([box("todo", "far off", at(20 * DAY_MS), { project: "Day job", star: 2 })]),
    directives: [
      { dept: "Work", name: "Day job", star: 2 },
      { dept: "Work", name: "Launch", star: 1 },
      { dept: "Chess", name: "Coaching", star: 3 },
    ],
  };
  const view = deptView(model, "Work", NOW);
  assert.deepEqual(view.directives.map((d) => [d.name, d.things.length, d.star]), [["Day job", 1, 2], ["Launch", 0, 1]]);
  assert.equal(view.value, view.directives[0]?.value);
  assert.equal(view.open, 1);
});
