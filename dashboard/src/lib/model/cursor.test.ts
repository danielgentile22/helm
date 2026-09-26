import assert from "node:assert/strict";
import test from "node:test";

import { resolve, rowOrder, step } from "./cursor";
import { deptView } from "./pressure";
import { ms, thingId, todoId } from "./types";
import type { Department, Model, Ms, Thing, ThingId } from "./types";

const TZ = "America/New_York";
const NOW = ms(Date.parse("2026-09-22T17:31:00-04:00"));
const DAY_MS = 86_400_000;
const at = (offsetMs: number): Ms => ms(NOW + offsetMs);

function box(label: string, dept: Department, project: string | null, when: Ms | null, doneToday = false): Thing {
  return { kind: doneToday ? "daily" : "todo", id: thingId(`todo:${label}`), todoId: todoId("0123456789ab"), dept,
           project, label, at: when, due: null, since: at(-DAY_MS), doneToday, notes: "", subs: [],
           path: "Vault/Atlas/Work/Work.md", line: 1, doneWhen: null };
}

// Listed out of order on purpose: the map's order comes from pressure and corners, never
// from the order the file happened to list things in.
const things: Thing[] = [
  box("life undated", "Life", null, null),
  box("lisbon later", "Life", "Lisbon", at(20 * DAY_MS)),
  box("lisbon late", "Life", "Lisbon", at(-2 * DAY_MS)),
  box("stretch", "Work", "Health", null, true),
  box("resume tomorrow", "Work", "Job search", at(DAY_MS)),
  box("resume undated", "Work", "Job search", null),
  box("tactics", "Chess", "Training", at(3 * DAY_MS)),
];
const model: Model = { tz: TZ, produced: { agenda: NOW, projects: NOW }, things, directives: [], repos: [], sources: [], dropped: 0 };
const views = (["Life", "Projects", "Chess", "Work"] as const).map((d) => deptView(model, d, NOW));
const ids = (...labels: string[]): ThingId[] => labels.map((l) => thingId(`todo:${l}`));

test("rows run in corner order, directives by pull, things strongest first and done last", () => {
  assert.deepEqual(rowOrder(views, null), ids(
    "resume tomorrow", "resume undated", "stretch",
    "tactics",
    "lisbon late", "lisbon later", "life undated",
  ));
});

test("a zoomed map walks only its own department", () => {
  assert.deepEqual(rowOrder(views, "Life"), ids("lisbon late", "lisbon later", "life undated"));
  assert.deepEqual(rowOrder(views, "Projects"), []);
});

test("the order is the one Directive draws: lead, then the rest, then the done ones", () => {
  // Directive.svelte renders lead (when roomy), then rest (pulling, minus the lead when it
  // was drawn large), then done. Rebuilt here from the same rules for both cell sizes.
  for (const view of views) {
    for (const d of view.directives) {
      for (const roomy of [true, false]) {
        const lead = roomy && d.lead !== null ? [d.lead] : [];
        const rest = d.things.filter((p) => p.pressure.value > 0 && !(roomy && p === d.lead));
        const done = d.things.filter((p) => p.pressure.value === 0);
        assert.deepEqual([...lead, ...rest, ...done], d.things, `${d.name ?? "unfiled"}, roomy ${roomy}`);
      }
    }
  }
});

test("the first press starts at the top, and the ends hold", () => {
  const order = ids("a", "b", "c");
  assert.deepEqual(step(order, null, 1), { id: order[0], at: 0 });
  assert.deepEqual(step(order, null, -1), { id: order[0], at: 0 });
  assert.deepEqual(step(order, order[1] ?? null, 1), { id: order[2], at: 2 });
  assert.deepEqual(step(order, order[2] ?? null, 1), { id: order[2], at: 2 });
  assert.deepEqual(step(order, order[0] ?? null, -1), { id: order[0], at: 0 });
  assert.equal(step([], null, 1), null);
});

test("a cursor whose row left the board lands on the row that took its place", () => {
  const order = ids("a", "c");
  const gone = thingId("todo:b");
  assert.equal(resolve(order, gone, 1), order[1]);
  assert.equal(resolve(order, gone, 5), order[1], "clamped to the last row");
  assert.equal(resolve([], gone, 0), null);
  assert.equal(resolve(order, null, 0), null, "no cursor stays no cursor");
  assert.equal(resolve(order, order[0] ?? null, 1), order[0], "a row still there keeps it");
});
