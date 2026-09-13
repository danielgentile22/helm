/**
 * The thread list row: a pure projection of the log head, the thread's config
 * and the live session state. Derived on every read rather than stored, so it
 * cannot disagree with the log.
 */

import { tidy, toolSummary } from "../../shared/protocol";
import type { DoingNow, SyncFrame, ThreadConfig, ThreadSummary } from "../../shared/protocol";
import type { ThreadHead } from "./log";

/** How much text a row can fit: the preview takes the first slice, the doing line the last. */
const ROW_CHARS = 120;

export function threadSummary(head: ThreadHead, config: ThreadConfig, session: SyncFrame["session"]): ThreadSummary {
  return {
    config,
    headSeq: head.lastSeq,
    session,
    lastTurnEndedAt: head.lastTurnEndedAt,
    lastOutcome: head.lastOutcome,
    contextTokens: head.contextTokens,
    preview: preview(head),
    doing: doingNow(head, session),
    usageTotal: head.usageTotal,
    contextWindow: head.contextWindow,
  };
}

function preview(head: ThreadHead): string | null {
  const text = head.lastText?.text.trim().slice(0, ROW_CHARS);
  return text ? text : null;
}

/**
 * A tool counts only while the session is running: in any other state the
 * process is gone and a spinner would be a lie. Text has no such constraint,
 * so a cold thread still shows the last thing it said. A tool in flight wins
 * over text because the tool is what the thread is blocked on.
 */
function doingNow(head: ThreadHead, session: SyncFrame["session"]): DoingNow | null {
  if (session === "running" && head.activeTool) {
    const { label, arg } = toolSummary(head.activeTool.name, head.activeTool.input);
    return { kind: "tool", name: label, arg };
  }
  const text = tidy(head.lastText?.text ?? "");
  if (text === "") return null;
  return { kind: "text", tail: text.slice(-ROW_CHARS) };
}
