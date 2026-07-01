"use client";

import { useShell } from "@/components/shell/ShellContext";
import { SectionTitle } from "./util";

// AI Wire — today's morning-report headlines; a row opens the full report.
export default function Wire() {
  const { state, openReport } = useShell();
  const m = state?.morning;
  if (!m || m.heads.length === 0) return null;
  return (
    <section className="panel">
      <SectionTitle title="AI Wire" tick="MORNING.INTEL" />
      {/* top 3 — keeps the panel tight */}
      {m.heads.slice(0, 3).map((h, i) => (
        <div className="wire-row" key={i} role="button" onClick={() => openReport(m.rel)}>
          <span className="wire-bullet">▸</span>
          <span>{h}</span>
        </div>
      ))}
    </section>
  );
}
