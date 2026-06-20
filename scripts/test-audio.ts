// Audio meter sweep — levelToBars(level, n) shapes an amplitude 0..1 into n
// VU bar heights: center-weighted, monotonic in level, resting at a floor.
// Pure math, no DOM, no I/O. Run: npx -y tsx scripts/test-audio.ts
import { levelToBars, METER_FLOOR } from "../lib/audio";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const near = (a: number, b: number, msg: string) =>
  check(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

// --- length ----------------------------------------------------------------
check(levelToBars(0.5, 12).length === 12, "returns exactly n bars");
check(levelToBars(0.5, 37).length === 37, "returns n bars for the HUD's 37");
check(levelToBars(0.5, 0).length === 0, "n=0 → empty array");
check(levelToBars(0.5, -3).length === 0, "negative n → empty array");

// --- level 0 → floor -------------------------------------------------------
const rest = levelToBars(0, 9);
check(rest.every((b) => b === METER_FLOOR), "level 0 → every bar at the floor");
check(rest.every((b) => b === rest[0]), "level 0 → flat row (all equal)");

// --- level 1 → center peak -------------------------------------------------
const full = levelToBars(1, 9); // odd n → a true center column
near(full[4], 1, "level 1 → center column peaks at 1");
check(Math.max(...full) === full[4], "the peak IS the center column");

// --- center-weighted + symmetric -------------------------------------------
const mid = levelToBars(0.7, 11);
const c = (mid.length - 1) / 2;
check(mid[c] >= mid[0] && mid[c] >= mid[mid.length - 1], "center stands above the edges");
check(
  mid.every((b, i) => Math.abs(b - mid[mid.length - 1 - i]) < 1e-9),
  "row is left/right symmetric"
);
// heights fall (never rise) walking from the center out to an edge
let taper = true;
for (let i = c; i < mid.length - 1; i++) if (mid[i + 1] > mid[i] + 1e-12) taper = false;
check(taper, "bars taper monotonically from center to edge");

// --- monotonic in level ----------------------------------------------------
const lo = levelToBars(0.2, 15);
const midL = levelToBars(0.55, 15);
const hi = levelToBars(0.9, 15);
check(
  lo.every((b, i) => b <= midL[i] + 1e-12 && midL[i] <= hi[i] + 1e-12),
  "every bar is non-decreasing as level rises"
);

// --- clamping --------------------------------------------------------------
check(
  levelToBars(-1, 8).every((b) => b === METER_FLOOR),
  "level below 0 clamps to the floor"
);
check(
  levelToBars(5, 8).every((b, i) => Math.abs(b - levelToBars(1, 8)[i]) < 1e-9),
  "level above 1 clamps to the level-1 shape"
);

// --- output stays a valid 0..1 height --------------------------------------
for (const lv of [0, 0.13, 0.5, 0.87, 1]) {
  const ok = levelToBars(lv, 24).every((b) => b >= 0 && b <= 1);
  check(ok, `levelToBars(${lv}) heights all within [0,1]`);
}

// --- summary ----------------------------------------------------------------
console.log(failed === 0 ? `\nAll audio checks pass.` : `\n${failed} audio check(s) failed.`);
process.exit(failed ? 1 : 0);
