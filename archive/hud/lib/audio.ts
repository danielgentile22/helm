// Pure shaping for the Audio I/O meter. Kept out of the HUD component so a plain
// tsx test can import it without React.

/** Resting height of every bar when there's no signal — a calm, even floor so
 *  the meter reads "armed, silent" rather than empty. */
export const METER_FLOOR = 0.08;

/**
 * Shape an amplitude `level` (0..1) into `n` VU-meter bar heights (each 0..1).
 *
 * Center-weighted: the middle bars stand tallest and the row tapers
 * symmetrically toward the edges — the classic VU hill. Every bar is monotonic
 * in `level` (louder never shortens a bar) and rests at METER_FLOOR when level
 * is 0. At level 1 the center column peaks at exactly 1; the edges reach a
 * fraction of that so the shape stays a taper, not a cliff. `level` is clamped.
 */
export function levelToBars(level: number, n: number): number[] {
  if (n <= 0) return [];
  const lvl = Math.max(0, Math.min(1, level));
  const mid = (n - 1) / 2;
  const EDGE = 0.3; // edge bars reach 30% of the center's gain
  const bars: number[] = [];
  for (let i = 0; i < n; i++) {
    // 0 at the center column, 1 at either edge
    const d = mid === 0 ? 0 : Math.abs(i - mid) / mid;
    // smooth bell: 1 at center → 0 at edge
    const bell = 0.5 + 0.5 * Math.cos(d * Math.PI);
    const weight = EDGE + (1 - EDGE) * bell; // EDGE..1
    bars.push(METER_FLOOR + (1 - METER_FLOOR) * lvl * weight);
  }
  return bars;
}
