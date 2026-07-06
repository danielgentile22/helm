// Runner reliability sweep — regression tests for the issue-#37 fixes, driving
// the pure/exported pieces of runner/runner.js against a throwaway vault. No
// claude spawns, no real queue writes, no API spend.
//
// Covered fixes: Syncthing conflict-copy filter (isIntentFile), poison-entry
// aging (pickNext), stdout-only spoken summary (summaryFromOutput), deliverable
// verification (runOutcome), run-note frontmatter finalization (finalizeRunMd),
// atomic state writes (writeJson), claim retirement on crash/restart
// (retireClaim), recycled-pid pidfile check (pidLooksLikeRunner), and the
// plan-today prompt path (Atlas/Projects).
//
// Run: npx -y tsx scripts/test-runner.ts
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// runner.js resolves VAULT_ROOT at module load — point it at a throwaway vault
// BEFORE the dynamic import so fixtures land in temp, never the real vault.
const VAULT = join(tmpdir(), `helm-test-runner-${process.pid}`);
process.env.VAULT_ROOT = VAULT;
const QUEUE = join(VAULT, "system", "queue");
const RUNS = join(VAULT, "system", "runs");
mkdirSync(QUEUE, { recursive: true });
mkdirSync(RUNS, { recursive: true });

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

async function run(): Promise<void> {
  const {
    isIntentFile,
    pickNext,
    summaryFromOutput,
    runOutcome,
    finalizeRunMd,
    writeJson,
    retireClaim,
    pidLooksLikeRunner,
    pruneRuns,
    morphyCounts,
    morphySnapshotMd,
    slugify,
    todayDate,
    buildPrompt,
    retryIntent,
    agendaSync,
    STALL_TIMEOUT_MS,
  } = await import("../runner/runner.js");

  // --- isIntentFile: conflict copies and strays never enter the queue --------
  const uuid = randomUUID();
  check(isIntentFile(`${uuid}.json`), "a UUID-named intent file is accepted");
  check(isIntentFile(`${uuid.toUpperCase()}.json`), "UUID match is case-insensitive");
  check(
    !isIntentFile(`${uuid}.sync-conflict-20260701-063012-ABCDEF7.json`),
    "a Syncthing conflict copy is rejected (would re-run a side-effectful skill)"
  );
  check(!isIntentFile("notes.json"), "a non-UUID .json is rejected");
  check(!isIntentFile(`${uuid}.json.claimed`), "a claimed file is not re-enqueued");
  check(!isIntentFile(""), "empty name is rejected");

  // --- summaryFromOutput: spoken line comes from clean stdout ----------------
  check(
    summaryFromOutput("Warning: cli update available\nYour report is ready.") ===
      "Your report is ready.",
    "warning lines are skipped for the spoken summary"
  );
  check(
    summaryFromOutput("\n\n  \nAll done.") === "All done.",
    "leading blank lines are skipped"
  );
  check(summaryFromOutput("") === "(no output)", "empty output falls back to a placeholder");
  check(
    summaryFromOutput("Warning: only warnings here") === "Warning: only warnings here",
    "all-warning output still yields a line rather than nothing"
  );

  // --- runOutcome: exit 0 alone is not success --------------------------------
  check(
    runOutcome(0, "not-written.md").status === "error" && runOutcome(0, "not-written.md").missing,
    "exit 0 with a missing deliverable is an error (no phantom success banner)"
  );
  writeFileSync(join(VAULT, "present.md"), "hi", "utf8");
  check(runOutcome(0, "present.md").status === "ok", "exit 0 with the deliverable on disk is ok");
  check(runOutcome(1, "present.md").status === "error", "non-zero exit is an error");
  check(runOutcome(0, null).status === "ok", "exit 0 with no deliverable expected is ok");

  // --- finalizeRunMd: frontmatter status is finalized, body untouched ---------
  const md =
    "---\nrun_id: x\nskill: plan-today\nstatus: running\nts_started: T0\n---\n\n" +
    "# run\n\n```\necho status: running\n```\n";
  const finalized = finalizeRunMd(md, "ok", "T1");
  check(
    finalized.includes("status: ok\nts_completed: T1"),
    "frontmatter status: running is rewritten with the final status + ts_completed"
  );
  check(
    finalized.includes("echo status: running"),
    "only the frontmatter is rewritten — body occurrences stay"
  );

  // --- writeJson: atomic tmp+rename, no torn reads ----------------------------
  const stateFile = join(VAULT, "state.json");
  writeJson(stateFile, { ok: true, n: 1 });
  check(
    JSON.parse(readFileSync(stateFile, "utf8")).n === 1,
    "writeJson output parses back"
  );
  check(!existsSync(`${stateFile}.tmp`), "writeJson leaves no .tmp behind");

  // --- pickNext: ordering, gating, poison aging -------------------------------
  const f1 = `${randomUUID()}.json`;
  writeFileSync(join(QUEUE, f1), JSON.stringify({ id: "a", skill: "voice-ask", args: { prompt: "hi" } }), "utf8");
  check(pickNext([f1], new Set()) === 0, "a readable runnable intent is picked");

  const f2 = `${randomUUID()}.json`;
  writeFileSync(join(QUEUE, f2), JSON.stringify({ skill: "morning-report" }), "utf8");
  check(
    pickNext([f2], new Set(["morning-report"])) === -1,
    "a DEDUPE skill already in flight is not picked"
  );

  const f3 = `${randomUUID()}.json`;
  writeFileSync(join(QUEUE, f3), JSON.stringify({ skill: "plan-today" }), "utf8");
  check(
    pickNext([f3], new Set(["plan-tomorrow"])) === -1,
    "a SERIAL skill waits while another serial skill runs"
  );

  const poison = `${randomUUID()}.json`;
  writeFileSync(join(QUEUE, poison), "{ torn json", "utf8");
  let early = true;
  for (let i = 0; i < 10; i++) early = early && pickNext([poison], new Set()) === -1;
  check(early, "an unreadable file is tolerated for the first 10 ticks (write race)");
  check(
    pickNext([poison], new Set()) === 0,
    "after 10 skips a poison file is handed to processOne for dead-lettering"
  );

  // --- retireClaim: a claimed intent becomes an error run record --------------
  const claimId = randomUUID();
  writeFileSync(
    join(QUEUE, `${claimId}.json.claimed`),
    JSON.stringify({ id: claimId, skill: "voice-ask", ts: "T0", args: {} }),
    "utf8"
  );
  retireClaim(`${claimId}.json`, "test retire");
  const record = JSON.parse(readFileSync(join(RUNS, `${claimId}.json`), "utf8"));
  check(
    record.status === "error" && record.exit_code === -4 && record.ts_completed,
    "retireClaim writes a completed error run record"
  );
  check(
    !existsSync(join(QUEUE, `${claimId}.json.claimed`)),
    "retireClaim removes the claim file (no replay on the next boot)"
  );

  // --- pidLooksLikeRunner: a recycled pid no longer blocks boot ---------------
  check(
    pidLooksLikeRunner(process.pid) === false,
    "a live process that is not runner.js does not pass the pidfile check"
  );

  // --- stall retry (issue #43): one requeue, ever ------------------------------
  const original = { id: "orig", skill: "weekly-review", args: { model: "claude-opus-4-8" }, ts: "T0", source: "schedule:weekly" };
  const retry = retryIntent(original);
  check(
    retry !== null && retry.retry === 1 && retry.skill === "weekly-review" && retry.args.model === "claude-opus-4-8",
    "a stalled first run earns a retry intent carrying the same skill + args"
  );
  check(retry !== null && retry.id !== original.id && /^[0-9a-f-]{36}$/.test(retry.id), "the retry gets a fresh UUID (old id's run record blocks replays)");
  check(retryIntent(retry!) === null, "a retried intent never earns a second retry (no loops)");
  check(
    STALL_TIMEOUT_MS < 20 * 60_000 && STALL_TIMEOUT_MS >= 4 * 60_000,
    "stall timeout sits between healthy-run duration (2-3m) and the hard timeout"
  );

  // --- weekly-review prompt reads Daniel's curated Atlas notes (issue #43) -----
  const weekly = buildPrompt({ id: "x", skill: "weekly-review", args: {} }, "inbox/reports/weekly/x.md");
  check(
    weekly !== null && weekly.includes("Atlas/Decisions/") && weekly.includes("Chess - Tournament Log.md"),
    "weekly-review gathers evidence from Atlas/Decisions and the directive Areas notes"
  );

  // --- plan-today prompt scans the real project-notes folder ------------------
  const prompt = buildPrompt({ id: "x", skill: "plan-today", args: {} }, "daily-notes/x.md");
  check(
    prompt !== null && prompt.includes("Atlas/Projects/*.md"),
    "plan-today scans Atlas/Projects/*.md (where the project notes actually live)"
  );
  check(
    prompt !== null && !prompt.includes("Scan projects/*.md"),
    "plan-today no longer scans the nonexistent top-level projects/ folder"
  );

  // --- morphyCounts / morphySnapshotMd ----------------------------------------
  const tasks = [
    { id: "1", name: "Site survey", status: "Todo", assignee: "Daniel", addedBy: "HELM", priority: "High" },
    { id: "2", name: "Lease draft", status: "In progress", assignee: "Michael", addedBy: "Michael", priority: "Med" },
    { id: "3", name: "New antenna idea", status: "Idea", assignee: "Daniel", addedBy: "Daniel", priority: "Low" },
    { id: "4", name: "Kickoff", status: "Done", assignee: "Daniel", addedBy: "Daniel", priority: "Med" },
    { id: "5", name: "Mystery", status: "Weird", assignee: "Nobody", addedBy: "Daniel", priority: "Med" },
  ];
  const m = morphyCounts(tasks);
  check(
    m.counts.todo === 2 && m.counts.in_progress === 1 && m.counts.idea === 1 && m.counts.done === 1,
    "morphyCounts buckets statuses (unknown status falls back to todo)"
  );
  check(m.open_total === 3, "open_total excludes ideas and done");
  check(m.ideas_awaiting === 1, "ideas_awaiting counts ideas");
  check(
    m.open_by_assignee.Daniel === 2 && m.open_by_assignee.Michael === 1 && m.open_by_assignee.Unassigned === 1,
    "open_by_assignee buckets by assignee (unknown names → Unassigned)"
  );

  const snap = morphySnapshotMd(tasks, "T0");
  check(
    snap.includes("## Todo (") && snap.includes("Site survey") && snap.includes("_(HELM)_"),
    "morphySnapshotMd renders sections, task names and the HELM marker"
  );

  // --- pruneRuns: old run files go, fresh ones and strangers stay --------------
  const PRUNE_DIR = join(VAULT, "system", "runs-prune");
  mkdirSync(PRUNE_DIR, { recursive: true });
  const aged = (name: string, days: number) => {
    const p = join(PRUNE_DIR, name);
    writeFileSync(p, "x", "utf8");
    const t = new Date(Date.now() - days * 24 * 3600 * 1000);
    utimesSync(p, t, t);
  };
  aged("old.json", 40);
  aged("old.md", 40);
  aged("fresh.json", 5);
  aged("stranger.txt", 40); // not a run artifact — never touched
  check(pruneRuns(PRUNE_DIR) === 2, "pruneRuns deletes exactly the 30-day-old .json/.md pair");
  check(
    !existsSync(join(PRUNE_DIR, "old.json")) && !existsSync(join(PRUNE_DIR, "old.md")),
    "old run json + md are gone"
  );
  check(
    existsSync(join(PRUNE_DIR, "fresh.json")) && existsSync(join(PRUNE_DIR, "stranger.txt")),
    "fresh runs and non-run files survive"
  );

  // --- slugify / todayDate ------------------------------------------------------
  check(slugify("Hello, World!") === "hello-world", "slugify lowercases and dashes");
  check(slugify("") === "untitled", "slugify falls back to untitled");
  check(slugify("x".repeat(100)).length <= 48, "slugify caps length");
  check(/^\d{4}-\d{2}-\d{2}$/.test(todayDate()), "todayDate is a local YYYY-MM-DD");

  // --- shared ~/.claude/.env parser (issue #44) ----------------------------------
  // One loader (runner/env.js) now serves runner.js and queue-intent.mjs;
  // lib/homeEnv.ts is the HUD-side sibling and must accept the same key shapes.
  const { parseEnvText } = await import("../runner/env.js");
  const parsed = parseEnvText(
    ['FOO=bar', 'mixed_Case=ok', '# COMMENT=skipped', 'QUOTED="q v"', 'noequals', 'PAD = spaced '].join("\n")
  ) as Record<string, string>;
  check(parsed.FOO === "bar", "parseEnvText reads a plain KEY=value");
  check(parsed.mixed_Case === "ok", "parseEnvText accepts mixed-case keys");
  check(!("COMMENT" in parsed) && !("# COMMENT" in parsed), "parseEnvText skips # comments");
  check(parsed.QUOTED === "q v", "parseEnvText strips wrapping quotes");
  check(!("noequals" in parsed), "parseEnvText skips lines without =");
  check(parsed.PAD === "spaced", "parseEnvText trims keys and values");
  const homeEnvSrc = readFileSync(new URL("../lib/homeEnv.ts", import.meta.url), "utf8");
  check(
    homeEnvSrc.includes("[A-Za-z0-9_]"),
    "lib/homeEnv.ts accepts the same mixed-case keys as runner/env.js (rule kept in sync)"
  );

  // --- agendaSync spawn path (issue #56): stub feed, no claude/python/network -
  // The feed is swapped for a stub node binary. Success = the runner returns the
  // feed's valid cache; garbage/timeout = the runner writes its own clean ok:false.
  const agendaFile = join(VAULT, "system", "agenda.json");
  const STUB_OK =
    'const fs=require("fs"),p=require("path");const f=p.join(process.env.VAULT_ROOT,"system","agenda.json");' +
    'fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(' +
    '{ok:true,last_sync_ts:"T",date:"2026-07-05",tz:"America/New_York",' +
    'events:[{time:"09:00",end:"09:30",item:"Standup",allDay:false,location:""}]}));';
  const STUB_GARBAGE =
    'const fs=require("fs"),p=require("path");const f=p.join(process.env.VAULT_ROOT,"system","agenda.json");' +
    'fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,"{{ not json");';
  const STUB_SLEEP = "setTimeout(()=>{},10000);";

  const okRes = await agendaSync("test-ok", { cmd: process.execPath, args: ["-e", STUB_OK], timeoutMs: 5000 });
  check(
    okRes.ok === true && okRes.events.length === 1 && okRes.events[0].item === "Standup",
    "agendaSync returns the feed's valid ok:true cache untouched"
  );

  rmSync(agendaFile, { force: true });
  const garbageRes = await agendaSync("test-garbage", { cmd: process.execPath, args: ["-e", STUB_GARBAGE], timeoutMs: 5000 });
  check(
    garbageRes.ok === false && /feed-missing/.test(garbageRes.reason) &&
      JSON.parse(readFileSync(agendaFile, "utf8")).ok === false,
    "garbage feed output → runner writes a clean, well-formed ok:false"
  );

  rmSync(agendaFile, { force: true });
  const timeoutRes = await agendaSync("test-timeout", { cmd: process.execPath, args: ["-e", STUB_SLEEP], timeoutMs: 700 });
  check(
    timeoutRes.ok === false && /timeout/.test(timeoutRes.reason),
    "a hung feed is killed and reported as a typed timeout ok:false"
  );

  rmSync(VAULT, { recursive: true, force: true });
  console.log(
    failed === 0 ? `\nAll runner reliability checks pass.` : `\n${failed} runner check(s) failed.`
  );
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(`test-runner crashed: ${e?.stack || e}`);
  process.exit(1);
});
