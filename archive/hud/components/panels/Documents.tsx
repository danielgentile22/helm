"use client";

import { useShell } from "@/components/shell/ShellContext";
import { fmtAge, ObsidianLink, pressToActivate, SectionTitle } from "./util";

// Recent deliverables — every run that produced a document, newest first.
export default function Documents() {
  const { state, openReport } = useShell();
  const docs: { path: string; skill: string; ts: string | null }[] = [];
  for (const r of state?.runs ?? []) {
    if (r.status !== "ok" || !r.deliverable_path) continue;
    if (docs.some((d) => d.path === r.deliverable_path)) continue;
    docs.push({ path: r.deliverable_path, skill: r.label ?? r.skill, ts: r.ts_completed });
    if (docs.length >= 5) break;
  }
  if (docs.length === 0) return null;
  return (
    <section className="panel">
      <SectionTitle title="Documents" tick="INBOX.TRAIL" />
      {docs.map((doc) => (
        <div
          className="doc-row"
          key={doc.path}
          role="button"
          tabIndex={0}
          onClick={() => openReport(doc.path)}
          onKeyDown={pressToActivate(() => openReport(doc.path))}
        >
          <span className="doc-skill">{doc.skill.replace(/-/g, " ")}</span>
          <span className="doc-meta">
            <span className="doc-age">{fmtAge(doc.ts).label}</span>
            <ObsidianLink path={doc.path} />
          </span>
        </div>
      ))}
    </section>
  );
}
