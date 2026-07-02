// HUD_TZ clock sweep — zonedYMD/zonedMinutes convert the browser's "now" into
// the zone the vault data was written in (review #42: Schedule used to compare
// HUD_TZ agenda rows against the device clock, so the NOW marker and the
// today-check drifted whenever browser tz ≠ HUD_TZ). Pure: imports lib/tz only.
// Run: npx -y tsx scripts/test-tz.ts
import { zonedYMD, zonedMinutes } from "../lib/tz";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// 2026-07-02 03:30 UTC — 23:30 on 07-01 in New York, 05:30 on 07-02 in Berlin.
// The exact instant where a device-clock comparison splits "today" in two.
const t = new Date("2026-07-02T03:30:00Z");

check(zonedYMD(t, "America/New_York") === "2026-07-01", "YMD lands on the HUD_TZ side of midnight");
check(zonedYMD(t, "Europe/Berlin") === "2026-07-02", "YMD tracks the requested zone, not the host");
check(zonedMinutes(t, "America/New_York") === 23 * 60 + 30, "minutes-since-midnight computed in HUD_TZ");
check(zonedMinutes(t, "Europe/Berlin") === 5 * 60 + 30, "minutes differ across zones for the same instant");
check(zonedMinutes(t, "UTC") === 3 * 60 + 30, "UTC sanity");

// midnight edge — h23 must give 00:xx, never 24:xx
const mid = new Date("2026-07-02T04:05:00Z"); // 00:05 in New York
check(zonedMinutes(mid, "America/New_York") === 5, "midnight hour reads as 00, not 24");

// resilience — a bogus/missing zone falls back to the device clock, not a throw
check(typeof zonedYMD(t, "Not/AZone") === "string", "invalid zone falls back instead of throwing");
check(zonedMinutes(t, undefined) === t.getHours() * 60 + t.getMinutes(), "missing zone uses the device clock");

console.log(failed === 0 ? `\nAll tz checks pass.` : `\n${failed} tz check(s) failed.`);
process.exit(failed ? 1 : 0);
