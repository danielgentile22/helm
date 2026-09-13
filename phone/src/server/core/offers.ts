/**
 * Files the model offers to the phone. The mirror image of Uploads: an offer
 * is a `file.offered` event naming a live path on the Mac, and the download
 * route serves only ids that were offered in that thread, so knowing a thread
 * id never becomes a way to read arbitrary paths.
 *
 * Nothing is copied. The agent already has full filesystem reach, so the
 * offer widens nothing; it only records what the model chose to hand over.
 */

import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { LIMITS, type FileId, type OfferedFile, type Origin, type ThreadId } from "../../shared/protocol";
import type { LogRegistry } from "./log";
import type { ThreadStore } from "./thread-store";
import { safeName, sniffMime } from "./uploads";

/** The origin stamped on offers made by the model's tool call. */
export const MODEL_ORIGIN: Origin = { via: "key", label: "model" };

export class Offers {
  private readonly known = new Map<ThreadId, Map<FileId, OfferedFile>>();

  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry) {}

  /**
   * Validate the path, sniff the type, log the offer. Throws with a plain
   * sentence the model can relay; a refused offer leaves no event.
   */
  async offer(threadId: ThreadId, path: string, note: string | null, origin: Origin): Promise<OfferedFile> {
    if (!(await this.threads.get(threadId))) throw new Error(`no such thread: ${threadId}`);
    if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
    const st = await stat(path).catch(() => null);
    if (!st) throw new Error(`no such file: ${path}`);
    if (st.isDirectory()) throw new Error(`${path} is a directory; offer one file at a time`);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > LIMITS.OFFER_BYTES) throw new Error(`file is larger than ${LIMITS.OFFER_BYTES} bytes (${st.size}); too big to send to the phone`);

    const file: OfferedFile = {
      fileId: randomUUID() as FileId,
      path,
      name: safeName(basename(path)),
      mime: (await sniffFile(path)) ?? mimeFromExtension(path),
      bytes: st.size,
      note: note?.trim() ? note.trim().slice(0, 200) : null,
    };
    const log = await this.logs.get(threadId);
    await log.append({ kind: "file.offered", file, origin });
    this.byThread(threadId).set(file.fileId, file);
    return file;
  }

  /** The offered record for an id, rebuilt from the log after a restart. Null when never offered in this thread. */
  async resolve(threadId: ThreadId, fileId: string): Promise<OfferedFile | null> {
    const known = this.byThread(threadId);
    if (!known.has(fileId as FileId)) {
      const log = await this.logs.get(threadId);
      for await (const ev of log.read(0)) if (ev.kind === "file.offered") known.set(ev.file.fileId, ev.file);
    }
    return known.get(fileId as FileId) ?? null;
  }

  /** Forget a thread's offers on archive. The files are the user's own and stay where they are. */
  purge(threadId: ThreadId): void {
    this.known.delete(threadId);
  }

  private byThread(threadId: ThreadId): Map<FileId, OfferedFile> {
    let m = this.known.get(threadId);
    if (!m) this.known.set(threadId, (m = new Map()));
    return m;
  }
}

async function sniffFile(path: string): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    return sniffMime(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

const EXT_MIME: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** What the share sheet keys on when the magic bytes say nothing. Unknown extensions are plain bytes. */
export function mimeFromExtension(path: string): string {
  return EXT_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}
