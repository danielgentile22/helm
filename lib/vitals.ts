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
