/**
 * Fleet watchdog (issue #58) — freshness math over HELM's scheduled producers.
 *
 * Pure core: deriveFleetHealth(inputs) compares each producer's last output
 * against its known cadence and returns the health snapshot the wrapper writes
 * to <vault>/system/fleet-health.json. No I/O, no Date.now() — the caller
 * supplies `now`, so every rule is testable with fixtures
 * (scripts/test-fleet.ts).
 *
 * Remediation contract: one kick per staleness episode. `kicks` lists the
 * producers to remediate THIS pass; a producer already kicked while still
 * stale keeps its kicked_ts and is not kicked again until it recovers.
 * The watchdog never writes to the intent queue.
 */

import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ponytail: cadences are constants next to their producers — no config file.
const AGE_LIMIT_MIN = {
  "morphy-board": 60, // runner syncs every 30 min → stale at 2×
  "tokens-feed": 120, // hourly metric row → stale at 2×
  // daily metric feeds: 24h cadence + 2h grace = "missed today's run by 2h"
  "uscf-feed": 26 * 60,
  "jobs-feed": 26 * 60,
  "morphy-github-feed": 26 * 60,
};
// Exported so scripts/test-fleet.ts can diff these against each feed's
// SOURCE constant — a renamed source must fail the suite, not silently
// unwatch the feed (issue #43).
export const METRIC_SOURCE = {
  "uscf-feed": "uscf",
  "tokens-feed": "claude_code",
  "jobs-feed": "jobs",
  "morphy-github-feed": "github",
};
// What one kick means per producer: a launchd label for scheduled jobs, or a
// runner-owned sync function name the wrapper resolves. Never the queue.
export const KICK_TARGETS = {
  agenda: "agenda-sync",
  "morphy-board": "morphy-sync",
  "morning-report": "com.helm.morning",
  "daily-note": "com.helm.plan",
  "weekly-review": "com.helm.weekly",
  "uscf-feed": "com.helm.uscf",
  "tokens-feed": "com.helm.tokens",
  "jobs-feed": "com.helm.jobs",
  "morphy-github-feed": "com.helm.morphy",
};

function ageMin(ts, nowMs) {
  const parsed = Date.parse(ts || "");
  return Number.isNaN(parsed) ? Infinity : (nowMs - parsed) / 60_000;
}

// Local wall-clock pieces in the HUD timezone — "today" and "by 09:00" must
// never split across dates at midnight (same trap todayDate() in runner.js
// exists to avoid).
function localParts(nowIso, tz) {
  const d = new Date(nowIso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return { date, hm, weekday };
}

// Newest YYYY-MM-DD prefix among report/note basenames, or null if none.
function latestDate(files) {
  let best = null;
  for (const f of files || []) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(f));
    if (m && (!best || m[1] > best)) best = m[1];
  }
  return best;
}

function newestRowTs(rows, source) {
  let best = null;
  for (const r of rows || []) {
    if (r.source === source && (!best || r.ts > best)) best = r.ts;
  }
  return best;
}

// A run record still "running" past 2× the longest hard timeout (20 min for
// LONG_SKILLS in runner.js) can only be a corpse — the runner's own timeout
// would have killed a live one. The wrapper flips these to error so they
// surface through the existing failed-runs path instead of lying forever.
// ponytail: one uniform 40m bound, not per-skill — the per-skill timeout
// already ran its course; this is the backstop for records it never finalized.
const STUCK_RUN_MIN = 40;
export function isStuckRun(run, nowMs) {
  if (!run || run.status !== "running") return false;
  const started = Date.parse(run.ts_started || "");
  // Unparseable start on a "running" record: it can never finish — stuck.
  if (Number.isNaN(started)) return true;
  return (nowMs - started) / 60_000 > STUCK_RUN_MIN;
}

