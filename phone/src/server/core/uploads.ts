/**
 * Staging area for files sent from the phone. Files are written under the
 * thread's working directory in an ignored `.helm2-uploads/` folder as
 * <uploadId>-<safeName> and logged as `upload.staged`. From there they are
 * ordinary files on the Mac: the model Reads them, or mv's them into the
 * vault when asked, which is a same-filesystem rename.
 *
 * Streamed to disk (never buffered whole); the HTTP layer rejects on
 * Content-Length before this is called (auth.bodyTooLarge).
 */

import { randomUUID } from "node:crypto";
import type { Origin, StagedUpload, ThreadId, UploadId } from "../../shared/protocol";
import type { LogRegistry } from "./log";
import type { ThreadStore } from "./thread-store";

export class Uploads {
  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry) {}

  /** Write one multipart part to disk and log it. Returns the staged record the client will reference in send(). */
  stage(
    threadId: ThreadId,
    part: { name: string; mime: string; stream: AsyncIterable<Uint8Array> },
    origin: Origin,
  ): Promise<StagedUpload> {
    throw new Error("not implemented");
  }

  /** Resolve ids the client sent to staged records; unknown ids are an error at the boundary, not silently skipped. */
  resolve(threadId: ThreadId, ids: readonly string[]): Promise<readonly StagedUpload[]> {
    throw new Error("not implemented");
  }

  /** Delete the staging directory with the thread on archive. */
  purge(threadId: ThreadId): Promise<void> {
    throw new Error("not implemented");
  }
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime);
}

export function mintUploadId(): UploadId {
  return randomUUID() as UploadId;
}
