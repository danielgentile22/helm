// Vault data-layer sweep — fixture-driven regression tests for lib/vault.ts,
// the file-parsing backbone every other tested module builds on (issue #38).
// Covers: metrics CSV parsing + the timestamp-based weekly delta, daily-note
// parsing + the ≤today fallback, morning-report headline mining, runs/queue
// scans, sync-conflict exclusion everywhere (vault.ts AND voiceMemory.ts),
// the skill-ETA median + its dir-mtime memoization, and writeIntent's atomic
// queue write. All against a throwaway temp vault — no real vault, no spend.
//
// Run: npx -y tsx scripts/test-vault.ts
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, rmSync, utimesSync } from "node:fs";
import fsMod from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// lib/config resolves VAULT_ROOT at module load — point it at a throwaway
// vault BEFORE the dynamic imports below.
const VAULT = join(tmpdir(), `helm-test-vault-${process.pid}`);
process.env.VAULT_ROOT = VAULT;

const DAILY = join(VAULT, "daily-notes");
const METRICS = join(VAULT, "system", "metrics");
const RUNS = join(VAULT, "system", "runs");
const QUEUE = join(VAULT, "system", "queue");
const MORNING = join(VAULT, "inbox", "reports", "morning");
for (const d of [DAILY, METRICS, RUNS, QUEUE, MORNING]) mkdirSync(d, { recursive: true });

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

const DAY = 24 * 3600 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const touch = (p: string, msAgo: number) => {
  const t = new Date(Date.now() - msAgo);
  utimesSync(p, t, t);
};
const shiftDate = (ymd: string, days: number) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d + days))
  );
};

