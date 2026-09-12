/**
 * "Doing now": the one line the thread list shows under a thread's title.
 *
 * Pure, and derived from ThreadHead on every read rather than stored, so it
 * cannot disagree with the log. A tool in flight wins over text, because the
 * tool is what the thread is actually blocked on.
 */

import { homedir } from "node:os";
import type { DoingNow, SyncFrame } from "../../shared/protocol";
import type { ThreadHead } from "./log";

/** How much of the tool argument and the text tail the row can fit. */
const ARG_CHARS = 80;
const TAIL_CHARS = 120;

/**
 * Which input field carries the thing a human would name when asked what a
 * tool is doing. A table rather than a switch so a new tool is one row.
 */
const ARG_FIELD: Readonly<Record<string, string>> = {
  Bash: "command",
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  Grep: "pattern",
  Glob: "pattern",
  Agent: "description",
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Collapse runs of whitespace and shorten the home directory, so one row holds as much meaning as it can. */
function tidy(text: string): string {
  return text.replaceAll(homedir(), "~").replace(/\s+/gu, " ").trim();
}

/**
 * The single most identifying argument of a tool call. Falls back to the
 * first string-valued field so an unknown tool (an MCP one, say) still says
 * something, and to "" when nothing in the input is a string.
 */
export function toolArg(name: string, input: unknown): string {
  if (!isRecord(input)) return "";
  const field = ARG_FIELD[name];
  const direct = field === undefined ? undefined : input[field];
  if (typeof direct === "string") return tidy(direct).slice(0, ARG_CHARS);
  for (const v of Object.values(input)) {
    if (typeof v === "string") return tidy(v).slice(0, ARG_CHARS);
  }
  return "";
}

/**
 * A tool counts only while the session is running: in any other state the
 * process is gone and a spinner would be a lie. Text has no such constraint,
 * so a cold thread still shows the last thing it said.
 */
export function doingNow(head: ThreadHead, session: SyncFrame["session"]): DoingNow | null {
  if (session === "running" && head.activeTool) {
    return { kind: "tool", name: head.activeTool.name, arg: toolArg(head.activeTool.name, head.activeTool.input) };
  }
  const text = tidy(head.lastText?.text ?? "");
  if (text === "") return null;
  return { kind: "text", tail: text.slice(-TAIL_CHARS) };
}
