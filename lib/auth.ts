import { timingSafeEqual } from "node:crypto";
import { homeEnv } from "./homeEnv";

// ---------------------------------------------------------------------------
// Write-route guard — every state-changing route (/api/queue, /api/voice,
// /api/voice/text, /api/chat, /api/todos POST, /api/transcript DELETE) requires
// X-HELM-KEY to equal HELM_API_KEY (from ~/.claude/.env). This is the CSRF /
// LAN-peer wall in front of the runner's `claude -p --dangerously-skip-
// permissions` executor: a drive-by web page can't read the key (same-origin
// policy blocks it from /api/key) and can't preflight a custom header.
// Pure logic here, unit-tested in scripts/test-security.ts; routes add the
// two-line NextResponse glue.
// ---------------------------------------------------------------------------

export type KeyCheck = { ok: true } | { ok: false; status: number; error: string };

export function checkHelmKey(
  header: string | null,
  expected: string | undefined = homeEnv("HELM_API_KEY")
): KeyCheck {
  // fail CLOSED: no configured key means no writes, not open season
  if (!expected) return { ok: false, status: 503, error: "HELM_API_KEY not configured" };
  const got = Buffer.from(header ?? "");
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

/** Reject oversized bodies BEFORE buffering them (req.json()/arrayBuffer()
 *  materialize the whole body first, so a post-read length check can't stop
 *  the allocation). Missing/unparseable Content-Length is rejected too —
 *  chunked encoding would otherwise bypass the cap. */
export function bodyTooLarge(req: Request, capBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (!raw) return true; // absent header = chunked = unbounded — Number(null) is 0, don't let it through
  const len = Number(raw);
  return !Number.isFinite(len) || len > capBytes;
}
