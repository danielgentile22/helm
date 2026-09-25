import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLanding, parseRoute } from "./route";

test("thread paths carry the id", () => {
  assert.deepEqual(parseRoute("/t/abc12345", ""), { name: "thread", threadId: "abc12345" });
  assert.deepEqual(parseRoute("/t/8f14e45f-ea0f-4b76-9c3f-1b2d3e4f5a6b", ""), { name: "thread", threadId: "8f14e45f-ea0f-4b76-9c3f-1b2d3e4f5a6b" });
});

test("a too-short or non-hex thread id is not a thread", () => {
  assert.deepEqual(parseRoute("/t/abc", ""), { name: "list" });
  assert.deepEqual(parseRoute("/t/zzzzzzzz", ""), { name: "list" });
});

test("enroll takes its token from the query string", () => {
  assert.deepEqual(parseRoute("/enroll", "?token=xyz"), { name: "enroll", token: "xyz" });
  assert.deepEqual(parseRoute("/enroll", ""), { name: "enroll", token: "" });
});

test("login and everything else", () => {
  assert.deepEqual(parseRoute("/login", ""), { name: "login" });
  assert.deepEqual(parseRoute("/settings", ""), { name: "settings" });
  assert.deepEqual(parseRoute("/", ""), { name: "list" });
  assert.deepEqual(parseRoute("/anything", ""), { name: "list" });
});

test("a thread fragment lands at the end or at a turn's seq", () => {
  assert.deepEqual(parseLanding("#end"), { at: "end" });
  assert.deepEqual(parseLanding("#seq=42"), { at: "seq", seq: 42 });
  assert.equal(parseLanding("#seq=0"), null);
  assert.equal(parseLanding("#seq=abc"), null);
  assert.equal(parseLanding(""), null);
  assert.equal(parseLanding("#other"), null);
});
