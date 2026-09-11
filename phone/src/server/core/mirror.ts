/**
 * Markdown mirror: a projection of the log into the vault at
 * <vault>/inbox/chats/<threadId>.md so conversations are searchable in
 * Obsidian. Always the vault, regardless of the thread's cwd: the mirror is
 * about Daniel finding the conversation later, not about where the work
 * happened.
 *
 * Idempotent: each turn block ends with `<!-- helm:seq=N -->` where N is the
 * seq of the turn.ended. On boot, resume() reads the last marker and appends
 * only turns beyond it, so a crash between log append and mirror append
 * never duplicates or skips a turn.
 *
 * Frontmatter (seeded once):
 *   thread, type: chat, created, cwd, model, tags: [chat]
 */

import type { ThreadEvent, ThreadId } from "../../shared/protocol";
import type { LogRegistry, ThreadLog } from "./log";
import type { ThreadStore } from "./thread-store";

export class Mirror {
  constructor(private readonly vaultRoot: string, private readonly threads: ThreadStore) {}

  /** Subscribe; on every turn.ended, render the turn (from turn.started to turn.ended) and append. */
  watch(log: ThreadLog): void {
    // TODO(mirror PR): not yet implemented; a no-op so the server boots.
    void log;
  }

  /** Catch up a thread's mirror from its last marker. Called at boot after recoverAll. */
  async resume(log: ThreadLog): Promise<void> {
    // TODO(mirror PR)
    void log;
  }

  /** Delete mirror notes older than the retention window (30 days). The log is canon, so this is lossless. */
  async prune(): Promise<void> {
    // TODO(mirror PR)
  }
}

/**
 * Pure. Renders one completed turn. Tool calls are rendered as one line each
 * (`> Read Atlas/Areas/Health.md`) with no output, so the mirror stays a
 * readable conversation; the full detail is in events.jsonl.
 */
export function renderTurn(events: readonly ThreadEvent[]): string {
  throw new Error("not implemented");
}

export function mirrorPath(vaultRoot: string, threadId: ThreadId): string {
  throw new Error("not implemented");
}

/** Pure. Reads the highest `<!-- helm:seq=N -->` marker; 0 if the file is missing or has none. */
export function lastMirroredSeq(markdown: string): number {
  throw new Error("not implemented");
}
