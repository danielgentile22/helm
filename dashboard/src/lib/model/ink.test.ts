import assert from "node:assert/strict";
import test from "node:test";

import { calm, columns, leadTier, linesOf, nextUp, railScale, segments, week } from "./ink";
import { deptView } from "./pressure";
import { ms, thingId, todoId } from "./types";
import type { Model, Ms, Thing, TodoKind } from "./types";
import type { Pressure } from "./pressure";

const TZ = "America/New_York";
const NOW = ms(Date.parse("2026-09-23T10:00:00-04:00"));
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const at = (offsetMs: number): Ms => ms(NOW + offsetMs);

function box(kind: TodoKind, label: string, when: Ms | null, over: Partial<Extract<Thing, { kind: TodoKind }>> = {}): Thing {
  return { kind, id: thingId(`todo:${label}`), todoId: todoId("0123456789ab"), dept: "Work", project: null,
           label, at: when, due: null, since: at(-DAY_MS), doneToday: false, notes: "", subs: [],
           path: "Vault/Atlas/Work/Work.md", line: 1, doneWhen: null, ...over };
}

function views(things: Thing[]) {
  const model: Model = { tz: TZ, produced: { agenda: NOW, projects: NOW }, things, directives: [], repos: [], sources: [], dropped: 0 };
  return (["Work", "Chess", "Projects", "Life"] as const).map((d) => deptView(model, d, NOW));
}

const p = (value: number): Pressure => ({ value, reason: "", late: false, soon: false });

test("a lead's tier steps down with its pull, and an undated thing never leads", () => {
  assert.deepEqual([4.2, 3, 2.6, 2, 1.4, 0.9, 0.7, 0.35].map((v) => leadTier(p(v))), [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(leadTier(null), 4);
});

test("a rail is one segment per loud thing, toned by what it is, then one calm tail, and the scale is shared", () => {
  const [work] = views([
    box("todo", "late", at(-2 * DAY_MS)),
    box("todo", "soon", at(DAY_MS)),
    box("event", "call", at(5 * DAY_MS)),
    box("todo", "later", null),
    box("todo", "whenever", null),
    box("daily", "stretch", null),
    box("daily", "done", null, { doneToday: true }),
  ]);
  const segs = segments(work?.directives.flatMap((d) => d.things) ?? []);
  assert.deepEqual(segs.map((s) => s.tone), ["late", "soon", "event", "calm"]);
  assert.equal(segs.at(-1)?.pull, 0.35 + 0.35 + 0.7, "the calm things pool into one tail, the done one adds nothing");
  assert.equal(railScale([1, 2]), 14, "a quiet board keeps the full scale");
  assert.equal(railScale([40, 2]), 170 / 40, "a loud one shrinks it so the loudest fits");
  assert.equal(railScale([]), 14);
});

test("the week puts late things first, dated things on their day, and counts dailies", () => {
  const w = week(views([
    box("todo", "late", at(-DAY_MS)),
    box("todo", "tonight", at(6 * HOUR_MS)),
    box("event", "fri call", at(2 * DAY_MS + HOUR_MS), { dept: "Chess" }),
    box("todo", "fri due", at(2 * DAY_MS), { dept: "Life" }),
    box("todo", "next month", at(30 * DAY_MS)),
    box("todo", "undated", null),
    box("daily", "stretch", null, { doneToday: true }),
    box("daily", "apply", null),
  ]), NOW, TZ);
  assert.deepEqual(w.late.map((x) => x.thing.label), ["late"]);
  assert.equal(w.days.length, 7);
  assert.deepEqual(w.days.map((d) => d.label.split(" ")[0]), ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
  assert.deepEqual(w.days[0]?.items.map((x) => x.thing.label), ["tonight"]);
  assert.deepEqual(w.days[2]?.items.map((x) => x.thing.label), ["fri due", "fri call"], "soonest first");
  assert.deepEqual(w.dailies, { done: 1, total: 2 });
  assert.equal(w.undated, 1);
  assert.equal(calm(w), false);
});

test("the best day is nothing late and nothing today, and it names what lands next", () => {
  const w = week(views([box("todo", "fri", at(2 * DAY_MS)), box("todo", "undated", null)]), NOW, TZ);
  assert.equal(calm(w), true);
  assert.equal(nextUp(w)?.item.thing.label, "fri");
  assert.equal(nextUp(week(views([]), NOW, TZ)), null);
});

test("an undated-only rail is one short neutral segment, not a dot per thing", () => {
  const [work] = views([box("todo", "a", null), box("todo", "b", null)]);
  assert.deepEqual(segments(work?.directives.flatMap((d) => d.things) ?? []), [{ pull: 0.7, tone: "calm" }]);
  assert.deepEqual(segments([]), []);
});

test("the band folds runs of empty days, keeps today and a lone empty day, and counts late things on the map", () => {
  const vs = views([
    box("todo", "old chore", at(-2 * DAY_MS), { dept: "Projects" }),
    box("todo", "older chore", at(-4 * DAY_MS), { dept: "Projects" }),
    box("todo", "hidden late", at(-DAY_MS), { dept: "Life" }),
    box("todo", "tomorrow", at(DAY_MS)),
    box("todo", "in three", at(3 * DAY_MS)),
  ]);
  const w = week(vs, NOW, TZ);
  const cols = columns(w, (id) => id !== thingId("todo:hidden late"));
  const shape = cols.map((c) => c.kind === "span" ? `${c.from} to ${c.to}` : c.kind === "late" ? "late" : c.label);
  assert.deepEqual(shape, ["late", "today", "Thu 24", "Fri 25", "Sat 26", "Sun 27 to Tue 29"]);
  const late = cols[0];
  assert.ok(late !== undefined && late.kind === "late");
  assert.equal(late.total, 3);
  assert.deepEqual(late.counts.map((c) => [c.dept, c.items.map((p) => p.thing.label)]), [["Projects", ["older chore", "old chore"]]]);
  assert.deepEqual(late.items.map((p) => p.thing.label), ["hidden late"]);
  assert.deepEqual(cols.map(linesOf), [2, 1, 1, 1, 1, 1]);
});
