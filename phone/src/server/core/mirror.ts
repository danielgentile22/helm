/**
 * Markdown mirror: a projection of the log into the vault at
 * <vault>/inbox/chats/<threadId>.md so conversations are searchable in
 * Obsidian. Always the vault, regardless of the thread's cwd: the mirror is
 * about Daniel finding the conversation later, not about where the work
 * happened.
 *
 * Idempotent: each turn block ends with `<!-- helm:seq=N gen=G -->` where N
 * is the seq of the turn.ended and G the log generation it counts in. Every
 * append, whether driven by watch() or by resume(), re-reads that marker,
 * reads the log from there, and writes only the turns beyond it, so a crash
 * between log append and mirror append never duplicates or skips a turn.
 * When the log has moved to a new generation (compaction), the marker's seq
 * names nothing, so the whole note is written again from the log; the note
 * carries the generation, so a crash anywhere leaves it rebuildable. Appends
 * for one thread run on a per-thread serial queue, so a live turn.ended
 * landing during a boot catch-up cannot interleave with it.
 *
 * Best effort: a write that fails is logged and swallowed. The log is canon;
 * a missing mirror block is repaired by the next resume().
 *
 * Frontmatter (seeded once, except `recorded`):
 *   thread, type: chat, created, cwd, model, title, forked_from, recorded, tags: [chat]
 *
 * `recorded` is the exception because a thread is promoted to the vault long
 * after its note was seeded: the first append that carries a recorded item
 * rewrites the existing frontmatter to add it.
 *
 * This module is the one thing in the server that writes into the vault, and
 * it writes nothing but these notes (user story 62). prune() deletes notes
 * whose mtime is past the 30 day window and touches nothing else. A recorded
 * note is kept however old it is, because the Atlas notes a save produced
 * link back to it.
 */

