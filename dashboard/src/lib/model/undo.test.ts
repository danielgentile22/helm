import assert from "node:assert/strict";
import test from "node:test";

import { UNDO_MS, banner, settle } from "./undo";
import { todoId } from "./types";
import type { Tick } from "./undo";

const tick = (label: string, at: number): Tick => ({ todo: todoId("0123456789ab"), label, at });

test("a tick is written once its window has run out, and not a moment before", () => {
  const a = tick("a", 0);
  const b = tick("b", 2000);
  assert.deepEqual(settle([a, b], UNDO_MS - 1), { due: [], waiting: [a, b] });
  assert.deepEqual(settle([a, b], UNDO_MS), { due: [a], waiting: [b] });
  assert.deepEqual(settle([a, b], UNDO_MS + 2000), { due: [a, b], waiting: [] });
});

test("the header shows the newest tick, its seconds rounded up, and how many wait behind it", () => {
  assert.equal(banner([], 0), null);
  assert.deepEqual(banner([tick("a", 0)], 0), { label: "a", seconds: 5, more: 0 });
  assert.deepEqual(banner([tick("a", 0)], 4001), { label: "a", seconds: 1, more: 0 });
  assert.deepEqual(banner([tick("a", 0), tick("b", 3000)], 3500), { label: "b", seconds: 5, more: 1 });
});

test("the countdown never reads zero while the tick can still be undone", () => {
  assert.equal(banner([tick("a", 0)], UNDO_MS - 1)?.seconds, 1);
});
