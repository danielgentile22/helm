import { NextResponse } from "next/server";
import { bodyTooLarge, checkHelmKey } from "@/lib/auth";
import { dispatchTranscript } from "@/lib/voiceDispatch";

// ---------------------------------------------------------------------------
// POST /api/voice/text — {transcript} already STT'd by the voice-server wake
// pipeline → shared dispatch (router → maybe queue write → convo memory).
// Same response shape as /api/voice so the client handles both identically.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const key = checkHelmKey(req.headers.get("x-helm-key"));
  if (!key.ok) return NextResponse.json({ error: key.error }, { status: key.status });
  if (bodyTooLarge(req, 16 * 1024)) {
    return NextResponse.json({ error: "transcript too long" }, { status: 413 });
  }

  let transcript = "";
  try {
    const body = (await req.json()) as { transcript?: unknown };
    transcript = String(body.transcript ?? "").trim();
  } catch {
    /* falls through to the 400 */
  }
  if (!transcript) {
    return NextResponse.json({ error: "no transcript" }, { status: 400 });
  }
  if (transcript.length > 1000) {
    return NextResponse.json({ error: "transcript too long" }, { status: 413 });
  }

  try {
    return NextResponse.json(await dispatchTranscript(transcript, "voice-wake"));
  } catch (e) {
    console.error("[/api/voice/text]", e); // detail stays server-side
    return NextResponse.json({ error: "internal error" }, { status: 502 });
  }
}
