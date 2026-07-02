import { NextResponse } from "next/server";
import { checkHelmKey } from "@/lib/auth";
import { ALLOWED_SKILLS, writeIntent } from "@/lib/skills";

// ---------------------------------------------------------------------------
// POST /api/queue {skill} — drops an intent JSON into system/queue/.
// The runner daemon picks it up from system/queue/ within seconds.
// This is the "buttons are real" part. Skill list + intent
// shape live in lib/skills.ts (shared with /api/voice).
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = checkHelmKey(req.headers.get("x-helm-key"));
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });

  let body: { skill?: string; args?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const skill = String(body.skill ?? "");
  if (!ALLOWED_SKILLS.has(skill)) {
    return NextResponse.json({ error: `unknown skill: ${skill}` }, { status: 400 });
  }

  // args carry skill input (e.g. morphy-task-add's title). Only accept a plain
  // object — the deck sends {} for arg-less skills.
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};

  try {
    const id = writeIntent(skill, "vault-hud", args);
    return NextResponse.json({ ok: true, id, skill });
  } catch (e) {
    console.error("[/api/queue]", e); // detail stays server-side — String(e) leaks vault paths
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
