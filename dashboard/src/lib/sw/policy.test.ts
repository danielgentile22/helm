import assert from "node:assert/strict";
import { test } from "node:test";
import { STRATEGIES, cacheKeyFor, strategyFor } from "./policy";
import type { Strategy } from "./policy";

const TABLE: [string, string, Strategy][] = [
  ["GET", "/assets/index-Ba9mK2xQ.js", "cache-first"],
  ["GET", "/assets/index-Ba9mK2xQ.css", "cache-first"],
  ["GET", "/assets/approach-77f1c0de.js", "cache-first"],
  ["GET", "/", "network-first"],
  ["GET", "/index.html", "network-first"],
  ["GET", "/projects/helm", "network-first"],
  ["GET", "/api/agenda", "network-first"],
  ["GET", "/api/projects", "network-first"],
  ["GET", "/api/health", "network-only"],
  ["GET", "/auth/me", "network-only"],
  ["POST", "/auth/login/options", "network-only"],
  ["PUT", "/api/todos/0123456789ab/done", "network-only"],
  ["GET", "/icon.svg", "network-only"],
  ["GET", "/manifest.webmanifest", "network-only"],
  ["GET", "/sw.js", "network-only"],
];

for (const [method, path, want] of TABLE) {
  test(`${method} ${path} is ${want}`, () => {
    assert.equal(strategyFor(method, path), want);
  });
}

test("the door is never the shell, so a verdict is never filed under /", () => {
  assert.equal(cacheKeyFor("/auth/me"), "/auth/me");
});

test("a hashed asset is served from cache, because the hash is in the name", () => {
  assert.equal(strategyFor("GET", "/assets/index-Ba9mK2xQ.js"), "cache-first");
});

test("the shell is network first, so a stale copy never wins while the server answers", () => {
  assert.equal(strategyFor("GET", "/"), "network-first");
});

test("a snapshot read falls back to the last good one, and the todo write never does", () => {
  assert.equal(strategyFor("GET", "/api/agenda"), "network-first");
  assert.equal(strategyFor("PUT", "/api/todos/0123456789ab/done"), "network-only");
});

test("an unknown path passes through untouched", () => {
  assert.equal(strategyFor("GET", "/whatever.txt"), "network-only");
  assert.equal(strategyFor("POST", "/whatever"), "network-only");
});

test("no write ever survives the request that made it", () => {
  // The decision, checked rather than trusted: there is no strategy here that could hold a
  // failed write for later. Adding one would have to add it to this set first.
  assert.deepEqual([...STRATEGIES], ["cache-first", "network-first", "network-only"]);
  for (const strategy of STRATEGIES) {
    assert.doesNotMatch(strategy, /queue|defer|retry|sync/);
  }
  const methods = ["PUT", "POST", "PATCH", "DELETE"];
  for (const method of methods) {
    assert.equal(strategyFor(method, "/api/todos/0123456789ab/done"), "network-only");
    assert.equal(strategyFor(method, "/api/agenda"), "network-only");
  }
});

test("every client route shares the shell's cache entry", () => {
  assert.equal(cacheKeyFor("/"), "/");
  assert.equal(cacheKeyFor("/projects/helm"), "/");
  assert.equal(cacheKeyFor("/index.html"), "/");
  assert.equal(cacheKeyFor("/api/agenda"), "/api/agenda");
  assert.equal(cacheKeyFor("/assets/index-Ba9mK2xQ.js"), "/assets/index-Ba9mK2xQ.js");
});
