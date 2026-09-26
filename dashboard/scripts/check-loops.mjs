// One clock, enforced rather than asked for. lib/clock.svelte.ts is the only reader of
// wall time, so the server skew correction cannot be bypassed, and nothing runs an
// animation frame or a second poll. Everything else is listed below by the line it is
// allowed on. A comment saying so does not hold; this does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const RULES = [
  { token: "Date.now(", owner: "lib/clock.svelte.ts" },
  { token: "requestAnimationFrame(", owner: null },
  { token: "setAnimationLoop(", owner: null },
  { token: "setInterval(", owner: null },
];

// The exceptions, one per line that has to stay where it is.
const ALLOWED = [
  { file: "lib/clock.svelte.ts", token: "setInterval(", holds: "setInterval(() => {" },
  // The beat: a quarter-second tick that runs only while a countdown holds it, so the
  // undo window has no interval of its own.
  { file: "lib/clock.svelte.ts", token: "setInterval(", holds: "beating ??= setInterval(" },
  { file: "lib/snapshot.svelte.ts", token: "setInterval(", holds: "setInterval(poll, POLL_MS)" },
];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

function allowed(rel, token, line) {
  return ALLOWED.some((a) => a.file === rel && a.token === token && line.includes(a.holds));
}

const offenders = [];
for (const path of files(SRC)) {
  const rel = relative(SRC, path).split("\\").join("/");
  const lines = readFileSync(path, "utf8").split("\n");
  for (const rule of RULES) {
    if (rel === rule.owner) continue;
    lines.forEach((line, i) => {
      if (line.includes(rule.token) && !allowed(rel, rule.token, line)) {
        offenders.push({ rel, line: i + 1, token: rule.token, text: line.trim() });
      }
    });
  }
}

if (offenders.length) {
  console.error("FAIL  a clock or a loop outside the one place that owns it:");
  for (const o of offenders) console.error(`      src/${o.rel}:${o.line}  ${o.token}  ${o.text}`);
  console.error("      add the line to ALLOWED in scripts/check-loops.mjs if it belongs there.");
  process.exit(1);
}
for (const rule of RULES) {
  const where = rule.owner === null ? "only on its allowed lines" : `only in src/${rule.owner}`;
  console.log(`PASS  ${rule.token} ${where}`);
}
