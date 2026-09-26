import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelmSettings, ModelId } from "../../shared/protocol";
import { SettingsStore, settingsFrom } from "./settings";

const defaults: HelmSettings = { theme: "system", defaultModel: null, defaultEffort: "medium", defaultCwd: "/home/work", defaultPermissionMode: "ask" };

test("settingsFrom keeps what it recognises and falls back on everything else", () => {
  assert.deepEqual(settingsFrom({ theme: "dark", defaultEffort: "high" }, defaults), { ...defaults, theme: "dark", defaultEffort: "high" });
  assert.deepEqual(settingsFrom({}, defaults), defaults);
  assert.deepEqual(settingsFrom(null, defaults), defaults);
  assert.deepEqual(settingsFrom("not an object", defaults), defaults);

  assert.deepEqual(settingsFrom({ theme: "neon", defaultEffort: "ultra", defaultCwd: "relative", defaultPermissionMode: "yolo" }, defaults), defaults, "ill-typed values fall back rather than poison the record");
  assert.equal(settingsFrom({ defaultPermissionMode: "bypass" }, defaults).defaultPermissionMode, "bypass");
  assert.equal(settingsFrom({ defaultModel: "claude-opus-5" }, defaults).defaultModel, "claude-opus-5" as ModelId);
  assert.equal(settingsFrom({ defaultModel: null }, { ...defaults, defaultModel: "x" as ModelId }).defaultModel, null, "an explicit null clears it");
});

test("a file written by a newer version still reads: unknown keys are dropped, not rejected", async () => {
  const home = await mkdtemp(join(tmpdir(), "helm2-settings-"));
  try {
    const file = join(home, "settings.json");
    await writeFile(file, JSON.stringify({ theme: "light", fontScale: 1.4, experiments: { newList: true } }));
    const store = new SettingsStore(file, { defaultCwd: "/home/work" });
    assert.deepEqual(await store.get(), { ...defaults, theme: "light" });

    const next = await store.patch({ defaultEffort: "xhigh" });
    assert.deepEqual(next, { ...defaults, theme: "light", defaultEffort: "xhigh" });
    assert.equal("fontScale" in JSON.parse(await readFile(file, "utf8")), false, "a patch rewrites the record this version knows");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a saved defaultCwd that no longer exists falls back to the default", async () => {
  const home = await mkdtemp(join(tmpdir(), "helm2-settings-"));
  try {
    const file = join(home, "settings.json");
    await writeFile(file, JSON.stringify({ defaultCwd: join(home, "moved-away") }));
    const store = new SettingsStore(file, { defaultCwd: home });
    assert.equal((await store.get()).defaultCwd, home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("concurrent patches all land: the store serializes read-modify-write", async () => {
  const home = await mkdtemp(join(tmpdir(), "helm2-settings-"));
  try {
    const store = new SettingsStore(join(home, "settings.json"), { defaultCwd: "/home/work" });
    await Promise.all([store.patch({ theme: "dark" }), store.patch({ defaultEffort: "low" }), store.patch({ defaultCwd: home })]);
    assert.deepEqual(await store.get(), { theme: "dark", defaultModel: null, defaultEffort: "low", defaultCwd: home, defaultPermissionMode: "ask" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