export function deriveFleetHealth(inputs) {
  const { now, tz, prev } = inputs;
  const nowMs = Date.parse(now);
  const { date: today, hm, weekday } = localParts(now, tz);

  // Each check → { last_output_ts, stale, reason } (reason null when fresh).
  const checks = [];

  // Runner-owned caches: stale = last sync older than 2× the sync interval, OR
  // an explicit ok:false. The ok:false arm turns the dot red on the very next
  // failed sync (a dead Notion token, or an agenda feed that writes its own
  // fresh-timestamped ok:false) instead of waiting out the age window (#18).
  const agendaLimit = 2 * (inputs.agendaIntervalMin || 30);
  const agendaTs = inputs.agenda?.last_sync_ts || null;
  const agendaAge = ageMin(agendaTs, nowMs);
  const agendaFailed = inputs.agenda?.ok === false;
  checks.push({
    id: "agenda",
    last_output_ts: agendaTs,
    stale: agendaFailed || agendaAge > agendaLimit,
    reason: agendaFailed
      ? `agenda feed not syncing (${inputs.agenda?.reason || "ok:false"})`
      : agendaAge > agendaLimit
        ? `agenda cache ${Math.round(agendaAge)}m old (limit ${agendaLimit}m)`
        : null,
  });
  const morphyTs = inputs.morphy?.last_sync_ts || null;
  const morphyAge = ageMin(morphyTs, nowMs);
  const morphyFailed = inputs.morphy?.ok === false;
  checks.push({
    id: "morphy-board",
    last_output_ts: morphyTs,
    stale: morphyFailed || morphyAge > AGE_LIMIT_MIN["morphy-board"],
    reason: morphyFailed
      ? `morphy board not syncing (${inputs.morphy?.reason || "ok:false"})`
      : morphyAge > AGE_LIMIT_MIN["morphy-board"]
        ? `morphy board ${Math.round(morphyAge)}m old (limit ${AGE_LIMIT_MIN["morphy-board"]}m)`
        : null,
  });

  // Deadline producers: no output dated today once the local clock passes the
  // deadline. A producer with NO files at all is still held to the deadline —
  // "the weekly review crashed and never existed" is exactly the bug.
  const deadline = (id, files, byHm, extra = true) => {
    const last = latestDate(files);
    // Presence of TODAY's file, not max date — plan-tomorrow writes a
    // future-dated daily note, so latestDate can be tomorrow while today's
    // note is present. Comparing max !== today would false-stale (issue #20).
    const has = (files || []).some((f) => String(f).startsWith(today));
    const due = extra && hm >= byHm && !has;
    checks.push({
      id,
      last_output_ts: last,
      stale: due,
      reason: due ? `no ${id} for ${today} by ${byHm}` : null,
    });
  };
  deadline("morning-report", inputs.morningFiles, "09:00");
  deadline("daily-note", inputs.dailyFiles, "09:00");
  // Weekly runs Sundays 17:00 — only a Sunday evening can miss it.
  deadline("weekly-review", inputs.weeklyFiles, "19:00", weekday === "Sun");

  // Metric feeds: stale when the newest row for the source is past its age
  // limit. A source with no rows EVER is unconfigured (e.g. MORPHY_REPO
  // unset → the feed intentionally writes nothing), not broken — skip it.
  for (const id of ["uscf-feed", "tokens-feed", "jobs-feed", "morphy-github-feed"]) {
    const ts = newestRowTs(inputs.metricsRows, METRIC_SOURCE[id]);
    const stale = ts !== null && ageMin(ts, nowMs) > AGE_LIMIT_MIN[id];
    checks.push({
      id,
      last_output_ts: ts,
      stale,
      reason: stale
        ? `no ${METRIC_SOURCE[id]} metrics row for ${Math.round(ageMin(ts, nowMs) / 60)}h (limit ${AGE_LIMIT_MIN[id] / 60}h)`
        : null,
    });
  }

  // Episode bookkeeping: kick once when a producer FIRST goes stale, then
  // hold — a genuinely broken producer stays red instead of being hammered.
  const prevById = new Map((prev?.producers || []).map((p) => [p.id, p]));
  const kicks = [];
  const newlyStale = [];
  const producers = checks.map((c) => {
    const was = prevById.get(c.id);
    let kicked_ts = null;
    if (c.stale) {
      if (was?.stale) {
        kicked_ts = was.kicked_ts || null;
      } else {
        newlyStale.push(c.id);
      }
      if (!kicked_ts) {
        kicks.push(c.id);
        kicked_ts = now;
      }
    }
    return { ...c, kicked_ts };
  });

  return { ok: producers.every((p) => !p.stale), ts: now, tz, producers, kicks, newlyStale };
}

