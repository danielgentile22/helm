import type { KeyboardEvent } from "react";
import { obsidianUri, OBSIDIAN_VAULT } from "@/lib/obsidian";

// Enter/Space activation for role="button" elements that aren't real <button>s.
// stopPropagation keeps Space from also firing the shell's push-to-talk capture.
export function pressToActivate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // ignore keys bubbling up from nested controls (toast dismiss ×, Obsidian
    // link) — activating the row here would swallow their own Enter/Space
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
}

// relative age of an ISO timestamp; stale = older than two missed 6h pulls
export function fmtAge(ts: string | null): { label: string; stale: boolean } {
  if (!ts) return { label: "—", stale: true };
  const ms = Date.now() - Date.parse(ts);
  if (Number.isNaN(ms)) return { label: "—", stale: true };
  const stale = ms > 13 * 3600 * 1000;
  const m = Math.floor(ms / 60000);
  if (m < 1) return { label: "now", stale };
  if (m < 60) return { label: `${m}m`, stale };
  const h = Math.floor(m / 60);
  if (h < 48) return { label: `${h}h`, stale };
  return { label: `${Math.floor(h / 24)}d`, stale };
}

/** fmtAge as a sentence fragment — "just now" / "3m ago" / "—", never "now ago" */
export function fmtAgo(ts: string | null): string {
  const { label } = fmtAge(ts);
  if (label === "now") return "just now";
  if (label === "—") return "—";
  return `${label} ago`;
}

export function fmtClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function noteAgeDays(date: string): number {
  const ms = Date.now() - Date.parse(`${date}T12:00:00`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

// panel heading — Halo eyebrow, optional monospace tick + external link
export function SectionTitle({ title, tick, href }: { title: string; tick?: string; href?: string }) {
  return (
    <div className="sec-title">
      {href ? (
        <a className="sec-link" href={href} target="_blank" rel="noreferrer">
          {title} ↗
        </a>
      ) : (
        <span>{title}</span>
      )}
      {tick && <span className="tick">{tick}</span>}
    </div>
  );
}

// "open in Obsidian" affordance — a vault deep link beside the in-app overlay.
// Renders nothing without a configured vault or for non-.md targets.
export function ObsidianLink({ path }: { path: string }) {
  if (!OBSIDIAN_VAULT || !path.endsWith(".md")) return null;
  return (
    <a
      className="obsidian-link"
      href={obsidianUri(OBSIDIAN_VAULT, path)}
      title="open in Obsidian"
      aria-label="open in Obsidian"
      onClick={(e) => e.stopPropagation()}
    >
      ⬡
    </a>
  );
}
