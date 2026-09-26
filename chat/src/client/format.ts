/** Display formatting. Pure, no DOM. */

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Locale is pinned to en-US so a weekday or month name does not vary by machine. */
export function fmtRelative(iso: string, now: Date): string {
  const d = new Date(iso);
  const secs = (now.getTime() - d.getTime()) / 1000;
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604_800) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Elapsed time as the transcript writes it: 8s, 42s, 1m12s, 1h04m. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
}

export const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const shortModel = (m: string): string => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");

export const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~");

export const uuid = (): string => crypto.randomUUID();
