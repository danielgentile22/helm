/**
 * Id minting and boundary parsing. Salvaged idea: a client may mint the
 * thread id so create + first send are safely retriable; the server accepts
 * it if it looks like a UUID-ish token, else mints one.
 */

import { randomUUID } from "node:crypto";
import type { ClientMsgId, Seq, ThreadId, TurnId } from "../../shared/protocol";

const ID_RE = /^[a-f0-9-]{8,40}$/i;

export function resolveThreadId(raw: unknown): ThreadId {
  return (typeof raw === "string" && ID_RE.test(raw) ? raw : randomUUID()) as ThreadId;
}

/** Strict: a bad client message id is a 400, never silently replaced (it is the idempotency key). */
export function parseClientMsgId(raw: unknown): ClientMsgId | null {
  return typeof raw === "string" && ID_RE.test(raw) ? (raw as ClientMsgId) : null;
}

/** `t:<seq>`; derivable from the log so a TurnId can never dangle. */
export function turnIdFor(seq: Seq): TurnId {
  return `t:${seq}` as TurnId;
}

export function parseCursor(raw: string | null): { ok: true; after: Seq | 0 } | { ok: false } {
  if (raw === null || raw === "") return { ok: true, after: 0 };
  if (!/^\d+$/.test(raw)) return { ok: false };
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? { ok: true, after: n as Seq | 0 } : { ok: false };
}
