import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// CHAT_ONLY=1 (set in the Fly image): the deployed VM is documented as
// chat-only, so make that true — every API route except /api/chat and
// /api/key 404s. Without this the "chat-only" image shipped the full write
// surface (/api/queue, /api/voice*), whose intents Syncthing carried back to
// the Mac runner. Keep this file edge-safe: no fs, no lib/ imports.
// ---------------------------------------------------------------------------

export function blockedInChatOnly(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  return !(
    pathname === "/api/chat" ||
    pathname.startsWith("/api/chat/") ||
    pathname === "/api/key"
  );
}

export function middleware(req: NextRequest) {
  if (process.env.CHAT_ONLY === "1" && blockedInChatOnly(req.nextUrl.pathname)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
