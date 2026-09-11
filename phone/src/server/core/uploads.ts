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
import type { LogRegistry } from "./log";
import type { ThreadStore } from "./thread-store";

export class Uploads {
  private readonly staged = new Map<ThreadId, Map<UploadId, StagedUpload>>();

  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry) {}

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

    const uploadId = mintUploadId();
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
    let byThread = this.staged.get(threadId);
    if (!byThread) this.staged.set(threadId, (byThread = new Map()));
    byThread.set(uploadId, upload);
    return upload;
  }

  /** Resolve ids the client sent to staged records; unknown ids are an error at the boundary, not silently skipped. */
  async resolve(threadId: ThreadId, ids: readonly string[]): Promise<readonly StagedUpload[]> {
    if (ids.length === 0) return [];
    const known = this.staged.get(threadId) ?? new Map<UploadId, StagedUpload>();
    const missing = ids.filter((id) => !known.has(id as UploadId));
    if (missing.length) {
      // Staged before a restart: the log remembers.
      const log = await this.logs.get(threadId);
      for await (const ev of log.read(0)) if (ev.kind === "upload.staged") known.set(ev.upload.uploadId, ev.upload);
      this.staged.set(threadId, known);
    }
    return ids.map((id) => {
      const u = known.get(id as UploadId);
      if (!u) throw new Error(`unknown upload id: ${id}`);
      return u;
    });
  }

  /** Delete the staging directory with the thread on archive. */
  async purge(threadId: ThreadId): Promise<void> {
    const config = await this.threads.get(threadId);
    if (config) await rm(this.threads.uploadsDir(config), { recursive: true, force: true });
    this.staged.delete(threadId);
  }
}

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  return base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "file";
}

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime);
}

/** Magic bytes for the image types the model accepts; anything else keeps the client's mime. */
export function sniffMime(head: Uint8Array): string | null {
  const b = Buffer.from(head);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (b.length >= 5 && b.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

export function mintUploadId(): UploadId {
  return randomUUID() as UploadId;
}
