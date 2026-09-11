/**
 * thread.json per thread: the user-set inputs (cwd, model, effort, title).
 * Not derived from the log on purpose: config is an input, and the current
 * value must be readable without folding history. Every change is also
 * appended to the log as `thread.config` by the supervisor so the transcript
 * shows it.
 *
 * Written with atomicWrite so a concurrent reader never sees a torn file
 * (the old sidecar bug: a torn read silently forked a new session).
 */

import type { CreateThreadRequest, DirEntry, ThreadConfig, ThreadConfigPatch, ThreadId } from "../../shared/protocol";

export class ThreadStore {
  constructor(private readonly threadsRoot: string) {}

  /** Idempotent on threadId: creating an existing thread returns it unchanged (client-minted ids may be retried). */
  create(req: CreateThreadRequest & { threadId: ThreadId }): Promise<ThreadConfig>;
  create(req: never): Promise<ThreadConfig> {
    // TODO: validate cwd is an absolute existing directory; mkdir threads/<id>/{uploads}; atomicWrite thread.json
    throw new Error("not implemented");
  }

  get(threadId: ThreadId): Promise<ThreadConfig | null> {
    throw new Error("not implemented");
  }

  patch(threadId: ThreadId, patch: ThreadConfigPatch): Promise<ThreadConfig> {
    throw new Error("not implemented");
  }

  /** All non-archived configs, newest first. Summaries (head, preview) are joined in http/app.ts from the logs. */
  list(opts?: { includeArchived?: boolean }): Promise<readonly ThreadConfig[]> {
    throw new Error("not implemented");
  }

  /** Directory picker source. Lists immediate children only; caller walks. Only within allowed roots. */
  browse(path: string, roots: readonly string[]): Promise<readonly DirEntry[]> {
    // TODO: resolve, reject if not under any root; readdir withFileTypes; hasClaudeMd = exists(join(p,"CLAUDE.md")); isGitRepo = exists(join(p,".git"))
    throw new Error("not implemented");
  }

  uploadsDir(threadId: ThreadId): string {
    throw new Error("not implemented");
  }
}
