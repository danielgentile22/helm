import { test } from "node:test";
import assert from "node:assert/strict";
import { GUIDANCE_PREFIX, guidanceOf } from "./vault";

test("guidanceOf reads the guidance line back out of a prompt, and null when there is none", () => {
  assert.equal(guidanceOf(`Record this conversation.\n\n${GUIDANCE_PREFIX}focus on the backup decision`), "focus on the backup decision");
  assert.equal(guidanceOf("Record this conversation."), null);
});

test("guidanceOf reads only the last line, so the word Guidance inside the prompt is not mistaken for one", () => {
  assert.equal(guidanceOf(`${GUIDANCE_PREFIX}first\n\nmore prose about guidance`), null);
  assert.equal(guidanceOf(`${GUIDANCE_PREFIX}first\n${GUIDANCE_PREFIX}second`), "second");
});

test("guidanceOf ignores trailing blank lines and an empty guidance", () => {
  assert.equal(guidanceOf(`prompt\n\n${GUIDANCE_PREFIX}steer me\n\n`), "steer me");
  assert.equal(guidanceOf(`prompt\n\n${GUIDANCE_PREFIX}   `), null);
});
