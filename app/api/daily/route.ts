import { NextResponse } from "next/server";
import { checkHelmKey } from "@/lib/auth";
import { toggleTop3 } from "@/lib/vault";

// POST /api/daily {index, done} — flip a Top 3 checkbox in TODAY's note.
// The HUD's Directives panel calls this; stale notes are read-only.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = checkHelmKey(req.headers.get("x-helm-key"));
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });

  let body: { index?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const index = Number(body.index);
  // the daily-note parser only recognizes the three Top 3 checkboxes
  if (!Number.isInteger(index) || index < 0 || index > 2 || typeof body.done !== "boolean") {
    return NextResponse.json({ error: "need {index: 0-2, done: boolean}" }, { status: 400 });
  }
  const ok = toggleTop3(index, body.done);
  if (!ok) {
    return NextResponse.json({ error: "no matching checkbox in today's note" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
