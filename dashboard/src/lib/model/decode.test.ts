import assert from "node:assert/strict";
import test from "node:test";

import { decode } from "./decode";

function agendaWith(dept: string): unknown {
  return {
    produced: "2026-09-17T09:00:00-04:00",
    tz: "America/New_York",
    items: [{ kind: "todo", id: "0123456789ab", text: "enter the October open", dept,
              since: "2026-09-01T09:00:00-04:00", line: 12, path: "Vault/Atlas/Chess/Chess.md" }],
    sources: {},
  };
}

test("a row on one of the four departments decodes", () => {
  const model = decode(agendaWith("Chess"), null);
  assert.equal(model.dropped, 0);
  assert.equal(model.things.length, 1);
  assert.equal(model.things[0]?.dept, "Chess");
});

test("a department outside the four is dropped and counted, not filed under Projects", () => {
  const model = decode(agendaWith("Finance"), null);
  assert.deepEqual(model.things, []);
  assert.equal(model.dropped, 1);
});

test("either document may be missing", () => {
  const model = decode(null, null);
  assert.deepEqual(model.produced, { agenda: null, projects: null });
  assert.equal(model.tz, "UTC");
  assert.equal(model.dropped, 0);
});

test("a star of 1, 2 or 3 is kept, and anything else reads as unstarred without dropping the row", () => {
  const withStar = (star: unknown): unknown => {
    const doc = agendaWith("Work") as { items: Record<string, unknown>[] };
    return { ...doc, items: doc.items.map((row) => ({ ...row, star })) };
  };
  const star = (value: unknown): unknown => {
    const thing = decode(withStar(value), null).things[0];
    return thing !== undefined && thing.kind !== "job" ? thing.star : "missing";
  };
  assert.equal(star(1), 1);
  assert.equal(star(3), 3);
  assert.equal(star(4), undefined);
  assert.equal(star("1"), undefined);
  assert.equal(decode(withStar(9), null).dropped, 0);
});

test("starred directives decode, and anything malformed reads as none without a throw", () => {
  const withDirectives = (directives: unknown): unknown => ({ ...(agendaWith("Work") as object), directives });
  const names = (directives: unknown): string[] => decode(withDirectives(directives), null).directives.map((d) => d.name);
  assert.deepEqual(decode(withDirectives([{ dept: "Work", name: "Launch", star: 1 }]), null).directives,
    [{ dept: "Work", name: "Launch", star: 1 }]);
  assert.deepEqual(names(undefined), []);
  assert.deepEqual(names("Launch"), []);
  assert.deepEqual(names({ dept: "Work", name: "Launch", star: 1 }), []);
  assert.deepEqual(names([null, 7, { dept: "Finance", name: "Taxes", star: 1 }, { dept: "Work", name: "", star: 1 },
    { dept: "Work", name: "Day job", star: 4 }, { dept: "Work", name: "Launch", star: 1 }]), ["Launch"]);
  assert.equal(decode(withDirectives([null]), null).dropped, 0);
});
