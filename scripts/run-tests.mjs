#!/usr/bin/env node
// Run every test suite, continue past failures, print a per-suite summary,
// exit non-zero if any failed. Run one suite directly with e.g.
// `npx tsx scripts/test-router.ts` or `python3 feeds/test_calendar_agenda.py`.

import { spawnSync } from "node:child_process";

const NODE_CHECKS = ["runner/runner.js", "runner/notify.js", "runner/fleet.js"];
const TS_SUITES = [
  "test-security", "test-todos", "test-router", "test-skill-contract",
  "test-runner", "test-vault", "test-demo-vault", "test-tabs", "test-tz",
  "test-status", "test-fleet", "test-callouts", "test-notify", "test-vitals",
  "test-core", "test-audio", "test-deck", "test-obsidian", "test-chat",
  "test-capture", "test-voiceclient",
];
const PY_SUITES = [
  "voice-server/test_server.py", "feeds/test_claude_tokens.py",
  "feeds/test_job_applications.py", "feeds/test_morphy_github.py",
  "feeds/test_uscf_rating.py", "feeds/test_calendar_agenda.py",
];

const suites = [
  ...NODE_CHECKS.map((f) => ({ name: `node --check ${f}`, cmd: "node", args: ["--check", f] })),
  ...TS_SUITES.map((s) => ({ name: s, cmd: "npx", args: ["tsx", `scripts/${s}.ts`] })),
  ...PY_SUITES.map((f) => ({ name: f, cmd: "python3", args: [f] })),
];

const failed = [];
for (const { name, cmd, args } of suites) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  const ok = r.status === 0;
  if (!ok) failed.push(name);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

console.log(`\n${suites.length - failed.length}/${suites.length} suites passed`);
if (failed.length) {
  console.log(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
