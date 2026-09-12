/**
 * The transcript's second fold: ThreadView lines to renderable blocks.
 *
 * fold.ts answers "what happened". This answers "what does the log look
 * like": consecutive tool calls of one turn become a single activity block,
 * thinking collapses once the model starts speaking, an ok turn leaves no
 * trace. Pure, so every rule here is pinned by a test over a real event
 * sequence rather than by looking at the screen.
 */

import type { TurnId, Usage } from "../shared/protocol";
import type { Line, ThreadView } from "./fold";

export type PromptLine = Extract<Line, { kind: "prompt" }>;
export type ToolLine = Extract<Line, { kind: "tool" }>;

export type ToolCategory = "read" | "run" | "edit" | "other";

/**
 * A table rather than a chain of conditions, so adding a tool is one row.
 * Anything absent is "other", which is also what every `mcp__*` name gets.
 */
export const TOOL_CATEGORY: Readonly<Record<string, ToolCategory>> = {
  Read: "read",
  Grep: "read",
  Glob: "read",
  ToolSearch: "read",
  LS: "read",
  WebFetch: "read",
  WebSearch: "read",
  Bash: "run",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
};

export const categoryOf = (name: string): ToolCategory => TOOL_CATEGORY[name] ?? "other";

export interface ActivityCounts {
  read: number;
  run: number;
  edit: number;
  other: number;
}

export type Block =
  | { kind: "prompt"; line: PromptLine }
  | { kind: "thinking"; turnId: TurnId; text: string; collapsed: boolean; streaming: boolean }
  | { kind: "text"; turnId: TurnId; blockIx: number; text: string; streaming: boolean }
  | {
      kind: "activity";
      turnId: TurnId;
      key: string;
      tools: readonly ToolLine[];
      counts: ActivityCounts;
      current: ToolLine | null;
      running: boolean;
      durationMs: number | null;
      startedAt: string;
    }
  | { kind: "end"; turnId: TurnId; outcome: "interrupted" | "error" | "orphaned"; error: string | null }
  | { kind: "note"; text: string };

interface Draft {
  block: Block;
  /** The activity block's own array, still open for appends. Shared by reference with block.tools. */
  tools: ToolLine[] | null;
}

/**
 * Only the turn's last activity block is live: an earlier one has already
 * been closed off by text, so it stops its clock rather than counting until
 * the turn ends.
 */
export function toBlocks(view: ThreadView): readonly Block[] {
  const lines = view.lines;
  const lastTextIx = new Map<TurnId, number>();
  const endUsage = new Map<TurnId, Usage | null>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind === "text") lastTextIx.set(l.turnId, i);
    if (l.kind === "end") endUsage.set(l.turnId, l.usage);
  }

  const drafts: Draft[] = [];
  const activityCount = new Map<TurnId, number>();
  const isLastLine = (i: number): boolean => i === lines.length - 1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const open = l.kind !== "prompt" && l.kind !== "note" && view.openTurn === l.turnId;
    switch (l.kind) {
      case "prompt":
        drafts.push({ block: { kind: "prompt", line: l }, tools: null });
        break;
      case "thinking":
        drafts.push({
          block: {
            kind: "thinking",
            turnId: l.turnId,
            text: l.text,
            collapsed: !open || (lastTextIx.get(l.turnId) ?? -1) > i,
            streaming: open && isLastLine(i),
          },
          tools: null,
        });
        break;
      case "text":
        drafts.push({ block: { kind: "text", turnId: l.turnId, blockIx: l.blockIx, text: l.text, streaming: open && isLastLine(i) }, tools: null });
        break;
      case "tool": {
        const tail = drafts[drafts.length - 1];
        if (tail?.tools && tail.block.kind === "activity" && tail.block.turnId === l.turnId) {
          tail.tools.push(l);
          break;
        }
        activityCount.set(l.turnId, (activityCount.get(l.turnId) ?? 0) + 1);
        const tools = [l];
        drafts.push({
          block: { kind: "activity", turnId: l.turnId, key: `${l.turnId}:act:${i}`, tools, counts: emptyCounts(), current: null, running: false, durationMs: null, startedAt: l.startedAt },
          tools,
        });
        break;
      }
      case "end":
        if (l.outcome !== "ok") drafts.push({ block: { kind: "end", turnId: l.turnId, outcome: l.outcome, error: l.error }, tools: null });
        break;
      case "note":
        drafts.push({ block: { kind: "note", text: l.text }, tools: null });
        break;
    }
  }

  const tailActivity = findLast(drafts, (d) => d.block.kind === "activity")?.block;
  for (const d of drafts) {
    if (d.block.kind !== "activity") continue;
    const b = d.block;
    b.counts = count(b.tools);
    b.running = view.openTurn === b.turnId && b === tailActivity;
    b.current = b.running ? (findLast(b.tools, (t) => t.endedAt === null) ?? null) : null;
    b.durationMs = b.running ? null : finishedDuration(b, endUsage.get(b.turnId) ?? null, activityCount.get(b.turnId) === 1);
  }

  return drafts.map((d) => d.block);
}

const emptyCounts = (): ActivityCounts => ({ read: 0, run: 0, edit: 0, other: 0 });

function count(tools: readonly ToolLine[]): ActivityCounts {
  const c = emptyCounts();
  for (const t of tools) c[categoryOf(t.name)] += 1;
  return c;
}

function findLast<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return items[i];
  return undefined;
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
export function toolDiff(tool: ToolLine): { file: string; lines: readonly DiffLine[] } | null {
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

export const jumpCount = (blocks: readonly Block[], seenCount: number): number => Math.max(0, blocks.length - seenCount);
