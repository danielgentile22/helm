// Fleet watchdog sweep (issue #58) — deriveFleetHealth(inputs) over fixtures:
// fresh fleet, each producer stale, deadline edges, Sunday-only weekly rule,
// midnight TZ edge, one-kick-per-episode dedup, recovery. Pure: imports
// runner/fleet.js only. No I/O, no live vault.
// Run: npx -y tsx scripts/test-fleet.ts
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFleetHealth, isStuckRun, fleetCheck } from "../runner/fleet.js";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// Tuesday 2026-06-30 12:00 in New York (16:00Z) — everything ran on schedule.
const NOW = "2026-06-30T16:00:00Z";
function inputs(over: Record<string, unknown> = {}) {
  return {
    now: NOW,
    tz: "America/New_York",
    agenda: { last_sync_ts: "2026-06-30T15:45:00Z" },
    agendaIntervalMin: 30,
    morphy: { last_sync_ts: "2026-06-30T15:45:00Z" },
    morningFiles: ["2026-06-30-morning-report-abc123.md"],
    dailyFiles: ["2026-06-30.md"],
    weeklyFiles: ["2026-06-28-weekly-review-def456.md"],
    metricsRows: [
      { ts: "2026-06-30T12:00:00Z", source: "uscf" },
      { ts: "2026-06-30T15:00:00Z", source: "claude_code" },
      { ts: "2026-06-30T11:00:00Z", source: "jobs" },
      { ts: "2026-06-30T12:30:00Z", source: "github" },
    ],
    prev: null,
    ...over,
  };
}
interface Producer {
  id: string;
  last_output_ts: string | null;
  stale: boolean;
  reason: string | null;
  kicked_ts: string | null;
}
const producer = (h: { producers: Producer[] }, id: string) => h.producers.find((p) => p.id === id)!;

// --- all fresh --------------------------------------------------------------
{
  const h = deriveFleetHealth(inputs());
  check(h.ok === true, "fresh fleet: ok true");
  check(h.producers.length === 9, "fresh fleet: all 9 producers reported");
  check(h.producers.every((p: { stale: boolean }) => !p.stale), "fresh fleet: nothing stale");
  check(h.kicks.length === 0, "fresh fleet: nothing to kick");
  check(h.ts === NOW, "health stamped with the supplied now");
}

// --- runner-owned caches go stale at 2× their sync interval -----------------
{
  const h = deriveFleetHealth(inputs({ agenda: { last_sync_ts: "2026-06-30T14:55:00Z" } }));
  const p = producer(h, "agenda");
  check(p.stale === true, "agenda 65m old (30m interval) is stale");
  check(!!p.reason && p.reason.includes("65m"), "agenda reason names the age");
  check(h.ok === false, "one stale producer drops fleet ok");
  check(h.kicks.includes("agenda"), "fresh staleness episode kicks agenda");
}
{
  const h = deriveFleetHealth(inputs({ agenda: { last_sync_ts: "2026-06-30T15:05:00Z" } }));
  check(producer(h, "agenda").stale === false, "agenda 55m old is still fresh (limit 60m)");
}
{
  const h = deriveFleetHealth(inputs({ morphy: { last_sync_ts: "2026-06-30T14:00:00Z" } }));
  check(producer(h, "morphy-board").stale === true, "morphy board 2h old is stale");
}
{
  const h = deriveFleetHealth(inputs({ agenda: null, morphy: null }));
  check(
    producer(h, "agenda").stale && producer(h, "morphy-board").stale,
    "missing caches count as stale (runner should have written them)"
  );
}
// --- ok:false trips red on the next failed sync, even with a FRESH ts (#18) --
// A dead Notion token freezes the sync; an agenda feed can even write its own
// fresh-timestamped ok:false. Age math alone would stay green — ok:false must not.
{
  const h = deriveFleetHealth(
    inputs({ agenda: { ok: false, reason: "auth: bad creds", last_sync_ts: NOW } })
  );
  const p = producer(h, "agenda");
  check(p.stale === true, "agenda ok:false with a fresh ts is stale (broken feed → red)");
  check(!!p.reason && /not syncing/.test(p.reason), "agenda ok:false reason names the outage");
}
{
  const h = deriveFleetHealth(
    inputs({ morphy: { ok: false, reason: "dead token", last_sync_ts: NOW } })
  );
  const p = producer(h, "morphy-board");
  check(p.stale === true, "morphy ok:false with a fresh ts is stale (dead token → red)");
  check(!!p.reason && /not syncing/.test(p.reason), "morphy ok:false reason names the outage");
}
{
  // ok:true still uses the age window — a healthy fresh sync stays green.
  const h = deriveFleetHealth(
    inputs({ agenda: { ok: true, last_sync_ts: "2026-06-30T15:45:00Z" } })
  );
  check(producer(h, "agenda").stale === false, "agenda ok:true and fresh is not stale");
}

