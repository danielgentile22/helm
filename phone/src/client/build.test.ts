import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before } from "node:test";
import assert from "node:assert/strict";

let out = "";
before(() => {
  out = mkdtempSync(join(tmpdir(), "helm2-client-"));
  execFileSync("node", ["scripts/build-client.mjs"], { env: { ...process.env, HELM_CLIENT_OUT: out }, stdio: "pipe" });
});

test("service worker bundle is a classic script (no import/export)", () => {
  const sw = readFileSync(join(out, "sw.js"), "utf8");
  assert.doesNotMatch(sw, /^\s*(export|import)\b/m);
});

test("app bundle is self-contained (Svelte compiled in, nothing left to resolve)", () => {
  const app = readFileSync(join(out, "app.js"), "utf8");
  assert.ok(app.length > 0);
  assert.doesNotMatch(app, /^\s*import\s.*from\s+["']svelte/m);
});
