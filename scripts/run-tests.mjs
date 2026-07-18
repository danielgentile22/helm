#!/usr/bin/env node
// Run every test suite, continue past failures, print a per-suite summary,
// exit non-zero if any failed. Run one suite directly with e.g.
// `npx tsx scripts/test-router.ts` or `python3 feeds/test_calendar_agenda.py`.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Discovered, never listed — a new test-*.ts / test_*.py runs the moment it
// exists. Paths are relative to the repo root so `npm test` works from anywhere.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const find = (dir, re) =>
  readdirSync(join(root, dir)).filter((f) => re.test(f)).sort().map((f) => `${dir}/${f}`);

const NODE_CHECKS = find("runner", /\.js$/);
const TS_SUITES = find("scripts", /^test-.*\.ts$/);
const PY_SUITES = [...find("voice-server", /^test_.*\.py$/), ...find("feeds", /^test_.*\.py$/)];

// A glob that silently matches nothing is the failure mode discovery replaced
// hardcoding to avoid — an empty category means the harness is broken, not that
// there's nothing to run.
for (const [what, found] of [["runner/*.js", NODE_CHECKS], ["scripts/test-*.ts", TS_SUITES], ["test_*.py", PY_SUITES]]) {
  if (!found.length) throw new Error(`test discovery found no ${what} — harness broken`);
}

const suites = [
  ...NODE_CHECKS.map((f) => ({ name: `node --check ${f}`, cmd: "node", args: ["--check", f] })),
  ...TS_SUITES.map((f) => ({ name: f, cmd: "npx", args: ["tsx", f] })),
  ...PY_SUITES.map((f) => ({ name: f, cmd: "python3", args: [f] })),
];

const failed = [];
for (const { name, cmd, args } of suites) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  const ok = r.status === 0;
  if (!ok) failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
