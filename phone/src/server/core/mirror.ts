/**
 * Markdown mirror: a projection of the log into the vault at
 * <vault>/inbox/chats/<threadId>.md so conversations are searchable in
 * Obsidian. Always the vault, regardless of the thread's cwd: the mirror is
 * about Daniel finding the conversation later, not about where the work
 * happened.
 *
 * Idempotent: each turn block ends with `<!-- helm:seq=N -->` where N is the
 * seq of the turn.ended. Every append, whether driven by watch() or by
 * resume(), re-reads that marker and writes only the turns beyond it, so a
 * crash between log append and mirror append never duplicates or skips a
 * turn. Appends for one thread run on a per-thread serial queue, so a live
 * turn.ended landing during a boot catch-up cannot interleave with it.
 *
 * Best effort: a write that fails is logged and swallowed. The log is canon;
 * a missing mirror block is repaired by the next resume().
 *
 * Frontmatter (seeded once):
 *   thread, type: chat, created, cwd, model, title, tags: [chat]
 *
 * This module is the one thing in the server that writes into the vault, and
 * it writes nothing but these notes (user story 62). prune() deletes notes
 * whose mtime is past the 30 day window and touches nothing else.
 */

import { mkdir, readdir, readFile, stat, unlink, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClientMsgId, ThreadConfig, ThreadEvent, ThreadId } from "../../shared/protocol";
import type { ThreadLog, Unsubscribe } from "./log";
import type { ThreadStore } from "./thread-store";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MARKER = /<!--\s*helm:seq=(\d+)\s*-->/g;
/** Mirror notes are named after a thread id, so prune never considers anything else. */
const NOTE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;

export class Mirror {
  /** One serial write queue per thread: resume() and watch() share it, so appends never interleave. */
  private readonly queues = new Map<ThreadId, Promise<void>>();

  constructor(private readonly vaultRoot: string, private readonly threads: ThreadStore) {}

  /**
   * Subscribe; on every turn.ended, append every turn the note is missing.
   * Returns the detach function, the way LogRegistry.onOpen does.
   */
  watch(log: ThreadLog): Unsubscribe {
    return log.subscribe((ev) => {
      if (ev.kind !== "turn.ended") return;
      void this.enqueue(log.threadId, () => this.catchUp(log)).catch((err) => {
        // Never throw into the log's subscriber loop.
        console.error(`[mirror ${log.threadId}] append failed`, err);
      });
    });
  }

  /** Catch a thread's mirror up from its last marker. Called at boot after recoverAll. */
  async resume(log: ThreadLog): Promise<void> {
    await this.enqueue(log.threadId, () => this.catchUp(log));
  }

  /** Delete mirror notes older than the retention window (30 days). The log is canon, so this is lossless. */
  async prune(): Promise<void> {
    const dir = chatsDir(this.vaultRoot);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of names) {
      if (!NOTE_NAME.test(name)) continue;
      const file = join(dir, name);
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile() || s.mtimeMs >= cutoff) continue;
      await unlink(file);
      console.log(`[mirror] pruned ${name}`);
    }
  }

  /** Resolves when every queued append has run. For shutdown and for tests. */
  async idle(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }

  private enqueue(threadId: ThreadId, work: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(threadId) ?? Promise.resolve();
    const run = prev.then(work);
    const settled = run.catch(() => undefined);
    this.queues.set(threadId, settled);
    void settled.then(() => {
      if (this.queues.get(threadId) === settled) this.queues.delete(threadId);
    });
    return run;
  }

  /**
   * Append every completed turn whose turn.ended is beyond the note's last
   * marker. The whole log is scanned rather than only the tail after the
   * marker, because a message queued during the previous turn has a seq
   * below that marker while its own turn does not.
   */
  private async catchUp(log: ThreadLog): Promise<void> {
    const file = mirrorPath(this.vaultRoot, log.threadId);
    const existing = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    const events: ThreadEvent[] = [];
    for await (const ev of log.read(0)) events.push(ev);

    const turns = completedTurnsAfter(events, lastMirroredSeq(existing));
    if (turns.length === 0) return;

    let out = "";
    if (existing.trim() === "") out += frontmatter(log.threadId, (await this.threads.get(log.threadId).catch(() => null)) ?? configFromLog(events));
    for (const turn of turns) out += "\n" + renderTurn(turn) + "\n";

    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, out);
  }
}

/**
 * Groups a full event list into the completed turns whose turn.ended is past
 * `after`. Each slice runs from turn.started through turn.ended, prefixed by
 * the input.queued carrying that turn's clientMsgId. A trailing turn.started
 * with no turn.ended is dropped: the log's open() seals those, so the only
 * way to see one is a turn still running.
 */
