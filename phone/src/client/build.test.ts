import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

test("service worker bundle is a classic script (no import/export)", () => {
  const out = mkdtempSync(join(tmpdir(), "helm2-client-"));
  execFileSync("node", ["scripts/build-client.mjs"], { env: { ...process.env, HELM_CLIENT_OUT: out }, stdio: "pipe" });
  const sw = readFileSync(join(out, "sw.js"), "utf8");
  assert.doesNotMatch(sw, /^\s*(export|import)\b/m);
});
