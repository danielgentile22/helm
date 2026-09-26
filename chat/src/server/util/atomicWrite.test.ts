import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomicWrite";

test("concurrent atomicWrites to one file all succeed, leave one of the payloads, and no temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helm2-aw-"));
  const file = join(dir, "state.json");
  const payloads = Array.from({ length: 20 }, (_, i) => `payload-${i}`);
  await Promise.all(payloads.map((p) => atomicWrite(file, p)));
  const final = await readFile(file, "utf8");
  assert.ok(payloads.includes(final));
  assert.deepEqual(await readdir(dir), ["state.json"]);
  await rm(dir, { recursive: true });
});
