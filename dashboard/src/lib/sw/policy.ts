// What the service worker does with a request, decided here and nowhere else. The worker
// entry registers listeners, asks this, and performs the answer; it holds no rule of its own.
//
// The set is closed on purpose. Nothing here defers, queues or retries a write: a failed
// toggle has to surface as a failed toggle, because a todo ticked minutes later by a
// background process is worse than one that visibly did not tick (ADR 0021's write is a PUT
// of desired state, and the person retrying it is the retry).

/** cache-first: the cache wins outright. network-first: the network wins, and the last good
 *  response is the fallback. network-only: nothing is stored and nothing is served from
 *  storage. */
export type Strategy = "cache-first" | "network-first" | "network-only";

export const STRATEGIES: readonly Strategy[] = ["cache-first", "network-first", "network-only"];

const SNAPSHOTS = new Set(["/api/agenda", "/api/projects"]);

/** The document. The server hands back `index.html` for any path whose last segment has no
 *  dot, and for the file by name, so those are one thing here too. The API answers for
 *  itself and the build assets carry their own names, so neither is ever the shell. */
export function isShellDocument(path: string): boolean {
  if (path.startsWith("/api/") || path.startsWith("/auth/") || path.startsWith("/assets/")) return false;
  if (path === "/index.html") return true;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/** Where a response is filed. Every client route is the same `index.html`, so they share one
 *  entry rather than caching a copy of the shell per path the person happened to reload on. */
export function cacheKeyFor(path: string): string {
  return isShellDocument(path) ? "/" : path;
}

export function strategyFor(method: string, path: string): Strategy {
  // The one write. Never cached, never queued, never retried here.
  if (method !== "GET") return "network-only";

  // Hashed build assets. The hash is in the name, so a hit is never the wrong bytes.
  if (path.startsWith("/assets/")) return "cache-first";

  // A snapshot read, and on failure the last successful one, served as itself with its own
  // `produced` stamp intact. The client already classifies freshness at read time (ADR 0020),
  // so a cached snapshot arrives labelled by the machinery that exists rather than by a new
  // offline flag.
  if (SNAPSHOTS.has(path)) return "network-first";

  // Everything else under /api is live or nothing: health, and the todo write's own path.
  // The door is the same: a cached verdict on whether the visitor is signed in is a wrong one.
  if (path.startsWith("/api/") || path.startsWith("/auth/")) return "network-only";

  // The shell. Not hashed, so a stale copy must never win while the server is answering.
  if (isShellDocument(path)) return "network-first";

  // Straight to the network: the icons, the manifest, the worker script itself.
  return "network-only";
}
