// Vitals helper sweep — ratingProgress(value, goal, floor) maps a value onto a
// floor→goal band as a clamped 0–100 percentage. Pure math, no DOM, no I/O.
// Run: npx -y tsx scripts/test-vitals.ts
import { ratingProgress, statTileProps, fmtMetric } from "../lib/vitals";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
// percentages compared with a small epsilon to dodge float dust
const near = (a: number, b: number, msg: string) =>
  check(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

// --- the canonical case from the acceptance criteria -----------------------
near(ratingProgress(1545, 1600, 1200), 86.25, "1545 within 1200→1600 is 86.25%");

// --- clamps ----------------------------------------------------------------
check(ratingProgress(1100, 1600, 1200) === 0, "below the floor clamps to 0");
check(ratingProgress(1200, 1600, 1200) === 0, "exactly at the floor is 0");
check(ratingProgress(1600, 1600, 1200) === 100, "exactly at the goal is 100");
check(ratingProgress(1750, 1600, 1200) === 100, "above the goal clamps to 100");

// --- band interior ---------------------------------------------------------
near(ratingProgress(1400, 1600, 1200), 50, "the band midpoint is 50%");
near(ratingProgress(1300, 1600, 1200), 25, "a quarter up the band is 25%");

// --- defaults (goal 1600, floor 1200) --------------------------------------
near(ratingProgress(1545), 86.25, "defaults match goal 1600 / floor 1200");
check(ratingProgress(1199) === 0, "default floor clamps a sub-1200 value to 0");

// --- degenerate / misconfigured bands --------------------------------------
check(ratingProgress(1500, 1500, 1500) === 100, "zero-width band: at goal → 100");
check(ratingProgress(1499, 1500, 1500) === 0, "zero-width band: below goal → 0");
check(ratingProgress(1500, 1400, 1600) === 100, "inverted band (goal<floor): at/above goal → 100");
check(ratingProgress(1300, 1400, 1600) === 0, "inverted band (goal<floor): below goal → 0");

// --- output is always a valid percentage -----------------------------------
for (const v of [0, 1200, 1234, 1545, 1600, 9999]) {
  const p = ratingProgress(v);
  check(p >= 0 && p <= 100, `ratingProgress(${v}) stays within [0,100] (got ${p})`);
}

// --- statTileProps: value formatting ---------------------------------------
check(fmtMetric(1545, true) === "1545", "raw value keeps a rating exact");
check(fmtMetric(1545) === "1.5K", "non-raw value abbreviates thousands");
check(fmtMetric(42) === "42", "small values pass through");

const hist = (vals: number[]) => vals.map((v) => ({ value: v }));

// --- statTileProps: sparkline point extraction -----------------------------
{
  const d = statTileProps({ value: 7, history: hist([3, 5, 7]), deltaWeek: 4 });
  check(JSON.stringify(d.spark) === JSON.stringify([3, 5, 7]), "spark = the history values in order");
}

// --- statTileProps: positive trend → success -------------------------------
{
  const d = statTileProps({ value: 12, history: hist([8, 10, 12]), deltaWeek: 4 });
  check(d.trend?.dir === "up", "positive delta trends up");
  check(d.trend?.tone === "success", "up trend is success-toned");
  check(d.tone === "success", "tile tone echoes the trend");
  check(d.trend?.label.includes("▲"), "up label carries the up glyph");
}

// --- statTileProps: negative trend → danger --------------------------------
{
  const d = statTileProps({ value: 8, history: hist([12, 10, 8]), deltaWeek: -4 });
  check(d.trend?.dir === "down" && d.trend?.tone === "danger", "negative delta trends down + danger");
  check(d.trend?.label.includes("▼"), "down label carries the down glyph");
}

// --- statTileProps: zero trend → neutral steady ----------------------------
{
  const d = statTileProps({ value: 10, history: hist([10, 10, 10]), deltaWeek: 0 });
  check(d.trend?.dir === "flat" && d.trend?.tone === "neutral", "zero delta is flat + neutral");
  check(d.trend?.label.includes("steady"), "flat label reads steady");
}

// --- statTileProps: invertTrend (less is better) ---------------------------
{
  const d = statTileProps({ value: 2, history: hist([5, 3, 2]), deltaWeek: -3 }, { invertTrend: true });
  check(d.trend?.tone === "success", "a falling inverted metric is good (success)");
}

// --- statTileProps: no history yet → no trend ------------------------------
{
  const d = statTileProps({ value: 5, history: hist([5]), deltaWeek: null });
  check(d.trend === null, "null weekly delta yields no trend");
  check(d.tone === "primary", "trendless tile defaults to primary tone");
}

// --- statTileProps: USCF goal path via ratingProgress ----------------------
{
  const d = statTileProps(
    { value: 1545, history: hist([1500, 1520, 1545]), deltaWeek: 45 },
    { raw: true, goal: 1600, floor: 1200 }
  );
  check(d.value === "1545", "USCF tile shows the exact rating");
  check(d.goalPct !== null && Math.abs(d.goalPct - 86.25) < 1e-9, "goal bar uses ratingProgress (86.25%)");
}
check(statTileProps({ value: 5, history: hist([5]), deltaWeek: null }).goalPct === null, "no goal → no bar");

// --- summary ----------------------------------------------------------------
console.log(failed === 0 ? `\nAll vitals checks pass.` : `\n${failed} vitals check(s) failed.`);
process.exit(failed ? 1 : 0);
