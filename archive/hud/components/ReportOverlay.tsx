"use client";

import { obsidianUri, OBSIDIAN_VAULT } from "@/lib/obsidian";
import { mdToHtml } from "@/lib/reportMd";

// ---------------------------------------------------------------------------
// Report reveal overlay — renders a vault markdown deliverable inside the
// HUD (no app switch, stays cinematic). Animates out from the core. Esc or
// the × closes it (HUD owns the Esc handling). The zero-dep renderer lives
// in lib/reportMd.ts (pure, XSS-tested in scripts/test-security.ts).
// ---------------------------------------------------------------------------

export default function ReportOverlay({
  report,
  onClose,
  action,
}: {
  report: { path: string; content: string };
  onClose: () => void;
  /** optional header action (e.g. the transcript's reset button) */
  action?: { label: string; onClick: () => void };
}) {
  const title = report.path.split("/").pop()?.replace(/\.md$/, "") ?? report.path;
  // synthetic docs (e.g. the voice transcript) aren't vault notes — no deep link
  const isVaultNote = report.path.endsWith(".md");
  const obsidianHref = obsidianUri(OBSIDIAN_VAULT, report.path);
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <span className="report-title">{title}</span>
          <span className="report-path">{report.path}</span>
          {isVaultNote && OBSIDIAN_VAULT && (
            <a className="report-obsidian" href={obsidianHref}>
              open in Obsidian ↗
            </a>
          )}
          {action && (
            <button className="report-obsidian report-action" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          <button className="report-close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="report-body" dangerouslySetInnerHTML={{ __html: mdToHtml(report.content) }} />
      </div>
    </div>
  );
}
