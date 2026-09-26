import type { Tone } from "@/lib/vitals";
import Sparkline from "./Sparkline";

// Halo's signature primitive — eyebrow, mono value, trend chip, inline
// sparkline, and a 2px colored top hairline (the tone). Presentational: the
// caller derives props (usually via statTileProps in lib/vitals). Every metric
// on every tab renders through this so the numbers read consistently.
export default function StatTile({
  label,
  value,
  unit,
  tone = "primary",
  trend,
  spark,
  foot,
  goalPct = null,
  goalLabel,
  size = "md",
  stale = false,
  sim = false,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  tone?: Tone;
  trend?: { label: string; tone: Tone } | null;
  spark?: number[];
  foot?: React.ReactNode;
  goalPct?: number | null;
  goalLabel?: string;
  size?: "sm" | "md" | "lg";
  stale?: boolean;
  sim?: boolean;
}) {
  return (
    <div className={`stat-tile stat-${size} ${stale ? "is-stale" : ""}`} data-tone={tone}>
      <div className="stat-head">
        <span className="stat-eyebrow">{label}</span>
        {sim && <span className="stat-sim">SIM</span>}
      </div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>

      {goalPct !== null && (
        <div className="stat-goal" title={goalLabel}>
          <div className="stat-goal-bar">
            <i style={{ width: `${goalPct}%` }} />
          </div>
          {goalLabel && <span className="stat-goal-tag">{goalLabel}</span>}
        </div>
      )}

      {(trend || spark) && (
        <div className="stat-meta">
          {trend ? (
            <span className="chip" data-tone={trend.tone}>
              {trend.label}
            </span>
          ) : (
            <span />
          )}
          {spark && spark.length > 0 && <Sparkline points={spark} />}
        </div>
      )}

      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}
