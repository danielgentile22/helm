import { NextResponse } from "next/server";
import { homeEnv } from "@/lib/homeEnv";

// GET /api/key — hands the HUD's own pages the X-HELM-KEY value their write
// requests must carry (lib/helmKey.ts fetches this once). Safe to serve:
// cross-origin pages can't read the response (no CORS headers), and the
// server itself is loopback/tailnet-only. On the Fly VM the key only unlocks
// /api/chat — every other mutation is 404'd by the CHAT_ONLY middleware
// (reads pass; they never require the key).

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ key: homeEnv("HELM_API_KEY") ?? "" });
}
