import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadSummary, TurnOutcome } from "../shared/protocol";
import { groupThreads, rowState } from "./groups";

interface Fixture {
  cwd?: string;
  session?: ThreadSummary["session"];
  lastOutcome?: TurnOutcome | null;
  lastTurnEndedAt?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  waiting?: boolean;
}

const summary = (f: Fixture = {}): ThreadSummary => ({
  config: {
    threadId: "t-1" as never,
    cwd: f.cwd ?? "/a",
    model: "m" as never,
    effort: "high",
    title: null,
    createdAt: f.createdAt ?? "2026-09-01T00:00:00.000Z",
    permissionMode: "ask",
    archivedAt: f.archivedAt ?? null,
  },
  headSeq: 0,
  session: f.session ?? "idle",
  lastTurnEndedAt: f.lastTurnEndedAt ?? null,
  lastOutcome: f.lastOutcome ?? null,
  contextTokens: null,
  preview: null,
  doing: null,
  usageTotal: null,
  contextWindow: null,
  waiting: f.waiting ?? false,
});

test("rowState puts archived first, then a live session, then the outcome table", () => {
  assert.equal(rowState(summary({ archivedAt: "2026-09-02T00:00:00.000Z", session: "running", lastOutcome: "error" })), "archived");
  assert.equal(rowState(summary({ session: "running" })), "running");
  assert.equal(rowState(summary({ session: "warming" })), "running");
  assert.equal(rowState(summary({ lastOutcome: "ok" })), "done");
  assert.equal(rowState(summary({ lastOutcome: "error" })), "error");
  assert.equal(rowState(summary({ lastOutcome: "orphaned" })), "orphaned");
  assert.equal(rowState(summary({ lastOutcome: "interrupted" })), "idle");
  assert.equal(rowState(summary({ lastOutcome: null })), "idle");
});

test("groups are ordered by their last activity, newest first", () => {
  const groups = groupThreads(
    [
      summary({ cwd: "/old", lastTurnEndedAt: "2026-09-01T00:00:00.000Z" }),
      summary({ cwd: "/new", lastTurnEndedAt: "2026-09-10T00:00:00.000Z" }),
      summary({ cwd: "/mid", lastTurnEndedAt: "2026-09-05T00:00:00.000Z" }),
    ],
    false,
  );
  assert.deepEqual(
    groups.map((g) => [g.cwd, g.lastActivity]),
    [
      ["/new", "2026-09-10T00:00:00.000Z"],
      ["/mid", "2026-09-05T00:00:00.000Z"],
      ["/old", "2026-09-01T00:00:00.000Z"],
    ],
  );
});

test("a group falls back to createdAt when no turn has ended", () => {
  const groups = groupThreads([summary({ cwd: "/a", createdAt: "2026-09-07T00:00:00.000Z" })], false);
  assert.equal(groups[0]?.lastActivity, "2026-09-07T00:00:00.000Z");
});

test("running rows sort ahead of finished ones, and the rest by when descending", () => {
  const groups = groupThreads(
    [
      summary({ lastTurnEndedAt: "2026-09-09T00:00:00.000Z" }),
      summary({ session: "running", lastTurnEndedAt: "2026-09-02T00:00:00.000Z" }),
      summary({ lastTurnEndedAt: "2026-09-04T00:00:00.000Z" }),
      summary({ session: "warming", lastTurnEndedAt: "2026-09-01T00:00:00.000Z" }),
    ],
    false,
  );
  assert.deepEqual(
    groups[0]?.rows.map((r) => [r.state, r.when]),
    [
      ["running", "2026-09-02T00:00:00.000Z"],
      ["running", "2026-09-01T00:00:00.000Z"],
      ["idle", "2026-09-09T00:00:00.000Z"],
      ["idle", "2026-09-04T00:00:00.000Z"],
    ],
  );
});

test("each group counts only its own running rows", () => {
  const groups = groupThreads(
    [
      summary({ cwd: "/a", session: "running", lastTurnEndedAt: "2026-09-09T00:00:00.000Z" }),
      summary({ cwd: "/a", session: "warming", lastTurnEndedAt: "2026-09-08T00:00:00.000Z" }),
      summary({ cwd: "/a", lastOutcome: "ok", lastTurnEndedAt: "2026-09-07T00:00:00.000Z" }),
      summary({ cwd: "/b", session: "running", lastTurnEndedAt: "2026-09-06T00:00:00.000Z" }),
    ],
    false,
  );
  assert.deepEqual(
    groups.map((g) => [g.cwd, g.running, g.rows.length]),
    [
      ["/a", 2, 3],
      ["/b", 1, 1],
    ],
  );
});

test("archived rows are hidden unless asked for, and an all-archived group disappears", () => {
  const threads = [
    summary({ cwd: "/a", lastTurnEndedAt: "2026-09-09T00:00:00.000Z" }),
    summary({ cwd: "/a", archivedAt: "2026-09-08T00:00:00.000Z", lastTurnEndedAt: "2026-09-08T00:00:00.000Z" }),
    summary({ cwd: "/gone", archivedAt: "2026-09-10T00:00:00.000Z", lastTurnEndedAt: "2026-09-10T00:00:00.000Z" }),
  ];

  assert.deepEqual(
    groupThreads(threads, false).map((g) => [g.cwd, g.rows.length]),
    [["/a", 1]],
  );

  assert.deepEqual(
    groupThreads(threads, true).map((g) => [g.cwd, g.rows.length]),
    [
      ["/gone", 1],
      ["/a", 2],
    ],
  );
});

test("no threads means no groups", () => {
  assert.deepEqual(groupThreads([], true), []);
});
