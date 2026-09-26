/**
 * Files the model handed to the phone: offers and recorded vault notes. The
 * mirror image of Uploads: each is an event naming a live path on the Mac,
 * and the download route serves only ids that appeared in that thread, so
 * knowing a thread id never becomes a way to read arbitrary paths. Both kinds
 * share one index, because both are served by the same file route.
 *
 * Nothing is copied. The agent already has full filesystem reach, so neither
 * widens anything; they only record what the model chose to hand over.
 */

import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { LIMITS, type FileId, type OfferedFile, type Origin, type RecordedNote, type ThreadId } from "../../shared/protocol";
import { mimeFromExtension, safeName, sniffMime } from "./files";
import type { LogRegistry } from "./log";
import { LogIndex } from "./log-index";
import type { ThreadStore } from "./thread-store";

/** The origin stamped on offers made by the model's tool call. */
export const MODEL_ORIGIN: Origin = { via: "key", label: "model" };

/** An offer's note and a recorded note's summary are both one line on a card. */
const LINE_CHARS = 200;

export class Offers {
  private readonly index: LogIndex<FileId, OfferedFile>;

  constructor(private readonly threads: ThreadStore, private readonly logs: LogRegistry, private readonly vaultRoot: string) {
    this.index = new LogIndex(logs, (ev) => (ev.kind === "file.offered" ? [ev.file.fileId, ev.file] : ev.kind === "note.recorded" ? [ev.note.file.fileId, ev.note.file] : null));
  }

  /**
   * Validate the path, sniff the type, log the offer. Throws with a plain
   * sentence the model can relay; a refused offer leaves no event.
   */
  async offer(threadId: ThreadId, path: string, note: string | null, origin: Origin): Promise<OfferedFile> {
    const size = await this.check(threadId, path);
    const file: OfferedFile = {
      fileId: randomUUID() as FileId,
      path,
      name: safeName(basename(path)),
      mime: (await sniffFile(path)) ?? mimeFromExtension(path),
      bytes: size,
      note: note?.trim() ? note.trim().slice(0, LINE_CHARS) : null,
    };
    const log = await this.logs.get(threadId);
    await log.append({ kind: "file.offered", file, origin });
    this.index.remember(threadId, file.fileId, file);
    return file;
  }

  /** Validate that the path is a markdown file inside the vault, then log it as recorded. Throws with a sentence the model can relay. */
  async record(threadId: ThreadId, path: string, summary: string, origin: Origin): Promise<RecordedNote> {
    const size = await this.check(threadId, path);
    const rel = relative(resolve(this.vaultRoot), resolve(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} is not inside the vault at ${this.vaultRoot}; only vault notes can be recorded`);
    if (!path.toLowerCase().endsWith(".md")) throw new Error(`${path} is not a markdown file; a recorded note must be a .md file in the vault`);
    const said = summary.trim().slice(0, LINE_CHARS);
    if (said === "") throw new Error("summary must say what changed in this note");

    const note: RecordedNote = {
      file: { fileId: randomUUID() as FileId, path, name: safeName(basename(path)), mime: "text/markdown", bytes: size, note: null },
      rel: rel.split(sep).join("/"),
      summary: said,
    };
    const log = await this.logs.get(threadId);
    await log.append({ kind: "note.recorded", note, origin });
    this.index.remember(threadId, note.file.fileId, note.file);
    return note;
  }

  /** The offered record for an id, rebuilt from the log after a restart. Null when never handed over in this thread. */
  resolve(threadId: ThreadId, fileId: string): Promise<OfferedFile | null> {
    return this.index.lookup(threadId, fileId as FileId);
  }

  /** Forget a thread's offers on archive. The files are the user's own and stay where they are. */
  purge(threadId: ThreadId): void {
    this.index.purge(threadId);
  }

  /** What both kinds require of a path: a live, regular file on this Mac under the size cap. Returns its size. */
  private async check(threadId: ThreadId, path: string): Promise<number> {
    if (!(await this.threads.get(threadId))) throw new Error(`no such thread: ${threadId}`);
    if (!isAbsolute(path)) throw new Error(`path must be absolute: ${path}`);
    const st = await stat(path).catch(() => null);
    if (!st) throw new Error(`no such file: ${path}`);
    if (st.isDirectory()) throw new Error(`${path} is a directory; offer one file at a time`);
    if (!st.isFile()) throw new Error(`${path} is not a regular file`);
    if (st.size > LIMITS.OFFER_BYTES) throw new Error(`file is larger than ${LIMITS.OFFER_BYTES} bytes (${st.size}); too big to send to the phone`);
    return st.size;
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
