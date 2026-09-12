/** Display formatting. Pure, no DOM. */

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const shortModel = (m: string): string => m.replace(/^claude-/, "").replace(/-\d{8}$/, "");

export const shortPath = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~");

export function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.query ?? o.url ?? o.description ?? "";
  return typeof v === "string" ? shortPath(v).slice(0, 80) : "";
}

export const uuid = (): string => crypto.randomUUID();
