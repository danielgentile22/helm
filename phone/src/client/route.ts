/** The route as data. Pure, so it is testable without a browser. */

import type { ThreadId } from "../shared/protocol";

export type Route = { name: "list" } | { name: "thread"; threadId: ThreadId } | { name: "enroll"; token: string } | { name: "login" };

export function parseRoute(pathname: string, search: string): Route {
  const t = pathname.match(/^\/t\/([a-f0-9-]{8,40})$/i);
  if (t) return { name: "thread", threadId: t[1] as ThreadId };
  if (pathname === "/enroll") return { name: "enroll", token: new URLSearchParams(search).get("token") ?? "" };
  if (pathname === "/login") return { name: "login" };
  return { name: "list" };
}
