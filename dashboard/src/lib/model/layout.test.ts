import assert from "node:assert/strict";
import test from "node:test";

import { fitRows } from "./layout";

test("rows that fit all show; rows that do not end in a line that counts the rest", () => {
  assert.deepEqual(fitRows(3, 100, 20), { shown: 3, more: 0, inline: false });
  assert.deepEqual(fitRows(5, 100, 20), { shown: 5, more: 0, inline: false }, "exactly full is not overflow");
  assert.deepEqual(fitRows(7, 100, 20), { shown: 4, more: 3, inline: false }, "four rows and the +3 line");
  assert.deepEqual(fitRows(0, 0, 20), { shown: 0, more: 0, inline: false });
});

test("with under two lines of room the count moves to the name line and the rows keep the room", () => {
  assert.deepEqual(fitRows(3, 30, 20), { shown: 1, more: 2, inline: true });
  assert.deepEqual(fitRows(2, 0, 20), { shown: 1, more: 1, inline: true }, "the top row beats the count");
  assert.deepEqual(fitRows(1, 4, 36, 0), { shown: 0, more: 1, inline: true }, "under a lead, no room is just the count");
});
