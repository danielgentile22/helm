// Demo-vault contract sweep (issue #3) — points VAULT_ROOT at a freshened
// copy of the COMMITTED demo vault and asserts every parser the HUD panels
// depend on returns non-empty, well-formed results. Breaking a demo file or
// a parser contract fails `npm test` before a visitor sees an empty HUD.
//
// Run: npx -y tsx scripts/test-demo-vault.ts
import { cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_DEMO = join(__dirname, "..", "demo-vault");
const VAULT = join(tmpdir(), `helm-demo-vault-${process.pid}`);
cpSync(REPO_DEMO, VAULT, { recursive: true });
// lib/config resolves VAULT_ROOT at module load — set it BEFORE the imports
process.env.VAULT_ROOT = VAULT;

let failed = 0;
const check = (cond: unknown, msg: string) =>
  console.log(`${cond ? "PASS" : (failed++, "FAIL")}  ${msg}`);

async function run(): Promise<void> {
  const { freshenDemoVault } = await import("./demo-freshen.mjs");
  const vault = await import("../lib/vault");
  const { parseTodos } = await import("../lib/todos");
  const fs = await import("node:fs");

  const today = vault.todayLocal();
  freshenDemoVault(VAULT, today);
  check(freshenDemoVault(VAULT, today) === 0, "freshen is idempotent (second run shifts 0 days)");

  const state = vault.readVaultState();

  // daily note — today's, fully parsed
  check(state.daily?.isToday === true && state.daily.date === today, "daily note is today's after freshen");
  check((state.daily?.top3.length ?? 0) === 3, "daily note Top 3 parses");
  check((state.daily?.schedule.length ?? 0) >= 2 && !!state.daily?.focus, "daily note schedule + focus parse");

  // metrics — every tile source present, weekly delta computable
  for (const [source, metric] of [
    ["uscf", "rating"],
    ["jobs", "applications"],
    ["jobs", "applied_7d"],
    ["github", "commits_7d"],
    ["claude_code", "pct_5h"],
  ] as const) {
    const m = state.metrics.find((x) => x.source === source && x.metric === metric);
    check(!!m && Number.isFinite(m.value), `metric ${source}:${metric} present`);
  }
  const rating = state.metrics.find((m) => m.source === "uscf" && m.metric === "rating");
  check(typeof rating?.deltaWeek === "number", `uscf rating has a computable weekly delta (got ${rating?.deltaWeek})`);

  // morning report — today's headlines feed the AI Wire
  check((state.morning?.heads.length ?? 0) >= 2, "morning report headlines mined");
  check(state.morning?.links.some((l) => l?.startsWith("https://example.com/")) === true, "headline source links parse");

  // runs — completed records with a readable deliverable
  check(state.runs.length >= 3 && state.runs.every((r) => r.status === "ok"), "completed run records parse");
  const withDeliverable = state.runs.find((r) => r.deliverable_path);
  check(
    !!withDeliverable && !!vault.readVaultMarkdown(withDeliverable.deliverable_path!),
    "a run deliverable is readable through resolveReadable"
  );
  check(Object.keys(state.etas).length >= 1, "skill ETAs computable from demo runs");

  // honest degradation — no faked runner heartbeat, empty queue
  check(state.runner === null, "runner is honestly OFFLINE (no runner-status.json)");
  check(state.queue.length === 0, "queue is empty");

  // caches — agenda (today), morphy board
  check(state.agenda?.ok === true && state.agenda.date === today && state.agenda.events.length >= 3, "agenda is today's with events");
  check(state.morphy?.ok === true && (state.morphy.tasks?.length ?? 0) >= 5, "morphy board cache parses");

  // jobs todos + Atlas tab notes
  const todos = parseTodos(fs.readFileSync(join(VAULT, "jobs", "todos.md"), "utf-8"));
  check(todos.length >= 4 && todos.some((t) => t.done), "jobs/todos.md parses with mixed done states");
  for (const note of ["Atlas/Areas/Chess - Tournament Log.md", "Atlas/Areas/Career - Applications & Roles.md"]) {
    check(!!vault.readVaultMarkdown(note), `tab note readable: ${note}`);
  }

  rmSync(VAULT, { recursive: true, force: true });
  console.log(failed === 0 ? "\nAll demo-vault contract checks passed." : `\n${failed} demo-vault check(s) failed.`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(`test-demo-vault crashed: ${e?.stack || e}`);
  process.exit(1);
});
