import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, parseDotenv } from "./env";

const base = { HELM_BIND_ADDR: "100.64.0.1", HELM_VAPID_PUBLIC: "pub", HELM_VAPID_PRIVATE: "priv", HELM_VAPID_SUBJECT: "mailto:x@y", HELM_HOSTNAME: "mac.ts.net" };

test("parseDotenv handles comments, quotes, and export prefixes", () => {
  assert.deepEqual(parseDotenv('# c\nA=1\nexport B="two words"\nC=\'x=y\'\n\nbad\n'), { A: "1", B: "two words", C: "x=y" });
});

test("loadEnv fills defaults, expands ~, and names the missing key", () => {
  const env = loadEnv({ ...base, HELM_HOME: "~/.helm2" });
  assert.ok(env.HELM_HOME.startsWith("/") && env.HELM_HOME.endsWith("/.helm2"));
  assert.equal(env.HELM_PORT, 8420);
  assert.equal(env.HELM_SESSION_HOURS, 12);
  assert.equal(env.HELM_API_KEY, undefined, "unset key stays undefined so auth fails closed");
  assert.equal(env.HELM_ADD_DIRS.length, 3);
  assert.throws(() => loadEnv({ ...base, HELM_HOSTNAME: "" }), /HELM_HOSTNAME/);
  assert.throws(() => loadEnv({ ...base, HELM_PORT: "abc" }), /HELM_PORT/);
});
