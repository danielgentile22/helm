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

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { CreateThreadRequest, DirEntry, ThreadConfig, ThreadConfigPatch, ThreadId } from "../../shared/protocol";
import { atomicWrite } from "../util/atomicWrite";

const UPLOADS_DIRNAME = ".helm2-uploads";

async function isDir(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isDirectory(), () => false);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

export class ThreadStore {
  constructor(private readonly threadsRoot: string) {}

  private file(threadId: ThreadId): string {
    return join(this.threadsRoot, threadId, "thread.json");
  }

  /** Idempotent on threadId: creating an existing thread returns it unchanged (client-minted ids may be retried). */
  async create(req: CreateThreadRequest & { threadId: ThreadId }): Promise<ThreadConfig> {
    const existing = await this.get(req.threadId);
    if (existing) return existing;
    if (!isAbsolute(req.cwd) || !(await isDir(req.cwd))) throw new Error(`cwd is not an existing absolute directory: ${req.cwd}`);
    const config: ThreadConfig = {
      threadId: req.threadId,
      cwd: resolve(req.cwd),
      model: req.model,
      effort: req.effort,
      title: req.title ?? null,
      createdAt: new Date().toISOString(),
      archivedAt: null,
    };
    await mkdir(join(this.threadsRoot, req.threadId), { recursive: true });
    await atomicWrite(this.file(req.threadId), JSON.stringify(config, null, 2) + "\n");
    return config;
  }

  async get(threadId: ThreadId): Promise<ThreadConfig | null> {
    try {
      return JSON.parse(await readFile(this.file(threadId), "utf8")) as ThreadConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async patch(threadId: ThreadId, patch: ThreadConfigPatch): Promise<ThreadConfig> {
    return this.update(threadId, patch);
  }

  async archive(threadId: ThreadId): Promise<ThreadConfig> {
    return this.update(threadId, { archivedAt: new Date().toISOString() });
  }

  private async update(threadId: ThreadId, patch: Partial<ThreadConfig>): Promise<ThreadConfig> {
    const current = await this.get(threadId);
    if (!current) throw new Error(`no such thread: ${threadId}`);
    const next: ThreadConfig = { ...current, ...patch };
    await atomicWrite(this.file(threadId), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  /** All configs, newest first. Summaries (head, preview) are joined in http/app.ts from the logs. */
  async list(opts?: { includeArchived?: boolean }): Promise<readonly ThreadConfig[]> {
    await mkdir(this.threadsRoot, { recursive: true });
    const out: ThreadConfig[] = [];
    for (const entry of await readdir(this.threadsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const c = await this.get(entry.name as ThreadId);
      if (c && (opts?.includeArchived || c.archivedAt === null)) out.push(c);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Directory picker source. Lists immediate children only; caller walks. Only within allowed roots. */
  async browse(path: string, roots: readonly string[]): Promise<readonly DirEntry[]> {
    const p = resolve(path);
    if (!roots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + sep))) throw new Error(`path is outside the browsable roots: ${path}`);
    const out: DirEntry[] = [];
    for (const entry of await readdir(p, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(p, entry.name);
      out.push({ name: entry.name, path: full, hasClaudeMd: await exists(join(full, "CLAUDE.md")), isGitRepo: await exists(join(full, ".git")) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Uploads stage under the thread's working directory so moving one into the vault is a rename. */
  uploadsDir(config: Pick<ThreadConfig, "cwd">): string {
    return join(config.cwd, UPLOADS_DIRNAME);
  }
}
