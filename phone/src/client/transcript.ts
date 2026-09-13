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

import { answerPhrase, toolSummary } from "../shared/protocol";
import type { ToolUseId, TurnId, Usage } from "../shared/protocol";
import type { AskItem, FileItem, Item, Prompt, ToolItem, Turn } from "../shared/turns";
import { fmtTime } from "./format";
import type { ThreadView } from "./fold";

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
      /** Tool calls this turn denied. Their row reads "denied" rather than "failed". */
      denied: ReadonlySet<ToolUseId>;
    }
  | { kind: "end"; key: string; outcome: "interrupted" | "error" | "orphaned"; error: string | null }
  | { kind: "file"; key: string; file: FileItem }
  /** `live` while the turn is open and nobody has answered: the only state that draws buttons. */
  | { kind: "ask"; key: string; ask: AskItem; live: boolean }
  | { kind: "note"; key: string; text: string };

export interface Section {
  readonly key: string;
  readonly turnId: TurnId | null;
  readonly blocks: readonly Block[];
}

export function toBlocks(view: ThreadView): readonly Section[] {
  return view.turns.map((turn) => ({ key: turn.key, turnId: turn.turnId, blocks: turnBlocks(turn, turn.turnId !== null && turn.turnId === view.openTurn) }));
}

/**
 * Only the turn's last activity block is live: an earlier one has already
 * been closed off by text, so it stops its clock rather than counting until
 * the turn ends.
 */
function turnBlocks(turn: Turn, open: boolean): Block[] {
  const items = turn.items;
  const lastTextIx = items.findLastIndex((i) => i.kind === "text");
  const isLast = (ix: number): boolean => ix === items.length - 1;
  const blocks: Block[] = [];
  const denied = deniedTools(items);
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
        blocks.push({ kind: "activity", key: `${turn.key}:act:${ix}`, tools, counts: emptyCounts(), current: null, running: false, durationMs: null, startedAt: item.startedAt, denied });
        break;
      case "file":
        blocks.push({ kind: "file", key: `file:${item.fileId}`, file: item });
        break;
      case "ask":
        // A decision Claude Code made alone is already on the tool row as "denied"; a card would ask the reader to answer something settled.
        if (item.answer?.by.by === "system" && item.answer.by.reason === "rule") break;
        blocks.push({ kind: "ask", key: `ask:${item.askId}`, ask: item, live: open && item.answer === null });
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
    b.current = b.running ? (b.tools.findLast((t) => t.endedAt === null) ?? null) : null;
    b.durationMs = b.running ? null : finishedDuration(b, turn.end?.usage ?? null, activities.length === 1);
  }
  return blocks;
}

/** Every system answer is a denial, and a denied call reports itself as a failure, so the turn's own asks are what tell a refusal from a crash. */
function deniedTools(items: readonly Item[]): ReadonlySet<ToolUseId> {
  const out = new Set<ToolUseId>();
  for (const item of items) {
    if (item.kind !== "ask" || item.ask.kind !== "tool" || item.answer === null) continue;
    if (item.answer.by.by === "system" || item.answer.answer.kind === "deny") out.add(item.ask.toolUseId);
  }
  return out;
}

/** What the answered card says it did, and who did it. Pure so the wording is pinned by a test. */
export function answerLine(item: AskItem): string {
  const settled = item.answer;
  if (!settled) return "";
  const stamp = fmtTime(settled.ts);
  if (settled.by.by === "system") {
    const reason = settled.answer.kind === "deny" ? settled.answer.reason : null;
    if (settled.by.reason === "rule") return reason ? `Auto-denied by a rule: ${reason} · ${stamp}` : `Auto-denied by a rule · ${stamp}`;
    const words = { interrupted: "interrupted", restart: "server restarted", exited: "Claude Code exited", archived: "archived" }[settled.by.reason];
    return `Expired (${words}) · ${stamp}`;
  }
  const who = settled.by.origin.label;
  switch (settled.answer.kind) {
    case "allow":
      return `Allowed by ${who} · ${stamp}`;
    case "allowTurn":
      return `Allowed for this turn by ${who} · ${stamp}`;
    case "deny":
      return settled.answer.reason ? `Denied by ${who}: ${settled.answer.reason} · ${stamp}` : `Denied by ${who} · ${stamp}`;
    case "answers": {
      const said = settled.answer.answers.map(answerPhrase);
      return `Answered: ${said.join(" · ")} · ${stamp}`;
    }
  }
}

const emptyCounts = (): ActivityCounts => ({ read: 0, run: 0, edit: 0, other: 0 });

function count(tools: readonly ToolItem[]): ActivityCounts {
  const c = emptyCounts();
  for (const t of tools) c[toolSummary(t.name, t.input).category] += 1;
  return c;
}

/**
 * The turn's own reported duration is the honest number when the turn is one
 * stretch of tool calls; once a turn has several activity blocks it would
 * over-count every one of them, so each block times itself from its stamps.
 */
function finishedDuration(block: Extract<Block, { kind: "activity" }>, usage: Usage | null, soleBlock: boolean): number | null {
  if (soleBlock && usage) return usage.durationMs;
  const end = block.tools.findLast((t) => t.endedAt !== null)?.endedAt;
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
