/** The route as data. Pure, so it is testable without a browser. */

import type { Seq, ThreadId } from "../shared/protocol";

export type Route = { name: "list" } | { name: "thread"; threadId: ThreadId } | { name: "enroll"; token: string } | { name: "login" } | { name: "settings" };

export function parseRoute(pathname: string, search: string): Route {
  const t = pathname.match(/^\/t\/([a-f0-9-]{8,40})$/i);
  if (t) return { name: "thread", threadId: t[1] as ThreadId };
  if (pathname === "/enroll") return { name: "enroll", token: new URLSearchParams(search).get("token") ?? "" };
  if (pathname === "/login") return { name: "login" };
  if (pathname === "/settings") return { name: "settings" };
  return { name: "list" };
}

/** What a thread URL's fragment asks the screen to do once the replay is complete. */
export type Landing = { at: "end" } | { at: "seq"; seq: Seq };

export function parseLanding(hash: string): Landing | null {
  if (hash === "#end") return { at: "end" };
  const m = hash.match(/^#seq=(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? { at: "seq", seq: n as Seq } : null;
}
