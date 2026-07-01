// Pure helpers for the System Vitals tiles. Kept out of the HUD component so a
// plain tsx test can import them without pulling in React/three.

/**
 * Progress of a value within a floor→goal band, as a 0–100 percentage.
 *
 * Below the floor reads 0; at or above the goal reads 100; in between it's
 * linear. The floor is what keeps the bar honest: a 1545 rating heading for
 * 1600 is 86% of the way up from a 1200 floor — not the 97% you'd get by
 * measuring from zero, which would pin every bar near full.
 *
 * A non-positive band (goal ≤ floor — a misconfiguration) degrades to a plain
 * threshold: 100 once value reaches the goal, 0 otherwise.
 */
export function ratingProgress(value: number, goal = 1600, floor = 1200): number {
  const band = goal - floor;
  if (!(band > 0)) return value >= goal ? 100 : 0;
  const pct = ((value - floor) / band) * 100;
  return Math.max(0, Math.min(100, pct));
}

// ---------------------------------------------------------------------------
// Stat-tile prop derivation — maps a metric onto the props a Halo stat tile
// renders. Every metric surface (Job apps, USCF, Morphy, Claude tokens) goes
// through this so tone, trend, and sparkline are consistent and testable.
// ---------------------------------------------------------------------------

/** Halo signal tone — drives the tile's top hairline, spark, and trend chip. */
export type Tone = "primary" | "success" | "warning" | "info" | "danger" | "neutral";

/** abbreviate a number for a tile value (1234 → "1.2K"); raw keeps it exact
 *  (a chess rating shows "1545", never "1.5K"). */
export function fmtMetric(n: number, raw = false): string {
  if (raw) return String(Math.round(n));
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + "K";
  if (Math.abs(n) >= 1_000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

export interface StatTileInput {
  value: number;
  history: { value: number }[];
  /** weekly delta vs the oldest point in the window; null = not enough history */
  deltaWeek: number | null;
}

export interface StatTileOpts {
  raw?: boolean; // exact integer, no abbreviation
  goal?: number; // opt into a progress-to-goal bar
  floor?: number;
  /** for metrics where a falling value is the win (e.g. open TODOs) */
  invertTrend?: boolean;
  /** unit suffix appended to the trend label ("/wk" by default) */
  per?: string;
}

export interface StatTileData {
  value: string; // formatted display value
  spark: number[]; // sparkline points, oldest → newest
  tone: Tone; // overall tile tone
  trend: { dir: "up" | "down" | "flat"; label: string; tone: Tone } | null;
  goalPct: number | null; // progress bar fill, or null when no goal set
}

/**
 * Project a metric onto stat-tile props.
 *
 * Trend tone follows the weekly delta: up is `success`, down is `danger`,
 * flat is `neutral` — flipped by `invertTrend` for "less is better" metrics.
 * The tile tone echoes the trend (or `primary` when there's no trend yet).
 * A `goal` opts the tile into the floor→goal progress bar via ratingProgress.
 */
export function statTileProps(m: StatTileInput, opts: StatTileOpts = {}): StatTileData {
  const spark = m.history.map((h) => h.value);
  const per = opts.per ?? "/wk";

  let trend: StatTileData["trend"] = null;
  const dw = m.deltaWeek;
  if (dw !== null) {
    const dir = dw > 0 ? "up" : dw < 0 ? "down" : "flat";
    const good = opts.invertTrend ? dw < 0 : dw > 0;
    const tone: Tone = dw === 0 ? "neutral" : good ? "success" : "danger";
    const label =
      dw === 0
        ? `steady ${per}`.trim()
        : `${dir === "up" ? "▲" : "▼"} ${fmtMetric(Math.abs(dw), opts.raw)} ${per}`.trim();
    trend = { dir, label, tone };
  }

  const goalPct = opts.goal != null ? ratingProgress(m.value, opts.goal, opts.floor) : null;

  return {
    value: fmtMetric(m.value, opts.raw),
    spark,
    tone: trend?.tone ?? "primary",
    trend,
    goalPct,
  };
}
