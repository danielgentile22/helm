import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateThreadRequest, Effort, HelmSettings, ModelChoice, ModelId, ThreadConfig } from "../shared/protocol";
import type { HelmClient } from "./api";
import { createWithDefaults } from "./newThread";

const choice = (id: string, supportsEffort: boolean, efforts: readonly Effort[]): ModelChoice => ({ id: id as ModelId, label: id, supportsEffort, efforts });

const settings = (s: Partial<HelmSettings> = {}): HelmSettings => ({
  theme: "system",
  defaultModel: s.defaultModel ?? null,
  defaultEffort: s.defaultEffort ?? "medium",
  defaultCwd: s.defaultCwd ?? "/Users/d/default",
  defaultPermissionMode: s.defaultPermissionMode ?? "ask",
});

interface Recorder {
  api: HelmClient;
  seen: CreateThreadRequest[];
}

function recorder(): Recorder {
  const seen: CreateThreadRequest[] = [];
  const stub = {
    createThread(req: CreateThreadRequest): Promise<ThreadConfig> {
      seen.push(req);
      return Promise.resolve({ threadId: "t-1", cwd: req.cwd, model: req.model, effort: req.effort, title: null, createdAt: "2026-09-01T00:00:00.000Z", archivedAt: null } as ThreadConfig);
    },
  };
  return { api: stub as unknown as HelmClient, seen };
}

test("an explicit cwd beats the settings default", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings({ defaultCwd: "/Users/d/default" }), [choice("claude-opus-5", true, ["medium", "high"])], "/Users/d/other");
  assert.equal(r.seen[0]?.cwd, "/Users/d/other");
});

test("no cwd anywhere is refused rather than guessed", async () => {
  const r = recorder();
  await assert.rejects(() => createWithDefaults(r.api, null, [choice("claude-opus-5", true, ["medium"])]), /working directory/i);
  assert.equal(r.seen.length, 0);
});

test("with no default model the catalog's opus entry wins over the first entry", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings(), [choice("claude-sonnet-5", true, ["medium"]), choice("claude-opus-5", true, ["medium"])]);
  assert.equal(r.seen[0]?.model, "claude-opus-5");
});

test("with no opus in the catalog the first entry is used", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings(), [choice("claude-sonnet-5", true, ["medium"])]);
  assert.equal(r.seen[0]?.model, "claude-sonnet-5");
});

test("an effort the chosen model does not list falls back to the model's first", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings({ defaultEffort: "max" }), [choice("claude-opus-5", true, ["low", "high"])]);
  assert.equal(r.seen[0]?.effort, "low");
});

test("an effort the chosen model lists is kept", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings({ defaultEffort: "high" }), [choice("claude-opus-5", true, ["low", "high"])]);
  assert.equal(r.seen[0]?.effort, "high");
});

test("a model that does not support effort takes its own first level", async () => {
  const r = recorder();
  await createWithDefaults(r.api, settings({ defaultEffort: "high" }), [choice("claude-opus-5", false, ["low"])]);
  assert.equal(r.seen[0]?.effort, "low");
});

test("an empty catalog is refused with a readable error", async () => {
  const r = recorder();
  await assert.rejects(() => createWithDefaults(r.api, settings(), []), /catalog/i);
  assert.equal(r.seen.length, 0);
});