// --- deadline producers: due only after the local deadline -------------------
{
  // 08:59 NY (12:59Z): no report yet for today, but the deadline hasn't hit.
  const h = deriveFleetHealth(
    inputs({ now: "2026-06-30T12:59:00Z", morningFiles: [], dailyFiles: [] })
  );
  check(producer(h, "morning-report").stale === false, "no report at 08:59 local is not yet late");
  check(producer(h, "daily-note").stale === false, "no daily note at 08:59 local is not yet late");
}
{
  // 09:01 NY (13:01Z): now it's late — even with NO file ever written
  // (the "weekly review never existed" failure class).
  const h = deriveFleetHealth(
    inputs({ now: "2026-06-30T13:01:00Z", morningFiles: [], dailyFiles: [] })
  );
  const p = producer(h, "morning-report");
  check(p.stale === true, "no morning report by 09:01 local is stale");
  check(!!p.reason && p.reason.includes("2026-06-30"), "reason names the missing day");
  check(producer(h, "daily-note").stale === true, "no daily note by 09:01 local is stale");
}
{
  // Yesterday's report present, today's missing, past deadline → stale.
  const h = deriveFleetHealth(
    inputs({ now: "2026-06-30T13:01:00Z", morningFiles: ["2026-06-29-morning-report-old.md"] })
  );
  check(producer(h, "morning-report").stale === true, "yesterday's report doesn't cover today");
}

// --- midnight TZ edge: 00:30 NY is 04:30Z NEXT day — "today" must stay local --
{
  // 2026-06-30T04:30Z = 2026-06-30 00:30 in NY. Yesterday's (06-29) note is the
  // latest — fine at half past midnight; a UTC-dated "today" (06-30 already
  // past 09:00 somewhere) must not fire.
  const h = deriveFleetHealth(
    inputs({
      now: "2026-06-30T04:30:00Z",
      morningFiles: ["2026-06-29-morning-report-x.md"],
      dailyFiles: ["2026-06-29.md"],
      agenda: { last_sync_ts: "2026-06-30T04:15:00Z" },
      morphy: { last_sync_ts: "2026-06-30T04:15:00Z" },
      metricsRows: [
        { ts: "2026-06-29T12:00:00Z", source: "uscf" },
        { ts: "2026-06-30T04:00:00Z", source: "claude_code" },
        { ts: "2026-06-29T11:00:00Z", source: "jobs" },
        { ts: "2026-06-29T12:30:00Z", source: "github" },
      ],
    })
  );
  check(h.ok === true, "half past local midnight: yesterday's dailies are not 'late for today'");
}

// --- weekly review: Sunday-evening-only rule ---------------------------------
{
  // Sunday 2026-06-28 19:30 NY (23:30Z), review missing → stale.
  const h = deriveFleetHealth(inputs({ now: "2026-06-28T23:30:00Z", weeklyFiles: [] }));
  check(producer(h, "weekly-review").stale === true, "Sunday 19:30 with no review is stale");
}
{
  // Sunday 18:00 NY — review runs at 17:00 but grace runs to 19:00.
  const h = deriveFleetHealth(inputs({ now: "2026-06-28T22:00:00Z", weeklyFiles: [] }));
  check(producer(h, "weekly-review").stale === false, "Sunday 18:00 is inside the grace window");
}
{
  // Sunday 19:30 with TODAY'S review present → fresh.
  const h = deriveFleetHealth(
    inputs({ now: "2026-06-28T23:30:00Z", weeklyFiles: ["2026-06-28-weekly-review-ok.md"] })
  );
  check(producer(h, "weekly-review").stale === false, "Sunday with today's review is fresh");
}
{
  // Monday: last Sunday's review missing entirely, but Monday never checks.
  const h = deriveFleetHealth(inputs({ now: "2026-06-29T23:30:00Z", weeklyFiles: [] }));
  check(producer(h, "weekly-review").stale === false, "weekly rule only fires on Sundays");
}

