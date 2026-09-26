import assert from "node:assert/strict";
import test from "node:test";

import { noteLine } from "./note";

test("the first sentence, with markdown marks stripped", () => {
  assert.equal(
    noteLine("Your SketchyBar is a **vertical column** on the right. Because of that, items stack."),
    "Your SketchyBar is a vertical column on the right.",
  );
});

test("a leading heading or blank line is skipped, links keep their text", () => {
  assert.equal(noteLine("\n## Recap\n"), "Recap");
  assert.equal(noteLine("See [the ADR](docs/adr/0012.md) first."), "See the ADR first.");
});

test("a long first sentence is cut with an ellipsis", () => {
  const long = "x".repeat(100) + ".";
  const out = noteLine(long);
  assert.equal(out.length, 70);
  assert.ok(out.endsWith("…"));
});

test("an empty note is an empty line", () => {
  assert.equal(noteLine("   \n\n"), "");
});