async function run(): Promise<void> {
  const vault = await import("../lib/vault");
  const { writeIntent } = await import("../lib/skills");
  const { conversationContext } = await import("../lib/voiceMemory");

  const today = vault.todayLocal();
  check(/^\d{4}-\d{2}-\d{2}$/.test(today), `todayLocal() is YYYY-MM-DD (${today})`);

  // --- readMetrics: CSV tolerance + timestamp-based weekly delta -------------
  {
    // daily-cadence metric: 10 rows, one/day, value climbing 1/day. An
    // index-based window would report the full 9-day climb as "/wk"; the
    // timestamp window must diff against the oldest point inside 7 days.
    const rows = ["timestamp,source,metric,value,status,error"];
    // half-day offset keeps every point clear of the exact 7-day cutoff
    for (let i = 0; i < 10; i++) {
      rows.push(`${iso((9 - i) * DAY + DAY / 2)},uscf,rating,${100 + i},ok,`);
    }
    rows.push("junk-not-a-date,uscf,rating,notanumber,ok,"); // junk value → skipped
    rows.push("short,row"); // <5 cols → skipped
    // single-point-in-window metric: history exists but only the latest row
    // is newer than 7 days → deltaWeek must be null, not a 30-day delta
    rows.push(`${iso(30 * DAY)},jobs,applications,5,ok,`);
    rows.push(`${iso(20 * DAY)},jobs,applications,7,ok,`);
    rows.push(`${iso(0)},jobs,applications,9,ok,`);
    writeFileSync(join(METRICS, "metrics.csv"), rows.join("\n") + "\n", "utf-8");

    const metrics = vault.readMetrics();
    const rating = metrics.find((m) => m.source === "uscf");
    const apps = metrics.find((m) => m.source === "jobs");
    check(!!rating && rating.history.length === 10, "junk CSV rows are skipped, valid ones kept");
    check(rating?.value === 109 && rating?.delta === 1, "value/delta come from the two newest rows");
    check(
      rating?.deltaWeek === 6,
      `deltaWeek diffs vs the oldest point INSIDE 7 days (got ${rating?.deltaWeek}, index-based would be 9)`
    );
    check(
      apps?.deltaWeek === null,
      `deltaWeek is null with <2 points in the 7-day window (got ${apps?.deltaWeek})`
    );
  }

  // --- readDailyNote: parse + never surface a future draft -------------------
  {
    writeFileSync(
      join(DAILY, `${today}.md`),
      [
        "# Daily",
        "## Top 3 Priorities",
        "1. [ ] Apply to two jobs",
        "2. [x] Chess tactics",
        "3. [ ] Morphy outreach",
        "## Schedule",
        "- 09:00 — Standup",
        "- 14:30 — Deep work",
        "## Current Focus",
        "Ship issue #38",
      ].join("\n"),
      "utf-8"
    );
    const note = vault.readDailyNote();
    check(note?.isToday === true && note?.date === today, "today's note wins when present");
    check(
      note?.top3.length === 3 && note?.top3[1].done === true && note?.top3[0].text === "Apply to two jobs",
      "Top 3 checkboxes parse (text + done state)"
    );
    check(
      note?.schedule.length === 2 && note?.schedule[0].time === "09:00" && note?.schedule[1].item === "Deep work",
      "Schedule bullets parse (time + item)"
    );
    check(note?.focus === "Ship issue #38", "Current Focus parses");

    // no today's note + a plan-tomorrow draft on disk → fallback must pick
    // the newest PAST note, never tomorrow's schedule
    const yesterday = shiftDate(today, -1);
    const tomorrow = shiftDate(today, +1);
    writeFileSync(join(DAILY, `${yesterday}.md`), "## Current Focus\nyesterday\n", "utf-8");
    writeFileSync(join(DAILY, `${tomorrow}.md`), "## Current Focus\ntomorrow draft\n", "utf-8");
    unlinkSync(join(DAILY, `${today}.md`));
    const fallback = vault.readDailyNote();
    check(
      fallback?.isToday === false && fallback?.date === yesterday,
      `fallback picks the newest past note (${fallback?.date}), not tomorrow's draft`
    );
  }

  // --- readMorningReport: sync-conflict copy never shadows the real one ------
  {
    const real = `${today}-morning-report-ab12cd34.md`;
    const conflict = `${today}-morning-report-ab12cd34.sync-conflict-20260701-063012-ABCDEF7.md`;
    writeFileSync(
      join(MORNING, real),
      "# Morning Report\n## Headlines\n- Real headline one [source](https://example.com/a)\n- Real headline two\n## AI & Startups\n- deeper stuff\n",
      "utf-8"
    );
    writeFileSync(join(MORNING, conflict), "# Morning Report\n## Headlines\n- STALE conflict headline\n", "utf-8");
    const report = vault.readMorningReport();
    check(report?.rel === `inbox/reports/morning/${real}`, "rel points at the real report, not the conflict copy");
    // the parser keeps link TEXT ([source](url) → "source") and strips the URL
    check(
      report?.heads[0] === "Real headline one source" && !report?.heads.some((h) => h.includes("STALE")),
      "headlines come from the real report (conflict copy excluded)"
    );
    check(report?.links[0] === "https://example.com/a" && report?.links[1] === null, "per-headline source links parse");
    check(report?.heads.length === 2, "mining stops at the next ## section");
  }

  // --- runs/queue scans: no double-counting, stat-once ordering, ETA median --
  const runJson = (id: string, skill: string, durationS: number, status = "ok") => ({
    id,
    skill,
    status,
    ts_started: iso(durationS * 1000 + 60_000),
    ts_completed: iso(60_000),
    summary: `${skill} done`,
    deliverable_path: null,
  });
  {
    writeFileSync(join(RUNS, "run-a.json"), JSON.stringify(runJson("run-a", "morning-report", 60)), "utf-8");
    writeFileSync(join(RUNS, "run-b.json"), JSON.stringify(runJson("run-b", "morning-report", 120)), "utf-8");
    writeFileSync(
      join(RUNS, "run-a.sync-conflict-20260701-063012-ABCDEF7.json"),
      JSON.stringify(runJson("run-a", "morning-report", 60)),
      "utf-8"
    );
    touch(join(RUNS, "run-a.json"), 10 * 60_000);
    touch(join(RUNS, "run-b.json"), 5 * 60_000);

    const runs = vault.readRecentRuns();
    check(runs.length === 2, `conflict copy doesn't double-count a run (got ${runs.length} entries)`);
    check(runs[0]?.id === "run-b" && runs[1]?.id === "run-a", "runs sort newest-first by mtime");
    check(runs[0]?.duration_s === 120, "duration derives from ts_started/ts_completed");

    const etas = vault.readSkillEtas();
    check(etas["morning-report"] === 120, `ETA median over [60,120] without the conflict dupe (got ${etas["morning-report"]})`);
    check(vault.readSkillEtas() === etas, "readSkillEtas memoizes on an unchanged runs dir (same object back)");
    writeFileSync(join(RUNS, "run-c.json"), JSON.stringify(runJson("run-c", "morning-report", 30)), "utf-8");
    check(
      vault.readSkillEtas()["morning-report"] === 60,
      "a new run file invalidates the ETA cache (median over [30,60,120])"
    );

    writeFileSync(join(QUEUE, "q1.json"), JSON.stringify({ id: "q1", skill: "plan-today", ts: iso(0) }), "utf-8");
    writeFileSync(join(QUEUE, "q2.json"), JSON.stringify({ id: "q2", skill: "inbox-brief", ts: iso(0) }), "utf-8");
    writeFileSync(
      join(QUEUE, "q1.sync-conflict-20260701-063012-ABCDEF7.json"),
      JSON.stringify({ id: "q1", skill: "plan-today", ts: iso(0) }),
      "utf-8"
    );
    touch(join(QUEUE, "q1.json"), 2 * 60_000);
    touch(join(QUEUE, "q2.json"), 60_000);
    const queue = vault.readQueue();
    check(queue.length === 2, `conflict copy doesn't double-count a queued intent (got ${queue.length})`);
    check(queue[0]?.id === "q1" && queue[1]?.id === "q2", "queue keeps oldest-first order");

    // --- issue #28: a file deleted between readdir and stat drops ONE entry,
    // never the whole listing (stale-toast burst regression)
    const realStat = fsMod.statSync;
    (fsMod as any).statSync = (p: any, ...rest: any[]) => {
      if (String(p).endsWith("run-c.json")) {
        const e: any = new Error("ENOENT: vanished mid-scan");
        e.code = "ENOENT";
        throw e;
      }
      return realStat(p, ...rest);
    };
    try {
      const survivors = vault.readRecentRuns();
      check(
        survivors.length === 2 && survivors.some((r) => r.id === "run-a") && survivors.some((r) => r.id === "run-b"),
        `stat ENOENT on one run drops that entry only (got ${survivors.length} entries)`
      );
    } finally {
      (fsMod as any).statSync = realStat;
    }
  }

  // --- voiceMemory: a conflict copy frozen at "running" is not a phantom run --
  {
    writeFileSync(
      join(RUNS, "run-d.sync-conflict-20260701-063012-ABCDEF7.json"),
      JSON.stringify({ id: "run-d", skill: "voice-ask", status: "running", ts_started: iso(60_000), args: { prompt: "phantom" } }),
      "utf-8"
    );
    const ctx = conversationContext();
    check(
      !ctx.includes("Still working in the background"),
      "a frozen conflict copy can't inject a phantom in-progress run into voice context"
    );
    check(ctx.includes("Background results"), "real completed runs still surface in voice context");
  }

  // --- fleet-health.json reader (issue #58) -----------------------------------
  {
    check(vault.readFleetHealth() === null, "no fleet-health file yet → null (no data, not an alarm)");
    writeFileSync(join(VAULT, "system", "fleet-health.json"), "garbage{{{");
    check(vault.readFleetHealth() === null, "garbage fleet-health file → null, never a throw");
    const fixture = {
      ok: false,
      ts: iso(0),
      tz: "America/New_York",
      producers: [
        { id: "agenda", last_output_ts: iso(65 * 60_000), stale: true, reason: "agenda cache 65m old", kicked_ts: iso(0) },
      ],
    };
    writeFileSync(join(VAULT, "system", "fleet-health.json"), JSON.stringify(fixture));
    const fleet = vault.readFleetHealth();
    check(fleet !== null && fleet.ok === false, "fleet-health file parses");
    check(
      fleet !== null && fleet.producers[0].id === "agenda" && fleet.producers[0].stale === true,
      "stale producers come through with their reasons"
    );
    check(vault.readVaultState().fleet?.ok === false, "readVaultState carries fleet health");
  }

  // --- writeIntent: atomic queue write, no temp litter ------------------------
  {
    const id = writeIntent("plan-today", "test-vault");
    const files = readdirSync(QUEUE);
    check(files.includes(`${id}.json`), "writeIntent lands the intent file");
    check(!files.some((f) => f.includes(".tmp-")), "writeIntent leaves no temp file behind (write-then-rename)");

    // --- queue-intent.mjs shape contract (issue #43): the launchd script must
    // produce the SAME intent the HUD's writeIntent produces — run it for real
    // into the temp vault and compare field-by-field.
    execFileSync(process.execPath, [join(REPO, "scripts", "queue-intent.mjs"), "plan-today", "test-vault"], {
      env: { ...process.env, VAULT_ROOT: VAULT },
    });
    const hud = JSON.parse(fsMod.readFileSync(join(QUEUE, `${id}.json`), "utf8"));
    const mjsFile = readdirSync(QUEUE).find((f) => f.endsWith(".json") && f !== `${id}.json`);
    check(!!mjsFile, "queue-intent.mjs lands an intent file");
    if (mjsFile) {
      const mjs = JSON.parse(fsMod.readFileSync(join(QUEUE, mjsFile), "utf8"));
      check(
        JSON.stringify(Object.keys(mjs).sort()) === JSON.stringify(Object.keys(hud).sort()),
        `queue-intent.mjs intent has the same keys as writeIntent (${Object.keys(mjs).sort()})`
      );
      check(mjsFile === `${mjs.id}.json`, "queue-intent.mjs filename is the intent id (runner replay guard)");
      check(
        mjs.skill === "plan-today" && mjs.source === "test-vault" &&
          typeof mjs.ts === "string" && !Number.isNaN(Date.parse(mjs.ts)) &&
          JSON.stringify(mjs.args) === "{}",
        "queue-intent.mjs field values match the writeIntent contract"
      );
      check(!readdirSync(QUEUE).some((f) => f.includes(".tmp-")), "queue-intent.mjs leaves no temp file (write-then-rename)");
    }
  }

  rmSync(VAULT, { recursive: true, force: true });
  console.log(
    failed === 0 ? "\nAll vault data-layer checks passed." : `\n${failed} vault check(s) failed.`
  );
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(`test-vault crashed: ${e?.stack || e}`);
  process.exit(1);
});