// --- metric feeds -------------------------------------------------------------
{
  // uscf last wrote 27h ago (daily cadence + 2h grace = 26h limit) → stale.
  const rows = inputs().metricsRows as { ts: string; source: string }[];
  const h = deriveFleetHealth(
    inputs({
      metricsRows: rows
        .filter((r) => r.source !== "uscf")
        .concat([{ ts: "2026-06-29T13:00:00Z", source: "uscf" }]),
    })
  );
  check(producer(h, "uscf-feed").stale === true, "uscf row 27h old is stale");
  check(producer(h, "jobs-feed").stale === false, "other daily feeds unaffected");
}
{
  // hourly tokens feed: 3h without a row → stale (limit 2h).
  const rows = (inputs().metricsRows as { ts: string; source: string }[]).map((r) =>
    r.source === "claude_code" ? { ts: "2026-06-30T13:00:00Z", source: "claude_code" } : r
  );
  const h = deriveFleetHealth(inputs({ metricsRows: rows }));
  check(producer(h, "tokens-feed").stale === true, "tokens row 3h old is stale (2h limit)");
}
{
  // A feed with NO rows ever is unconfigured (MORPHY_REPO unset), not broken.
  const rows = (inputs().metricsRows as { ts: string; source: string }[]).filter(
    (r) => r.source !== "github"
  );
  const h = deriveFleetHealth(inputs({ metricsRows: rows }));
  check(producer(h, "morphy-github-feed").stale === false, "never-configured feed is not watched");
}

// --- one kick per staleness episode -------------------------------------------
{
  const staleIn = () => inputs({ agenda: { last_sync_ts: "2026-06-30T13:00:00Z" } });
  const first = deriveFleetHealth(staleIn());
  check(first.kicks.includes("agenda"), "episode start: agenda kicked");
  check(first.newlyStale.includes("agenda"), "episode start: agenda is newly stale");
  const kickedAt = producer(first, "agenda").kicked_ts;
  check(kickedAt === NOW, "kicked_ts stamped with now");

  // Next pass, still stale: no second kick, kicked_ts preserved, not "new".
  const second = deriveFleetHealth({ ...staleIn(), prev: first, now: "2026-06-30T16:05:00Z" });
  check(!second.kicks.includes("agenda"), "still-stale producer is not kicked again");
  check(!second.newlyStale.includes("agenda"), "still-stale producer is not newly stale");
  check(producer(second, "agenda").kicked_ts === kickedAt, "kicked_ts survives the episode");

  // Recovery clears the episode…
  const recovered = deriveFleetHealth({ ...inputs(), prev: second, now: "2026-06-30T16:10:00Z" });
  check(producer(recovered, "agenda").stale === false, "recovered producer reads fresh");
  check(producer(recovered, "agenda").kicked_ts === null, "recovery clears kicked_ts");

  // …so the NEXT outage is a new episode with a new kick.
  const again = deriveFleetHealth({
    ...inputs({ agenda: { last_sync_ts: "2026-06-30T15:00:00Z" } }),
    prev: recovered,
    now: "2026-06-30T17:30:00Z",
  });
  check(again.kicks.includes("agenda"), "a later outage is a fresh episode → kicked again");
}

// --- stuck runs: "status: running" past 2× the longest hard timeout ------------
{
  const nowMs = Date.parse(NOW);
  const min = (m: number) => new Date(nowMs - m * 60_000).toISOString();
  check(
    isStuckRun({ status: "running", ts_started: min(45) }, nowMs) === true,
    "run 'running' for 45m is stuck (limit 40m = 2× the 20m hard timeout)"
  );
  check(
    isStuckRun({ status: "running", ts_started: min(35) }, nowMs) === false,
    "run 'running' for 35m is still within bounds"
  );
  check(
    isStuckRun({ status: "error", ts_started: min(300) }, nowMs) === false,
    "finished runs are never stuck"
  );
  check(
    isStuckRun({ status: "running", ts_started: "garbage" }, nowMs) === true,
    "a running run with an unparseable start is stuck (it can never finish)"
  );
}

