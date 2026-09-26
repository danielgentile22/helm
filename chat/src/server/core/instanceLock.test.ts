import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "./instanceLock";

test("instance lock: reclaims a stale pid, refuses a live one, releases", async () => {
  const home = await mkdtemp(join(tmpdir(), "helm2-lock-"));
  await writeFile(join(home, "helm.lock"), "999999999");
  const lock = await acquireInstanceLock(home);
  assert.equal(await readFile(join(home, "helm.lock"), "utf8"), String(process.pid));
  assert.equal(await acquireInstanceLock(home), lock, "idempotent in-process");
  await lock.release();

  // Simulate another live process holding it: our own pid is alive, so pretend a different live pid via the parent.
  await writeFile(join(home, "helm.lock"), String(process.ppid));
  await assert.rejects(acquireInstanceLock(home), /already running as pid/);
  await rm(home, { recursive: true });
});
