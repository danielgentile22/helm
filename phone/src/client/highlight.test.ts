import { test } from "node:test";
import assert from "node:assert/strict";
import { segments } from "./highlight";

test("no ranges leaves the text whole", () => {
  assert.deepEqual(segments("deploy the worker", []), [{ text: "deploy the worker", hit: false }]);
});

test("empty text yields nothing at all", () => {
  assert.deepEqual(segments("", []), []);
  assert.deepEqual(segments("", [[0, 4]]), []);
});

test("a range in the middle splits into three segments", () => {
  assert.deepEqual(segments("deploy the worker", [[7, 10]]), [
    { text: "deploy ", hit: false },
    { text: "the", hit: true },
    { text: " worker", hit: false },
  ]);
});

test("adjacent ranges stay two hits, since touching is not overlapping", () => {
  assert.deepEqual(segments("abcdef", [[1, 3], [3, 5]]), [
    { text: "a", hit: false },
    { text: "bc", hit: true },
    { text: "de", hit: true },
    { text: "f", hit: false },
  ]);
});

test("overlapping ranges merge into one hit", () => {
  assert.deepEqual(segments("abcdef", [[3, 5], [1, 4]]), [
    { text: "a", hit: false },
    { text: "bcde", hit: true },
    { text: "f", hit: false },
  ]);
});

test("a range nested inside another does not shorten the hit", () => {
  assert.deepEqual(segments("abcdef", [[1, 5], [2, 3]]), [
    { text: "a", hit: false },
    { text: "bcde", hit: true },
    { text: "f", hit: false },
  ]);
});

test("a range at the very end leaves no trailing segment", () => {
  assert.deepEqual(segments("worker", [[2, 6]]), [
    { text: "wo", hit: false },
    { text: "rker", hit: true },
  ]);
});

test("a range covering the whole string is a single hit", () => {
  assert.deepEqual(segments("worker", [[0, 6]]), [{ text: "worker", hit: true }]);
});