// --- fleetCheck wrapper: throwaway vault, injected kicks/notify ----------------
async function wrapperTests() {
  const VAULT = join(tmpdir(), `helm-test-fleet-${process.pid}`);
  rmSync(VAULT, { recursive: true, force: true });
  const sys = join(VAULT, "system");
  mkdirSync(join(sys, "runs"), { recursive: true });
  mkdirSync(join(sys, "metrics"), { recursive: true });
  mkdirSync(join(VAULT, "inbox", "reports", "morning"), { recursive: true });
  mkdirSync(join(VAULT, "inbox", "reports", "weekly"), { recursive: true });
  mkdirSync(join(VAULT, "daily-notes"), { recursive: true });

  const nowMs = Date.parse(NOW);
  const iso = (minAgo: number) => new Date(nowMs - minAgo * 60_000).toISOString();

  // Fixtures: agenda stale (65m), uscf stale (27h), everything else fresh,
  // one stuck run, one healthy run.
  writeFileSync(join(sys, "agenda.json"), JSON.stringify({ ok: true, last_sync_ts: iso(65) }));
  writeFileSync(join(sys, "morphy-state.json"), JSON.stringify({ ok: true, last_sync_ts: iso(5) }));
  writeFileSync(
    join(sys, "metrics", "metrics.csv"),
    "timestamp,source,metric,value,status,error\n" +
      `${iso(27 * 60)},uscf,rating,1545,ok,\n` +
      `${iso(30)},claude_code,tokens_5h,100,ok,\n` +
      `${iso(120)},jobs,applications,3,ok,\n` +
      `${iso(120)},github,commits_7d,4,ok,\n`
  );
  writeFileSync(join(VAULT, "inbox", "reports", "morning", "2026-06-30-morning-report-x.md"), "#");
  writeFileSync(join(VAULT, "daily-notes", "2026-06-30.md"), "#");
  writeFileSync(
    join(sys, "runs", "stuck.json"),
    JSON.stringify({ id: "stuck", skill: "voice-ask", status: "running", ts_started: iso(50) })
  );
  writeFileSync(
    join(sys, "runs", "live.json"),
    JSON.stringify({ id: "live", skill: "voice-ask", status: "running", ts_started: iso(5) })
  );

  const kicked: string[] = [];
  const synced: string[] = [];
  const notes: { type: string; stale: { id: string; reason: string }[] }[] = [];
  const deps = {
    vaultRoot: VAULT,
    tz: "America/New_York",
    agendaIntervalMin: 30,
    now: NOW,
    agendaSync: async () => {
      synced.push("agenda");
    },
    morphySync: async () => {
      synced.push("morphy");
    },
    kickstart: (label: string) => {
      kicked.push(label);
    },
    notify: (event: { type: string; stale: { id: string; reason: string }[] }) => {
      notes.push(event);
    },
    log: () => {},
  };

  const h = await fleetCheck(deps);
  check(h.ok === false, "wrapper: stale fixtures produce ok:false");

  const written = JSON.parse(readFileSync(join(sys, "fleet-health.json"), "utf8"));
  check(written.ok === false && Array.isArray(written.producers), "wrapper: health file written");
  check(!("kicks" in written) && !("newlyStale" in written), "wrapper: transient fields not persisted");
  check(
    written.producers.find((p: { id: string }) => p.id === "agenda")?.stale === true,
    "wrapper: persisted file marks agenda stale"
  );

  check(synced.includes("agenda"), "wrapper: stale agenda kicked via direct sync");
  check(kicked.includes("com.helm.uscf"), "wrapper: stale uscf kicked via launchd label");
  check(kicked.length === 1, "wrapper: fresh producers not kicked");

  check(notes.length === 1 && notes[0].type === "fleet-stale", "wrapper: one fleet-stale notification");
  check(
    notes[0].stale.some((s) => s.id === "agenda" && s.reason.includes("65m")),
    "wrapper: notification carries the reasons"
  );

  const stuck = JSON.parse(readFileSync(join(sys, "runs", "stuck.json"), "utf8"));
  check(stuck.status === "error", "wrapper: stuck run flipped to error");
  check(String(stuck.summary || "").includes("watchdog"), "wrapper: flip attributed to the watchdog");
  check(!!stuck.ts_completed, "wrapper: flipped run gets a completion stamp");
  const live = JSON.parse(readFileSync(join(sys, "runs", "live.json"), "utf8"));
  check(live.status === "running", "wrapper: in-flight run left alone");

  // Second pass, same staleness: episode continues → no new kicks, no new note.
  await fleetCheck({ ...deps, now: iso(-5) });
  check(synced.filter((s) => s === "agenda").length === 1, "wrapper: no re-kick while still stale");
  check(notes.length === 1, "wrapper: no repeat notification during an episode");

  // Garbage state files must degrade, not throw (the cure can't be the disease).
  writeFileSync(join(sys, "agenda.json"), "not json{{{");
  writeFileSync(join(sys, "metrics", "metrics.csv"), " garbage");
  const g = await fleetCheck({ ...deps, now: iso(-10) });
  check(!!g && typeof g.ok === "boolean", "wrapper: garbage state files still yield a health verdict");
  check(
    g.producers.find((p: { id: string }) => p.id === "agenda")?.stale === true,
    "wrapper: unparseable agenda cache counts as stale"
  );

  rmSync(VAULT, { recursive: true, force: true });
}

wrapperTests()
  .catch((e) => fail(`wrapper tests threw: ${e?.stack || e}`))
  .finally(() => {
    console.log(failed === 0 ? `\nAll fleet checks pass.` : `\n${failed} fleet check(s) failed.`);
    process.exit(failed ? 1 : 0);
  });