import { mkdir, readdir, readFile, stat, unlink, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { answerPhrase, askSummary, FIRST_GENERATION, fmtBytes, toolSummary } from "../../shared/protocol";
import type { Cursor, Generation, Seq, ThreadConfig, ThreadEvent, ThreadId } from "../../shared/protocol";
import { groupTurns, isCompleted, type AskItem, type CompletedTurn, type TurnEnd } from "../../shared/turns";
import type { ThreadLog, Unsubscribe } from "./log";
import type { ThreadStore } from "./thread-store";

const RETENTION_MS = 30 * 24 * 60 * 60_000;
/** An older marker has no gen, which reads as generation 0. */
const MARKER = /<!--\s*helm:seq=(\d+)(?:\s+gen=(\d+))?\s*-->/g;
/** Mirror notes are named after a thread id, so prune never considers anything else. */
const NOTE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;
/** The leading frontmatter block of a note, captured without its fences. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---(\n|$)/;
const RECORDED_FIELD = "recorded: true";

export class Mirror {
  /** One serial write queue per thread: resume() and watch() share it, so appends never interleave. */
  private readonly queues = new Map<ThreadId, Promise<void>>();

  constructor(private readonly vaultRoot: string, private readonly threads: ThreadStore) {}

  /**
   * Subscribe; on every turn.ended, append every turn the note is missing.
   * Returns the detach function, the way LogRegistry.onOpen does.
   */
  watch(log: ThreadLog): Unsubscribe {
    return log.subscribe("projection", (ev) => {
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
      if (isRecorded(await readFile(file, "utf8").catch(() => ""))) {
        console.log(`[mirror] kept ${name}: recorded`);
        continue;
      }
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
   * marker. Reads from the marker; a message queued during the previous turn
   * has a seq below it while its own turn does not, and that one case
   * re-reads from zero so the prompt is not lost. A marker from another
   * generation names nothing in this log, so the note is written whole again.
   */
  private async catchUp(log: ThreadLog): Promise<void> {
    const file = mirrorPath(this.vaultRoot, log.threadId);
    const existing = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    const head = log.getHead();
    const generation = head.generation;
    const marker = lastMarker(existing);
    const rebuild = marker.seq > 0 && marker.generation !== generation;
    const after = rebuild ? 0 : marker.seq;
    let events = await collect(log.read(after));
    let turns = completedAfter(events, after);
    if (after > 0 && turns.some((t) => t.prompt === null)) {
      events = await collect(log.read(0));
      turns = completedAfter(events, after);
    }
    const seeding = rebuild || existing.trim() === "";
    // The head never forgets a note.recorded, while the window read here starts at the marker and can miss one.
    const flip = !seeding && head.recorded && !isRecorded(existing);
    if (turns.length === 0 && !rebuild && !flip) return;

    let out = "";
    if (seeding) out += frontmatter(log.threadId, (await this.threads.get(log.threadId).catch(() => null)) ?? configFromLog(events), forkOrigin(events), head.recorded);
    for (const turn of turns) out += "\n" + renderTurn(turn, generation) + "\n";

    await mkdir(dirname(file), { recursive: true });
    // A thread promoted to the vault after its note was seeded needs the field added, which an append cannot do.
    if (flip) await writeFile(file, markRecorded(existing) + out);
    else if (rebuild) await writeFile(file, out);
    else await appendFile(file, out);
  }
}

async function collect(events: AsyncIterable<ThreadEvent>): Promise<ThreadEvent[]> {
  const out: ThreadEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** The turns that ended past `after`. A turn still running has no end and is left for the next catch-up. */
function completedAfter(events: readonly ThreadEvent[], after: Cursor): readonly CompletedTurn[] {
  return groupTurns(events).filter(isCompleted).filter((t) => t.end.seq > after);
}

function configFromLog(events: readonly ThreadEvent[]): ThreadConfig | null {
  for (const ev of events) if (ev.kind === "thread.created") return ev.config;
  return null;
}

/** Where a forked thread came from. The fork point is the last copied turn, which is the event right before the divider. */
interface ForkOrigin {
  readonly from: ThreadId;
  readonly fromTitle: string | null;
  readonly at: string;
  readonly remembers: boolean;
}

function forkOrigin(events: readonly ThreadEvent[]): ForkOrigin | null {
  const ix = events.findIndex((ev) => ev.kind === "thread.forked");
  const ev = ix < 0 ? null : events[ix];
  if (!ev || ev.kind !== "thread.forked") return null;
  return { from: ev.from, fromTitle: ev.fromTitle, at: events[ix - 1]?.ts ?? ev.ts, remembers: ev.resume !== null };
}

/**
 * The one line that keeps a fork's note from reading as a duplicated
 * conversation: the turns above it were copied, from where, and whether Claude
 * carries them into the first new turn.
 */
function forkLine(origin: ForkOrigin): string {
  const memory = origin.remembers
    ? "Claude picks that session up here, so it remembers the turns above."
    : "Claude starts fresh here, so it does not remember the turns above.";
  return `The turns above the first new one were copied from [[${origin.from}|${origin.fromTitle ?? origin.from}]], forked at ${origin.at}. ${memory}`;
}

/** YAML scalar that is safe for a path, a title, or a model id. */
function yaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Pure. Insert `recorded: true` as the last field of the leading frontmatter block. Idempotent; a note without frontmatter is returned unchanged. */
export function markRecorded(markdown: string): string {
  if (isRecorded(markdown)) return markdown;
  const m = FRONTMATTER.exec(markdown);
  if (!m) return markdown;
  return markdown.slice(0, m.index) + `---\n${m[1]}\n${RECORDED_FIELD}\n---${m[2]}` + markdown.slice(m.index + m[0].length);
}

/** Pure. Whether the leading frontmatter says this thread was promoted to the vault. A `recorded:` line in the body does not count. */
export function isRecorded(markdown: string): boolean {
  const m = FRONTMATTER.exec(markdown);
  return m !== null && m[1]!.split("\n").some((line) => line.trim() === RECORDED_FIELD);
}

function frontmatter(threadId: ThreadId, config: ThreadConfig | null, fork: ForkOrigin | null, recorded: boolean): string {
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
  if (fork) lines.push(`forked_from: ${yaml(fork.from)}`);
  if (recorded) lines.push(RECORDED_FIELD);
  lines.push("tags: [chat]", "---", "", `# ${config?.title ?? threadId}`, "");
  if (fork) lines.push(forkLine(fork), "");
  return lines.join("\n");
}

/** Every line of a prompt or a tool line becomes a blockquote line, blanks included. */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

function footer(ended: TurnEnd): string {
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
 * How an ask was settled, in words. A system answer reads as expiry, not as
 * a denial the person made; a rule denial reads as Claude Code's own call.
 */
function answerVerb(item: AskItem): string {
  const a = item.answer;
  if (!a) return "(none)";
  if (a.by.by === "system") {
    const reason = a.answer.kind === "deny" && a.answer.reason ? `: ${a.answer.reason}` : "";
    return a.by.reason === "rule" ? `auto-denied${reason}` : `expired (${a.by.reason})`;
  }
  const verb = (() => {
    switch (a.answer.kind) {
      case "allow":
        return "allowed";
      case "allowTurn":
        return "allowed for the turn";
      case "deny":
        return a.answer.reason ? `denied: ${a.answer.reason}` : "denied";
      case "answers":
        return a.answer.answers.map(answerPhrase).join("; ");
    }
  })();
  return `${verb} [${a.by.origin.label}]`;
}

/**
 * Pure. Renders one completed turn. Tool calls are rendered as one line each
 * (`> Read Atlas/Areas/Health.md`) with no output, so the mirror stays a
 * readable conversation; the full detail is in events.jsonl. Thinking is
 * omitted for the same reason. A failed tool is marked with the word
 * "failed", never with color alone. An ask takes two lines in the same
 * stream, what was asked and how it was answered.
 */
export function renderTurn(turn: CompletedTurn, generation: Generation): string {
  const ended = turn.end;
  const prompt = turn.prompt;

  const texts: string[] = [];
  const tools: string[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  for (const item of turn.items) {
    if (item.kind === "text") {
      const text = item.text.trim();
      if (text.length > 0) texts.push(text);
    } else if (item.kind === "tool") {
      const { label, arg } = toolSummary(item.name, item.input);
      const mark = item.isError ? " (failed)" : "";
      tools.push(`${label}${arg ? ` ${arg}` : ""}${mark}`);
    } else if (item.kind === "file") {
      sent.push(`sent to phone: ${item.name} (${fmtBytes(item.bytes)})${item.note ? `: ${item.note}` : ""}`);
    } else if (item.kind === "recorded") {
      const target = item.rel.replace(/\.md$/i, "");
      notes.push(`- [[${target}|${target.split("/").at(-1)}]]: ${item.summary}`);
    } else if (item.kind === "ask") {
      tools.push(`asked: ${askSummary(item.ask)}`, `answered: ${answerVerb(item)}`);
    } else if (item.kind === "forkOut") {
      tools.push(`forked to: ${item.toTitle}`);
    }
  }

  const label = prompt ? ` [${prompt.label}]` : "";
  const ts = prompt?.ts ?? turn.startedAt ?? ended.ts;
  const out: string[] = [`## ${ts}${label}`];

  if (prompt) {
    const lines = [prompt.text.trimEnd()];
    if (prompt.uploads.length > 0) lines.push("", `uploads: ${prompt.uploads.map((u) => u.name).join(", ")}`);
    out.push(blockquote(lines.join("\n")));
  }

  out.push(...texts);
  if (tools.length > 0) out.push(tools.map((t) => `> ${t}`).join("\n"));
  if (sent.length > 0) out.push(sent.map((t) => `> ${t}`).join("\n"));
  if (notes.length > 0) out.push("Recorded to:", notes.join("\n"));

  out.push(footer(ended));
  out.push(`<!-- helm:seq=${ended.seq} gen=${generation} -->`);
  return out.join("\n\n") + "\n";
}

function chatsDir(vaultRoot: string): string {
  return join(vaultRoot, "inbox", "chats");
}

export function mirrorPath(vaultRoot: string, threadId: ThreadId): string {
  return join(chatsDir(vaultRoot), `${threadId}.md`);
}

/** Pure. The highest `<!-- helm:seq=N gen=G -->` marker; seq 0 in generation 0 when the note is missing or has none. */
export function lastMarker(markdown: string): { seq: Cursor; generation: Generation } {
  let seq: Cursor = 0;
  let generation = FIRST_GENERATION;
  for (const m of markdown.matchAll(MARKER)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= seq) continue;
    seq = n as Seq;
    generation = (m[2] === undefined ? 0 : Number(m[2])) as Generation;
  }
  return { seq, generation };
}
