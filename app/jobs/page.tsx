"use client";

// Job search — a read-only dashboard. No skills yet (they come later when one
// is defined); this tab makes the SWE-search directive visible and invites
// building those skills. Application counts as Halo stat tiles.
import { useShell } from "@/components/shell/ShellContext";
import { statTileProps } from "@/lib/vitals";
import type { Metric } from "@/lib/vault";
import StatTile from "@/components/StatTile";
import { fmtAge } from "@/components/panels/util";

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

export default function JobsPage() {
  const { state } = useShell();
  const apps = state ? findMetric(state.metrics, "jobs", "applications") : null;
  const week = state ? findMetric(state.metrics, "jobs", "applied_7d") : null;

  return (
    <div className="tab-page">
      <div className="tab-head">
        <h1 className="tab-title">Job Search</h1>
        <p className="tab-sub">directive #1 · SWE role — read-only for now</p>
      </div>

      <div className="tab-grid grid-3">
        {apps && (
          <StatTile
            label="Applications"
            {...statTileProps(apps, { raw: true })}
            foot={`${week?.value ?? 0} this week`}
            stale={fmtAge(apps.timestamp).stale}
          />
        )}
        {week && (
          <StatTile
            label="Applied · 7d"
            value={week.value}
            tone={week.value > 0 ? "success" : "neutral"}
            spark={week.history.map((h) => h.value)}
            foot="applications this week"
            stale={fmtAge(week.timestamp).stale}
          />
        )}
      </div>

      {!apps && !week && (
        <section className="panel">
          <div className="tab-sub">No job metrics yet — the feed populates jobs:applications / jobs:applied_7d.</div>
        </section>
      )}
    </div>
  );
}
