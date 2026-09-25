import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileId, ModelId, OfferedFile, ThreadId } from "../../shared/protocol";
import { LogRegistry } from "./log";
import { LogIndex } from "./log-index";

const threadId = "0f0f0f0f-0000-4000-8000-000000000001" as ThreadId;
const origin = { via: "key", label: "model" } as const;

function file(id: string): OfferedFile {
  return { fileId: id as FileId, path: `/tmp/${id}`, name: id, mime: "text/plain", bytes: 1, note: null };
}

async function harness() {
  const logs = new LogRegistry(await mkdtemp(join(tmpdir(), "helm2-index-")));
  const log = await logs.get(threadId);
  await log.append({ kind: "thread.created", config: { threadId, cwd: "/tmp", model: "claude-opus-5" as ModelId, effort: "high", permissionMode: "bypass", title: null, createdAt: "2026-09-13T00:00:00.000Z", archivedAt: null } });
  const index = new LogIndex(logs, (ev) => (ev.kind === "file.offered" ? [ev.file.fileId, ev.file] : null));
  return { logs, log, index };
}

test("a cold miss on an empty thread is null, and a hit is what was remembered", async () => {
  const { index } = await harness();
  assert.equal(await index.lookup(threadId, "nope" as FileId), null);
  index.remember(threadId, file("a").fileId, file("a"));
  assert.deepEqual(await index.lookup(threadId, "a" as FileId), file("a"));
});

test("a miss rebuilds the map from the log, so ids logged before this index existed resolve", async () => {
  const { logs, log } = await harness();
  await log.append({ kind: "file.offered", file: file("a"), origin });
  await log.append({ kind: "file.offered", file: file("b"), origin });
  const fresh = new LogIndex(logs, (ev) => (ev.kind === "file.offered" ? [ev.file.fileId, ev.file] : null));
  assert.deepEqual(await fresh.lookup(threadId, "b" as FileId), file("b"));
  assert.deepEqual(await fresh.lookup(threadId, "a" as FileId), file("a"), "one rescan filled every entry");
  assert.equal(await fresh.lookup(threadId, "c" as FileId), null, "an id the log never saw stays unknown");
});

test("purge forgets a thread; what was only remembered is gone, what was logged comes back on the next miss", async () => {
  const { log, index } = await harness();
  await log.append({ kind: "file.offered", file: file("logged"), origin });
  index.remember(threadId, file("memory").fileId, file("memory"));
  assert.deepEqual(await index.lookup(threadId, "memory" as FileId), file("memory"));
  index.purge(threadId);
  assert.equal(await index.lookup(threadId, "memory" as FileId), null);
  assert.deepEqual(await index.lookup(threadId, "logged" as FileId), file("logged"));
});

test("lookupAll rescans once for a batch, however many keys miss, and keeps order with nulls for the unknown", async () => {
  const { logs, log } = await harness();
  await log.append({ kind: "file.offered", file: file("a"), origin });
  let reads = 0;
  const counting = { get: (id: ThreadId) => logs.get(id).then((l) => ({ read: (after: 0) => (reads++, l.read(after)) })) };
  const index = new LogIndex(counting as unknown as LogRegistry, (ev) => (ev.kind === "file.offered" ? [ev.file.fileId, ev.file] : null));
  const got = await index.lookupAll(threadId, ["x", "a", "y"] as FileId[]);
  assert.deepEqual(got, [null, file("a"), null]);
  assert.equal(reads, 1);
});
