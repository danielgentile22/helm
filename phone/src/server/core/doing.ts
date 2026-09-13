/**
 * "Doing now": the one line the thread list shows under a thread's title.
 *
 * Pure, and derived from ThreadHead on every read rather than stored, so it
 * cannot disagree with the log. A tool in flight wins over text, because the
 * tool is what the thread is actually blocked on.
 */

import { toolSummary } from "../../shared/protocol";
import type { DoingNow, SyncFrame } from "../../shared/protocol";
import type { ThreadHead } from "./log";

/** How much of the text tail the row can fit. */
const TAIL_CHARS = 120;

/** Collapse runs of whitespace and shorten the home directory, so one row holds as much meaning as it can. */
function tidy(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(/\/(?:Users|home)\/[^/]+/gu, "~");
}

/**
 * A tool counts only while the session is running: in any other state the
 * process is gone and a spinner would be a lie. Text has no such constraint,
 * so a cold thread still shows the last thing it said.
 */
export function doingNow(head: ThreadHead, session: SyncFrame["session"]): DoingNow | null {
  if (session === "running" && head.activeTool) {
    return { kind: "tool", name: head.activeTool.name, arg: toolSummary(head.activeTool.name, head.activeTool.input).arg };
  }
  const text = tidy(head.lastText?.text ?? "");
  if (text === "") return null;
  return { kind: "text", tail: text.slice(-TAIL_CHARS) };
}
