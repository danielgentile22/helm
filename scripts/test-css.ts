// Stylesheet contract sweep — guards against the exact regression class of the
// v2 rewrite (review #44/#93): kept components emitting classes globals.css no
// longer styles, and orphaned selectors implying markup that no longer exists.
// String checks only — cheap, no CSS parser.
// Run: npx -y tsx scripts/test-css.ts
import fs from "node:fs";
import path from "node:path";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

const css = fs.readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf-8");

// classes the kept lab/prototype components emit — must stay styled
for (const sel of [
  ".lab {",
  ".lab-canvas",
  ".lab-grid",
  ".lab-tile",
  ".lab-tile.is-solo",
  ".lab-tile.is-hidden",
  ".lab-label",
  ".ember-core",
  ".dither-core",
  ".bg-vignette",
  ".core-fault",
]) {
  check(css.includes(sel), `kept selector present: ${sel.replace(" {", "")}`);
}

// solo culling depends on is-hidden actually collapsing the tile
check(/\.lab-tile\.is-hidden\s*\{\s*display:\s*none/.test(css), ".lab-tile.is-hidden collapses (display: none)");

// pre-v2 orphans stay dead — no component emits these
for (const sel of [".panel-head", ".panel-title", ".panel-tick", ".grid-4", ".span-2"]) {
  check(!css.includes(sel), `orphaned selector absent: ${sel}`);
}

console.log(failed === 0 ? `\nAll css checks pass.` : `\n${failed} css check(s) failed.`);
process.exit(failed ? 1 : 0);
