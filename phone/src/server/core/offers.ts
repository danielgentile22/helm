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
import { basename, isAbsolute } from "node:path";
import { LIMITS, type FileId, type OfferedFile, type Origin, type ThreadId } from "../../shared/protocol";
import { mimeFromExtension, safeName, sniffMime } from "./files";
import type { LogRegistry } from "./log";
import { LogIndex } from "./log-index";
import type { ThreadStore } from "./thread-store";

/** The origin stamped on offers made by the model's tool call. */
export const MODEL_ORIGIN: Origin = { via: "key", label: "model" };

export class Offers {
  private readonly index: LogIndex<FileId, OfferedFile>;

  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry) {
    this.index = new LogIndex(logs, (ev) => (ev.kind === "file.offered" ? [ev.file.fileId, ev.file] : null));
  }

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
    this.index.remember(threadId, file.fileId, file);
    return file;
  }

  /** The offered record for an id, rebuilt from the log after a restart. Null when never offered in this thread. */
  resolve(threadId: ThreadId, fileId: string): Promise<OfferedFile | null> {
    return this.index.lookup(threadId, fileId as FileId);
  }

  /** Forget a thread's offers on archive. The files are the user's own and stay where they are. */
  purge(threadId: ThreadId): void {
    this.index.purge(threadId);
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