function completedTurnsAfter(events: readonly ThreadEvent[], after: number): ThreadEvent[][] {
  const queued = new Map<ClientMsgId, ThreadEvent>();
  const out: ThreadEvent[][] = [];
  let current: ThreadEvent[] | null = null;
  for (const ev of events) {
    if (ev.kind === "input.queued") queued.set(ev.clientMsgId, ev);
    if (ev.kind === "turn.started") {
      current = [ev];
      continue;
    }
    if (!current) continue;
    current.push(ev);
    if (ev.kind !== "turn.ended") continue;
    const started = current[0];
    if (ev.seq > after && started?.kind === "turn.started") {
      const prompt = queued.get(started.clientMsgId);
      out.push(prompt ? [prompt, ...current] : current);
    }
    current = null;
  }
  return out;
}

function configFromLog(events: readonly ThreadEvent[]): ThreadConfig | null {
  for (const ev of events) if (ev.kind === "thread.created") return ev.config;
  return null;
}

/** YAML scalar that is safe for a path, a title, or a model id. */
function yaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function frontmatter(threadId: ThreadId, config: ThreadConfig | null): string {
  const lines = [
    "---",
    `thread: ${threadId}`,
    "type: chat",
    `created: ${config?.createdAt ?? new Date().toISOString()}`,
  ];
  if (config) {
    lines.push(`cwd: ${yaml(config.cwd)}`);
    lines.push(`model: ${yaml(config.model)}`);
    if (config.title) lines.push(`title: ${yaml(config.title)}`);
  }
  lines.push("tags: [chat]", "---", "", `# ${config?.title ?? threadId}`, "");
  return lines.join("\n");
}

/** Every line of a prompt or a tool line becomes a blockquote line, blanks included. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/** The one salient argument of a tool call, so the line reads as an action. */
function toolArg(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "command", "pattern", "url", "notebook_path", "prompt", "description"]) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const json = JSON.stringify(input) ?? "";
  return json.length > 160 ? json.slice(0, 160) + "..." : json;
}

function footer(ended: Extract<ThreadEvent, { kind: "turn.ended" }>): string {
  const parts = [`_${ended.outcome}_`];
  const u = ended.usage;
  if (u) {
    parts.push(`tokens ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cached`);
    if (u.costUsd !== null) parts.push(`cost $${u.costUsd.toFixed(4)}`);
    parts.push(`${(u.durationMs / 1000).toFixed(1)}s`);
  }
  if (ended.error) parts.push(ended.error);
  return parts.join(" | ");
}

/**
 * Pure. Renders one completed turn. `events` is the slice from turn.started
 * through turn.ended plus the input.queued that carries the turn's
 * clientMsgId. Tool calls are rendered as one line each
 * (`> Read Atlas/Areas/Health.md`) with no output, so the mirror stays a
 * readable conversation; the full detail is in events.jsonl. Thinking is
 * omitted for the same reason. A failed tool is marked with the word
 * "failed", never with color alone.
 */
export function renderTurn(events: readonly ThreadEvent[]): string {
  const ended = events.find((e) => e.kind === "turn.ended");
  if (!ended || ended.kind !== "turn.ended") throw new Error("renderTurn: the slice has no turn.ended");
  const started = events.find((e) => e.kind === "turn.started");
  const prompt = events.find((e) => e.kind === "input.queued");

  const blocks = new Map<number, string>();
  const order: number[] = [];
  const tools: string[] = [];
  const failed = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "assistant.text") {
      if (!blocks.has(ev.blockIx)) order.push(ev.blockIx);
      blocks.set(ev.blockIx, (blocks.get(ev.blockIx) ?? "") + ev.delta);
    } else if (ev.kind === "tool.finished" && ev.isError) {
      failed.add(ev.toolUseId);
    }
  }
  for (const ev of events) {
    if (ev.kind !== "tool.started") continue;
    const arg = toolArg(ev.input);
    const mark = failed.has(ev.toolUseId) ? " (failed)" : "";
    tools.push(`${ev.name}${arg ? ` ${arg}` : ""}${mark}`);
  }

  const label = prompt?.kind === "input.queued" ? ` [${prompt.origin.label}]` : "";
  const ts = prompt?.ts ?? started?.ts ?? ended.ts;
  const out: string[] = [`## ${ts}${label}`];

  if (prompt?.kind === "input.queued") {
    const lines = [prompt.text.trimEnd()];
    if (prompt.uploads.length > 0) lines.push("", `uploads: ${prompt.uploads.map((u) => u.name).join(", ")}`);
    out.push(blockquote(lines.join("\n")));
  }

  for (const ix of order) {
    const text = (blocks.get(ix) ?? "").trim();
    if (text.length > 0) out.push(text);
  }
  if (tools.length > 0) out.push(tools.map((t) => `> ${t}`).join("\n"));

  out.push(footer(ended));
  out.push(`<!-- helm:seq=${ended.seq} -->`);
  return out.join("\n\n") + "\n";
}

function chatsDir(vaultRoot: string): string {
  return join(vaultRoot, "inbox", "chats");
}

export function mirrorPath(vaultRoot: string, threadId: ThreadId): string {
  return join(chatsDir(vaultRoot), `${threadId}.md`);
}

/** Pure. Reads the highest `<!-- helm:seq=N -->` marker; 0 if the file is missing or has none. */
export function lastMirroredSeq(markdown: string): number {
  let max = 0;
  for (const m of markdown.matchAll(MARKER)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
