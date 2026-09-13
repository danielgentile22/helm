/**
 * The transcript's second fold: turns to renderable blocks.
 *
 * turns.ts answers "what happened". This answers "what does the log look
 * like": consecutive tool calls of one turn become a single activity block,
 * thinking collapses once the model starts speaking, an ok turn leaves no
 * trace. One section per turn, because the travelling rail light belongs to
 * the stretch of log the running turn owns. Pure, so every rule here is
 * pinned by a test over a real event sequence rather than by looking at the
 * screen.
 */

import { toolSummary } from "../shared/protocol";
import type { TurnId, Usage } from "../shared/protocol";
import type { FileItem, Prompt, ToolItem, Turn } from "../shared/turns";
import type { ThreadView } from "./fold";

export type { FileItem, Prompt, ToolItem };

export interface ActivityCounts {
  read: number;
  run: number;
  edit: number;
  other: number;
}

export type Block =
  | { kind: "prompt"; key: string; prompt: Prompt }
  | { kind: "thinking"; key: string; text: string; collapsed: boolean; streaming: boolean }
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | {
      kind: "activity";
      key: string;
      tools: readonly ToolItem[];
      counts: ActivityCounts;
      current: ToolItem | null;
      running: boolean;
      durationMs: number | null;
      startedAt: string;
    }
  | { kind: "end"; key: string; outcome: "interrupted" | "error" | "orphaned"; error: string | null }
  | { kind: "file"; key: string; file: FileItem }
  | { kind: "note"; key: string; text: string };

export interface Section {
  readonly key: string;
  readonly turnId: TurnId | null;
  readonly blocks: readonly Block[];
}

export function toBlocks(view: ThreadView): readonly Section[] {
  return view.turns.map((turn) => ({ key: turn.key, turnId: turn.turnId, blocks: turnBlocks(turn, view.openTurn === turn.turnId) }));
}

/**
 * Only the turn's last activity block is live: an earlier one has already
 * been closed off by text, so it stops its clock rather than counting until
 * the turn ends.
 */
function turnBlocks(turn: Turn, open: boolean): Block[] {
  const items = turn.items;
  const lastTextIx = findLastIndex(items, (i) => i.kind === "text");
  const isLast = (ix: number): boolean => ix === items.length - 1;
  const blocks: Block[] = [];
  let tools: ToolItem[] | null = null;
  if (turn.prompt) blocks.push({ kind: "prompt", key: turn.key, prompt: turn.prompt });
  items.forEach((item, ix) => {
    if (item.kind !== "tool") tools = null;
    switch (item.kind) {
      case "thinking":
        blocks.push({ kind: "thinking", key: `${turn.key}:think:${ix}`, text: item.text, collapsed: !open || lastTextIx > ix, streaming: open && isLast(ix) });
        break;
      case "text":
        blocks.push({ kind: "text", key: `${turn.key}:text:${ix}`, text: item.text, streaming: open && isLast(ix) });
        break;
      case "tool":
        if (tools) {
          tools.push(item);
          break;
        }
        tools = [item];
        blocks.push({ kind: "activity", key: `${turn.key}:act:${ix}`, tools, counts: emptyCounts(), current: null, running: false, durationMs: null, startedAt: item.startedAt });
        break;
      case "file":
        blocks.push({ kind: "file", key: `file:${item.fileId}`, file: item });
        break;
      case "note":
        blocks.push({ kind: "note", key: `${turn.key}:note:${ix}`, text: item.text });
        break;
    }
  });
  if (turn.end && turn.end.outcome !== "ok") blocks.push({ kind: "end", key: `${turn.key}:end`, outcome: turn.end.outcome, error: turn.end.error });

  const activities = blocks.filter((b): b is Extract<Block, { kind: "activity" }> => b.kind === "activity");
  const tail = activities[activities.length - 1];
  for (const b of activities) {
    b.counts = count(b.tools);
    b.running = open && b === tail;
    b.current = b.running ? (findLast(b.tools, (t) => t.endedAt === null) ?? null) : null;
    b.durationMs = b.running ? null : finishedDuration(b, turn.end?.usage ?? null, activities.length === 1);
  }
  return blocks;
}

const emptyCounts = (): ActivityCounts => ({ read: 0, run: 0, edit: 0, other: 0 });

function count(tools: readonly ToolItem[]): ActivityCounts {
  const c = emptyCounts();
  for (const t of tools) c[toolSummary(t.name, t.input).category] += 1;
  return c;
}

function findLastIndex<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i;
  return -1;
}

function findLast<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  const ix = findLastIndex(items, pred);
  return ix >= 0 ? items[ix] : undefined;
}

/**
 * The turn's own reported duration is the honest number when the turn is one
 * stretch of tool calls; once a turn has several activity blocks it would
 * over-count every one of them, so each block times itself from its stamps.
 */
function finishedDuration(block: Extract<Block, { kind: "activity" }>, usage: Usage | null, soleBlock: boolean): number | null {
  if (soleBlock && usage) return usage.durationMs;
  const end = findLast(block.tools, (t) => t.endedAt !== null)?.endedAt;
  if (!end) return null;
  return new Date(end).getTime() - new Date(block.startedAt).getTime();
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function summarize(counts: ActivityCounts): string {
  const parts: string[] = [];
  if (counts.read) parts.push(`read ${plural(counts.read, "file", "files")}`);
  if (counts.run) parts.push(`ran ${plural(counts.run, "command", "commands")}`);
  if (counts.edit) parts.push(`edited ${plural(counts.edit, "file", "files")}`);
  if (counts.other) parts.push(`${counts.other} other`);
  return parts.length ? parts.join(", ") : "working";
}

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

/** Line-level longest common subsequence. Inputs are capped at 4 KB by the server (LIMITS.TOOL_INPUT_MAX). */
export function diffLines(oldText: string, newText: string): readonly DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: a[i]! });
      i++;
    } else {
      out.push({ op: "+", text: b[j]! });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ op: "-", text: a[i]! });
  for (; j < b.length; j++) out.push({ op: "+", text: b[j]! });
  return out;
}

const str = (o: Record<string, unknown>, key: string): string | null => (typeof o[key] === "string" ? (o[key] as string) : null);

/** The diff a tool call implies, or null when the tool does not describe one edit of one file. */
export function toolDiff(tool: ToolItem): { file: string; lines: readonly DiffLine[] } | null {
  if (!tool.input || typeof tool.input !== "object") return null;
  const o = tool.input as Record<string, unknown>;
  const file = str(o, "file_path") ?? str(o, "path");
  if (!file) return null;
  if (tool.name === "Edit") {
    const oldStr = str(o, "old_string");
    const newStr = str(o, "new_string");
    if (oldStr === null || newStr === null) return null;
    return { file, lines: diffLines(oldStr, newStr) };
  }
  if (tool.name === "Write") {
    const content = str(o, "content");
    if (content === null) return null;
    return { file, lines: content.split("\n").map((text) => ({ op: "+", text }) as const) };
  }
  return null;
}

export const blockCount = (sections: readonly Section[]): number => sections.reduce((n, s) => n + s.blocks.length, 0);

export const jumpCount = (sections: readonly Section[], seenCount: number): number => Math.max(0, blockCount(sections) - seenCount);
