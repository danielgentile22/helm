"use client";

// Chess — a read-only dashboard. No skills yet; this tab tracks the 1600 USCF
// goal. The rating renders as a Halo stat tile with a progress-to-goal bar,
// next to the curated tournament log from Atlas (issue #43).
import { useShell } from "@/components/shell/ShellContext";
import { statTileProps } from "@/lib/vitals";
import type { Metric } from "@/lib/vault";
import StatTile from "@/components/StatTile";
import AtlasNote from "@/components/panels/AtlasNote";
import { fmtAge } from "@/components/panels/util";

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

const GOAL = 1600;
const FLOOR = 1200;

export default function ChessPage() {
  const { state } = useShell();
  const rating = state ? findMetric(state.metrics, "uscf", "rating") : null;

  return (
    <div className="tab-page">
      <div className="tab-head">
        <h1 className="tab-title">Chess</h1>
        <p className="tab-sub">directive #3 · 1600 USCF — read-only for now</p>
      </div>

      <div className="tab-grid grid-3">
        {rating ? (
          <StatTile
            size="lg"
            label="USCF Rating"
            {...statTileProps(rating, { raw: true, goal: GOAL, floor: FLOOR })}
            goalLabel={String(GOAL)}
            foot={`${Math.max(0, GOAL - rating.value)} to go`}
            stale={fmtAge(rating.timestamp).stale}
          />
        ) : (
          <section className="panel">
            <div className="tab-sub">No rating yet — the feed populates uscf:rating.</div>
          </section>
        )}
      </div>

      <AtlasNote path="Atlas/Areas/Chess - Tournament Log.md" title="Tournament Log" />
    </div>
  );
}
