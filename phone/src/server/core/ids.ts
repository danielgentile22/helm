/**
 * Id minting and boundary parsing. Salvaged idea: a client may mint the
 * thread id so create + first send are safely retriable; the server accepts
 * it if it looks like a UUID-ish token, else mints one.
 */

import type { ClientMsgId, Seq, ThreadId, TurnId } from "../../shared/protocol";

const ID_RE = /^[a-f0-9-]{8,40}$/i;

export function resolveThreadId(raw: unknown): ThreadId {
  // TODO: typeof raw === "string" && ID_RE.test(raw) ? raw : randomUUID()
  throw new Error("not implemented");
}

/** Strict: a bad client message id is a 400, never silently replaced (it is the idempotency key). */
export function parseClientMsgId(raw: unknown): ClientMsgId | null {
  throw new Error("not implemented");
}

/** `t:<seq>`; derivable from the log so a TurnId can never dangle. */
export function turnIdFor(seq: Seq): TurnId {
  throw new Error("not implemented");
}

export function parseCursor(raw: string | null): { ok: true; after: Seq | 0 } | { ok: false } {
  // TODO: "" | null -> 0; else Number.isSafeInteger && >= 0
  throw new Error("not implemented");
}