// --- I/O wrapper ------------------------------------------------------------
// Every read degrades to "no data" and the whole pass is try/caught by the
// caller's wiring — the watchdog must never take down the runner it watches.

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// metrics.csv → [{ ts, source }]; only the first two columns matter here.
function metricsRowsFrom(csvPath) {
  try {
    return readFileSync(csvPath, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => line.split(","))
      .filter((c) => c.length >= 2 && !Number.isNaN(Date.parse(c[0])))
      .map((c) => ({ ts: c[0], source: c[1] }));
  } catch {
    return [];
  }
}

// Same write-to-temp-then-rename as runner.js writeJson — not imported from
// there because runner.js imports THIS module (circular).
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * One watchdog pass: gather producer state from the vault, derive health,
 * flip stuck run records, perform this pass's kicks, notify on new staleness,
 * persist system/fleet-health.json. Kick/notify plumbing is injected so the
 * pass is testable without launchctl or a live runner (scripts/test-fleet.ts)
 * and so this module never imports runner.js.
 */
export async function fleetCheck(deps) {
  const {
    vaultRoot,
    tz,
    agendaIntervalMin,
    now = new Date().toISOString(),
    agendaSync,
    morphySync,
    kickstart,
    notify = () => {},
    log = () => {},
  } = deps;
  const sys = join(vaultRoot, "system");
  const healthPath = join(sys, "fleet-health.json");

  const health = deriveFleetHealth({
    now,
    tz,
    agenda: safeJson(join(sys, "agenda.json")),
    agendaIntervalMin,
    morphy: safeJson(join(sys, "morphy-state.json")),
    morningFiles: safeList(join(vaultRoot, "inbox", "reports", "morning")),
    dailyFiles: safeList(join(vaultRoot, "daily-notes")),
    weeklyFiles: safeList(join(vaultRoot, "inbox", "reports", "weekly")),
    metricsRows: metricsRowsFrom(join(sys, "metrics", "metrics.csv")),
    prev: safeJson(healthPath),
  });

  // Flip corpse run records so failed-runs picks them up.
  const nowMs = Date.parse(now);
  for (const f of safeList(join(sys, "runs")).filter((f) => f.endsWith(".json"))) {
    const path = join(sys, "runs", f);
    const run = safeJson(path);
    if (!isStuckRun(run, nowMs)) continue;
    try {
      writeJsonAtomic(path, {
        ...run,
        status: "error",
        ts_completed: now,
        summary: `watchdog: stuck at "running" past ${STUCK_RUN_MIN}m — marked failed`,
      });
      log(`fleet: flipped stuck run ${run.id || f} to error`);
    } catch (e) {
      log(`fleet: could not flip stuck run ${f}: ${e.message}`);
    }
  }

  // One kick per new staleness episode; a kick failure is logged, never fatal.
  for (const id of health.kicks) {
    const target = KICK_TARGETS[id];
    try {
      if (target === "agenda-sync") await agendaSync("watchdog");
      else if (target === "morphy-sync") await morphySync("watchdog");
      else kickstart(target);
      log(`fleet: kicked ${id} (${target})`);
    } catch (e) {
      log(`fleet: kick ${id} failed: ${e.message}`);
    }
  }

  if (health.newlyStale.length) {
    const stale = health.producers
      .filter((p) => health.newlyStale.includes(p.id))
      .map((p) => ({ id: p.id, reason: p.reason }));
    notify({ type: "fleet-stale", stale });
  }

  const { kicks: _k, newlyStale: _n, ...persisted } = health;
  writeJsonAtomic(healthPath, persisted);
  if (!health.ok) {
    log(`fleet: stale = ${health.producers.filter((p) => p.stale).map((p) => p.id).join(", ")}`);
  }
  return health;
}
