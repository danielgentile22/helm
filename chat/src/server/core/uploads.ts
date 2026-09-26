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
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Origin, StagedUpload, ThreadId, UploadId } from "../../shared/protocol";
import { safeName, sniffMime } from "./files";
import type { LogRegistry } from "./log";
import { LogIndex } from "./log-index";
import type { ThreadStore } from "./thread-store";

export class Uploads {
  private readonly index: LogIndex<UploadId, StagedUpload>;

  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry) {
    this.index = new LogIndex(logs, (ev) => (ev.kind === "upload.staged" ? [ev.upload.uploadId, ev.upload] : null));
  }

  /** Write one file to disk and log it. Returns the staged record the client will reference in send(). */
  async stage(
    threadId: ThreadId,
    part: { name: string; mime: string; stream: AsyncIterable<Uint8Array> },
    origin: Origin,
  ): Promise<StagedUpload> {
    const config = await this.threads.get(threadId);
    if (!config) throw new Error(`no such thread: ${threadId}`);
    const dir = this.threads.uploadsDir(config);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);

    const uploadId = randomUUID() as UploadId;
    const safe = safeName(part.name);
    const path = join(dir, `${uploadId}-${safe}`);
    const tmp = `${path}.part`;
    let bytes = 0;
    let head = Buffer.alloc(0);
    const counter = async function* (src: AsyncIterable<Uint8Array>) {
      for await (const chunk of src) {
        bytes += chunk.byteLength;
        if (head.length < 16) head = Buffer.concat([head, Buffer.from(chunk)]).subarray(0, 16);
        yield chunk;
      }
    };
    await pipeline(Readable.from(counter(part.stream)), createWriteStream(tmp));
    await rename(tmp, path);

    const upload: StagedUpload = { uploadId, path, name: safe, mime: sniffMime(head) ?? part.mime, bytes };
    const log = await this.logs.get(threadId);
    await log.append({ kind: "upload.staged", upload, origin });
    this.index.remember(threadId, uploadId, upload);
    return upload;
  }

  /** Resolve ids the client sent to staged records; unknown ids are an error at the boundary, not silently skipped. */
  async resolve(threadId: ThreadId, ids: readonly string[]): Promise<readonly StagedUpload[]> {
    const found = await this.index.lookupAll(threadId, ids as readonly UploadId[]);
    return found.map((u, i) => {
      if (!u) throw new Error(`unknown upload id: ${ids[i]}`);
      return u;
    });
  }

  /** Delete the staging directory with the thread on archive. */
  async purge(threadId: ThreadId): Promise<void> {
    const config = await this.threads.get(threadId);
    if (config) await rm(this.threads.uploadsDir(config), { recursive: true, force: true });
    this.index.purge(threadId);
  }
}
