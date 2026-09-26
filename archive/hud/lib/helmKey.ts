// ---------------------------------------------------------------------------
// Client-side X-HELM-KEY — the HUD's own pages fetch the shared secret once
// from /api/key and attach it to every state-changing request (lib/auth.ts is
// the server half). Cross-origin pages can't read /api/key (no CORS headers),
// which is exactly the point.
// ---------------------------------------------------------------------------

let cached: Promise<string> | null = null;

export function helmKey(): Promise<string> {
  cached ??= fetch("/api/key", { cache: "no-store" })
    .then((r) => r.json())
    .then((j) => String(j.key ?? ""))
    .catch(() => {
      cached = null; // transient failure — retry on the next call
      return "";
    });
  return cached;
}
