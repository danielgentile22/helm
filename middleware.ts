import { NextResponse, type NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// CHAT_ONLY=1 (set in the Fly image): the deployed VM is tailnet-only and must
// never enqueue runner work. The real perimeter line is reads vs. writes, not
// route-by-route — a GET never touches system/queue/, so it can't reach the Mac
// runner. So block only mutations (plus allow /api/chat + /api/key outright);
// safe methods pass, which lets the phone render every tab read-only. Before,
// the "chat-only" image 404'd reads too, leaving the non-chat tabs hollow while
// still shipping the write surface (/api/queue, /api/voice*) that Syncthing
// carried back to the Mac runner. Keep this file edge-safe: no fs, no lib/.
// ---------------------------------------------------------------------------

export function blockedInChatOnly(pathname: string, method = "GET"): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/chat" || pathname.startsWith("/api/chat/") || pathname === "/api/key") return false;
  // Safe (read) methods pass; every mutation 404s.
  return !(method === "GET" || method === "HEAD" || method === "OPTIONS");
}

export function middleware(req: NextRequest) {
  if (process.env.CHAT_ONLY === "1" && blockedInChatOnly(req.nextUrl.pathname, req.method)) {
    return new NextResponse(null, { status: 404 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
