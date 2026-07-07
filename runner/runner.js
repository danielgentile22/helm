#!/usr/bin/env node
/**
 * Agentic OS Runner — background skill executor for the HELM HUD.
 *
 * Watches `<vault>/system/queue/<uuid>.json`, processes intents, shells
 * `claude -p "<prompt>"`, writes `system/runs/<uuid>.json` + `<uuid>.md`.
 * The HUD writes intents (buttons + voice); this daemon does the work.
 *
 * Run it: `node runner/runner.js` (or start-runner.vbs hidden at login).
 * Crash-safe: logs uncaught exceptions. No external deps — Node 20+.
 *
 * ADDING A SKILL: add a case to deliverablePathFor() + buildPrompt(), then
 * add the same name to ALLOWED_SKILLS in lib/skills.ts (the HUD refuses
 * skills it doesn't know). Keep the SPOKEN SUMMARY CONTRACT preamble — the
 * first line of the claude reply is read aloud by the voice layer.
 */

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { watch } from "node:fs/promises";
import { queryTasks, createTask } from "./notion.js";
import { notify, loadNotifyConfig } from "./notify.js";
import { fleetCheck } from "./fleet.js";
import { loadEnvFile } from "./env.js";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

// The one version source is package.json — the heartbeat must never drift
// from it again (test-skill-contract.ts asserts they match).
export const PKG_VERSION = JSON.parse(
  readFileSync(join(RUNNER_DIR, "..", "package.json"), "utf8")
).version;

// --- Config — env vars first (shell or ~/.claude/.env). VAULT_ROOT is
// required and has no default; the runner exits if it's unset (see below).
const _env = loadEnvFile();
const env = (k) => process.env[k] || _env[k];

const VAULT_ROOT = env("VAULT_ROOT");
if (!VAULT_ROOT) {
  console.error(
    "[runner] VAULT_ROOT is not set. HELM has no vault to read or write. Set " +
      "it in your shell or ~/.claude/.env — e.g. VAULT_ROOT=/Users/you/Projects/Vault " +
      "— then restart the runner."
  );
  process.exit(1);
}
// MUST match HUD_TZ in lib/config.ts — "today" has to mean the same day in
// both places or daily notes split across two dates near midnight UTC.
// (test-skill-contract.ts asserts the two defaults are identical.)
const HUD_TZ = env("HUD_TZ") || "America/New_York";
const QUEUE_DIR = join(VAULT_ROOT, "system", "queue");
const RUNS_DIR = join(VAULT_ROOT, "system", "runs");
const STATUS_FILE = join(VAULT_ROOT, "system", "runner-status.json");
const RUNNER_LOG = join(RUNNER_DIR, "runner.log");

// --- Morphy ↔ Notion ------------------------------------------------------
// The runner owns ALL Notion I/O. NOTION_TOKEN (secret) and MORPHY_DB_ID (the
// board's database id) both come from ~/.claude/.env. morphySync() pulls
// the board → a JSON cache the HUD reads + a human snapshot in the vault.
const NOTION_TOKEN = env("NOTION_TOKEN") || null;
const MORPHY_DB_ID = env("MORPHY_DB_ID") || null;
const MORPHY_DIR = join(VAULT_ROOT, "Atlas", "Projects", "Morphy");
const MORPHY_STATE_FILE = join(VAULT_ROOT, "system", "morphy-state.json");
// Native skills run in Node here (Notion REST), NOT via headless `claude -p`.
// Exported so the skill-contract test can assert each ALLOWED_SKILL is either
// native or has a prompt-builder case + deliverable path (see test-skill-contract).
export const NATIVE_SKILLS = new Set(["morphy-sync", "morphy-task-add"]);
const MORPHY_SYNC_INTERVAL_MS = 30 * 60_000;

// Calendar agenda cache (issue #56). A deterministic Python feed
// (feeds/calendar-agenda.py) authenticated directly to the Google Calendar API
// writes system/agenda.json; the runner spawns it on the same startup +
// AGENDA_SYNC_MIN cadence and validates the write (the HUD reads the cache and
// never calls Calendar — same local-only firewall as the Morphy board). No LLM,
// no MCP: the old headless `claude -p` agenda agent — 689 of 712 headless
// sessions, half of them hitting a write-before-read error — is gone.
const AGENDA_STATE_FILE = join(VAULT_ROOT, "system", "agenda.json");
const AGENDA_SYNC_INTERVAL_MS = (Number(env("AGENDA_SYNC_MIN")) || 30) * 60_000;
// A deterministic HTTP call, not an LLM session — seconds, not minutes.
const AGENDA_SYNC_TIMEOUT_MS = 45_000;
// Fleet watchdog cadence (issue #58) — cheap file stats, so 5 min is fine.
const FLEET_CHECK_INTERVAL_MS = 5 * 60_000;
// Same interpreter the other feeds' launchd jobs use; env-overridable.
const AGENDA_PYTHON = env("PYTHON_BIN") || "/usr/local/bin/python3";
const AGENDA_FEED = join(RUNNER_DIR, "..", "feeds", "calendar-agenda.py");

const IS_WINDOWS = platform() === "win32";
const CLAUDE_BIN = IS_WINDOWS ? "claude.exe" : "claude";
// Pin the model for ALL headless spawns — never inherit the interactive CLI
// default. Defaults to opus for the best skill output; set AGENTIC_OS_MODEL in
// ~/.claude/.env to a cheaper model (claude-sonnet-4-6 / claude-haiku-4-5-...)
// if you'd rather trade quality for cost. Onboarding asks which you want.
const CLAUDE_MODEL = env("AGENTIC_OS_MODEL") || "claude-opus-4-8";
// Per-run override — voice asks may carry args.model ("use opus" spoken in
// the ask). Allowlist only; anything else falls back to CLAUDE_MODEL.
const MODEL_ALLOWLIST = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
]);

function modelFor(intent) {
  const m = intent?.args?.model;
  return typeof m === "string" && MODEL_ALLOWLIST.has(m) ? m : CLAUDE_MODEL;
}

// --- Native macOS notifications --------------------------------------------
// Fired from the runner (not the browser) so alerts land with no HUD tab open.
// A run finishing with a deliverable, a run failing, and a Morphy board delta
// each post a banner via runner/notify.js → osascript. Gate them with
// HELM_NOTIFY (off disables all) and HELM_NOTIFY_EVENTS (comma list of types).
const NOTIFY_CONFIG = loadNotifyConfig(env);

function writeHeartbeat() {
  try {
    writeJson(STATUS_FILE, {
      ts: new Date().toISOString(),
      pid: process.pid,
      version: PKG_VERSION,
      busy: active > 0,
      active,
      max_concurrent: MAX_CONCURRENT,
      pending: pending.length,
      in_flight: [...inFlight],
    });
  } catch {
    /* ignore */
  }
}

// ponytail: single .1 rollover at 5 MB, no numbered archive chain
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (existsSync(RUNNER_LOG) && statSync(RUNNER_LOG).size > LOG_MAX_BYTES) {
      renameSync(RUNNER_LOG, `${RUNNER_LOG}.1`);
    }
  } catch {
    /* ignore */
  }
  try {
    appendFileSync(RUNNER_LOG, line, "utf8");
  } catch {
    /* ignore */
  }
  console.log(line.trimEnd());
}

function ensureDirs() {
  for (const d of [QUEUE_DIR, RUNS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// Nothing else ever cleans system/runs (vault-cleanup explicitly skips
// system/), so the HUD's 5s poll would stat/parse a forever-growing dir.
// ponytail: plain delete after 30 days — add an archive/ move if old run
// transcripts ever turn out to matter.
const RUN_RETENTION_MS = 30 * 24 * 3600 * 1000;

export function pruneRuns(dir = RUNS_DIR, now = Date.now()) {
  let pruned = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json") && !f.endsWith(".md")) continue;
      const p = join(dir, f);
      try {
        if (now - statSync(p).mtimeMs > RUN_RETENTION_MS) {
          unlinkSync(p);
          pruned++;
        }
      } catch {
        /* vanished mid-scan — ignore */
      }
    }
  } catch {
    /* dir unreadable — ignore */
  }
  if (pruned) log(`pruned ${pruned} run file(s) older than 30 days`);
  return pruned;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Write-to-temp-then-rename: rename is atomic on APFS, so the HUD (and the
// Syncthing replica) can never read a half-written state file.
export function writeJson(path, obj) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function slugify(s, max = 48) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max) || "untitled";
}

export function todayDate() {
  // Local (HUD_TZ) YYYY-MM-DD. toISOString() returns UTC, which flips to
  // tomorrow's date in the evening for western timezones — wrong for "today".
  return new Intl.DateTimeFormat("en-CA", { timeZone: HUD_TZ }).format(new Date());
}

function tomorrowDate() {
  const todayLocal = todayDate();
  const [y, m, d] = todayLocal.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(next);
}

/**
 * Per-skill deliverable path inside the vault — where the user-facing
 * artifact lands. The HUD's Documents panel + doc callouts deep-link here.
 */
export function deliverablePathFor(intent) {
  const id8 = (intent.id || "x").slice(0, 8);
  const date = todayDate();
  const args = intent.args || {};
  switch (intent.skill) {
    case "plan-today":
      return `daily-notes/${date}.md`;
    case "plan-tomorrow":
      return `daily-notes/${tomorrowDate()}.md`;
    case "morning-report":
      return `inbox/reports/morning/${date}-morning-report-${id8}.md`;
    case "inbox-brief":
      return `inbox/reports/inbox-briefs/${date}-${id8}.md`;
    case "vault-cleanup":
      return `inbox/reports/vault-cleanup/${date}-cleanup-${id8}.md`;
    case "weekly-review":
      return `inbox/reports/weekly/${date}-weekly-review-${id8}.md`;
    case "atlas-distill":
      return `inbox/reports/atlas-distill/${date}-distill-${id8}.md`;
    case "voice-ask":
      return `inbox/voice/${date}-${slugify(args.prompt || "ask")}-${id8}.md`;
    default:
      return null;
  }
}

// Standard headless preamble. Blocks AskUserQuestion (which stalls skills in
// non-interactive -p mode) and carries the SPOKEN SUMMARY CONTRACT — the
// first line of every reply is read aloud verbatim by the voice layer.
const AUTONOMOUS_PREFIX =
  "Execute the requested task autonomously in headless mode. Do not ask the user for confirmation. Do not call AskUserQuestion. Continue until the deliverable is written.\n\nSPOKEN SUMMARY CONTRACT: the FIRST line of your final reply is read aloud to the user by a voice assistant. Make it ONE conversational sentence (max ~140 chars) a calm butler would say - lead with the outcome PLUS two or three concrete highlights from what you produced (names, titles, the numbers that matter) — 'the report is done' with no specifics is useless, round big numbers to clean magnitudes (say 'about 13 thousand', never '13,206'). Never mention: headless, autonomous, task, deliverable, file paths, markdown, or process narration ('waiting for', 'running'). Every other detail belongs in the written deliverable, not the spoken line.";

/**
 * Map intent.skill → the prompt passed to `claude -p`. Every prompt is
 * SELF-CONTAINED — no dependency on locally installed slash-skills — and
 * must instruct the model to write the deliverable at the exact path.
 *
 * Two prompts use Anthropic MCP connectors when present (Google Calendar in
 * plan-today/plan-tomorrow, Gmail in inbox-brief); without the connector the
 * model degrades gracefully and says so in the note.
 */
export function buildPrompt(intent, deliverable) {
  const skill = intent.skill;
  const args = intent.args || {};

  switch (skill) {
    case "plan-today":
      return `${AUTONOMOUS_PREFIX}\n\nTask: plan today's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read the last 3 daily notes under daily-notes/ for incomplete Top 3 priorities and reflections (carryover candidates).\n2. If a Google Calendar MCP connector is available, pull today's events (timeZone=${HUD_TZ}, sorted by start time). If not, skip the schedule.\n3. Scan Atlas/Projects/*.md (if the folder exists) for active or due items.\n4. Pick the 3 highest-leverage priorities: carryover from yesterday beats new, due-today beats someday.\n5. Write the daily note following the schema at system/schemas/daily-note.md — exact section order. If the note already exists, MERGE: fill only empty Top 3 slots and replace ## Schedule; never overwrite user-set text.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "plan-tomorrow":
      return `${AUTONOMOUS_PREFIX}\n\nTask: draft tomorrow's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read today's daily note for unfinished Top 3 priorities (carryover).\n2. If a Google Calendar MCP connector is available, pull tomorrow's events (timeZone=${HUD_TZ}).\n3. Suggest 3 priorities for tomorrow.\n4. Write the note following the schema at system/schemas/daily-note.md.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "morning-report":
      return `${AUTONOMOUS_PREFIX}\n\nTask: produce Daniel's personalized morning briefing and save it at exactly ${deliverable}.\n\nResearch the last ~24 hours via web search across Daniel's beat: (1) AI tooling and agent/dev-tool launches plus notable AI startup news and funding; (2) the job market for AI and software-engineering roles — hiring trends, notable openings, layoffs; (3) DMV-area (DC / Maryland / Virginia) tech and local news, falling back to major US/world headlines if the DMV is quiet; (4) chess news — major tournaments, results, notable games; (5) antenna / RF / wireless-industry news relevant to Morphy Consulting. Structure the note: top-level "# Morning Report" + "**Date:** <today>", then "## Headlines" (3-5 bullets ranked by impact ACROSS all beats; each bullet MUST end with a markdown link to its primary source, e.g. [source](https://...)), then "## AI & Startups", "## Jobs — AI & SWE Market", "## DMV & General News", "## Chess", "## RF & Antennas — Morphy Consulting", "## Morphy Board", "## Sources". For "## Morphy Board": read system/morphy-state.json (the runner's cache of the shared Notion task board) and report the open task count, ideas awaiting review, and any overnight changes from its delta (delta.added / delta.closed, naming a few); if that file is missing or its "ok" field is false, write a single line noting the board isn't syncing. Omit a topical NEWS section if there is genuinely nothing worth reporting, but always include "## Morphy Board" when the cache file exists. YAML frontmatter: \`date\`, \`skill: morning-report\`, \`tags: [morning, briefing]\`.\n\nThe HUD's AI Wire panel and the spoken daily brief both read the ## Headlines section — keep those bullets tight.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "inbox-brief":
      return `${AUTONOMOUS_PREFIX}\n\nTask: triage the Gmail inbox and save the brief at exactly ${deliverable}.\n\nSteps:\n1. Pull the last 24h via the Anthropic Gmail MCP connector — mcp__claude_ai_Gmail__search_threads with query "in:inbox newer_than:1d", pageSize 50. If the connector is unavailable, write a short note saying so and stop.\n2. Classify each thread: urgent (deadlines, money, blocked people) / warm (real humans worth replying to) / opportunities (sponsorships, partnerships) / meetings / noise.\n3. Save the triage at ${deliverable}. YAML frontmatter \`date\`, \`skill: inbox-brief\`, \`tags: [inbox, triage]\`. Body groups messages by category, most urgent first.\n4. Do NOT send anything — drafting and sending stay manual.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "vault-cleanup":
      return `${AUTONOMOUS_PREFIX}\n\nTask: tidy the vault and report at exactly ${deliverable}.\n\nScan the vault for stale files (untouched > 7 days, outside system/ and archive/). Move them into archive/ subfolders mirroring their source folder. Write a one-page report at ${deliverable} — YAML frontmatter \`date\`, \`skill: vault-cleanup\`, \`tags: [cleanup, ops]\`; body lists what moved and what was skipped.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "weekly-review":
      return `${AUTONOMOUS_PREFIX}\n\nTask: produce Daniel's weekly review — a Sunday synthesis of the past 7 days across his three standing directives — and save it at exactly ${deliverable}.\n\nDaniel's directives, in priority order: (1) land a software-engineering job; (2) land the first client for Morphy Consulting (RF/antenna + cell-tower lease analytics); (3) reach a 1600 USCF chess rating. Frame the whole review around these three.\n\nGather the week's evidence from the vault (all paths relative to the current directory — read what exists, skip what doesn't):\n1. Daily notes — read every daily-notes/YYYY-MM-DD.md from the last 7 days. Pull completed vs. carried-over Top 3 priorities, the focus line, and anything notable in the notes.\n2. Delivered reports — skim this week's reports under inbox/reports/ (morning/, inbox-briefs/, vault-cleanup/, and any prior weekly/) for events or items worth carrying into the synthesis.\n3. Morphy board — read system/morphy-state.json (the runner's cache of the shared Notion board): open task count, ideas awaiting review, who owns what, and the week's adds/closes from its delta. If the file is missing or its "ok" field is false, note the board isn't syncing and move on.\n4. Metric history — read system/metrics/metrics.csv (columns: timestamp,source,metric,value,status,error). For each directive's metric compute the week-over-week move (first vs. last point in the window): uscf/rating (chess), jobs/applications and jobs/applied_7d (job search), github/commits_7d + open_prs + open_issues (Morphy code), claude_code/tokens_5h (overall activity). Report start→end and the delta; say "flat" when a number didn't move.\n5. Atlas — Daniel's curated thinking, the notes he actually maintains. Skim any Atlas/Decisions/ notes dated within the week, and check the directive-relevant Areas notes for recent changes — especially "Atlas/Areas/Career - Applications & Roles.md" and "Atlas/Areas/Career - Job Search.md" (job search) and "Atlas/Areas/Chess - Tournament Log.md" (chess). What he wrote there outranks what the machine-generated files imply — cite it in the directive sections.\n\nStructure the note: top-level "# Weekly Review" + "**Week of:** <Mon date>–<Sun date>", then "## At a Glance" (3-5 bullets — the week's headline across all three directives, each naming the metric that moved), then one section per directive: "## Job Search", "## Morphy Consulting", "## Chess — Road to 1600". In each: what actually happened this week (from the notes/reports), the metric trend, and a one-word verdict — advanced / held / stalled. Then "## Momentum & Metrics" (a compact markdown table: metric, start, end, delta), then "## Next Week" (3 concrete, directive-aligned priorities drawn from what's still unfinished). Be specific and grounded — cite real numbers and real task names; never invent activity that isn't in the files. If a directive had no activity this week, say so plainly rather than padding.\n\nYAML frontmatter: \`date\`, \`skill: weekly-review\`, \`tags: [weekly, review]\`.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "atlas-distill":
      return `${AUTONOMOUS_PREFIX}\n\nTask: distill the vault's raw layer into Atlas canon, then save a distill report at exactly ${deliverable}.\n\nAtlas/ is the vault's canon — clean, deduped, hand-curated knowledge. Raw material (daily notes, voice answers, chat threads, inbox reports) accumulates knowledge that never gets promoted there. Your job: find what is canon-worthy in the recent raw layer and promote it.\n\nInput window: read system/runs/*.json for the most recent record with "skill": "atlas-distill" and "status": "ok" — its ts_completed is the cutoff; only consider raw files modified after it. If no such record exists, use the last 7 days.\n\nSources (all paths relative to the current directory; read what exists, skip what doesn't): daily-notes/, inbox/voice/, inbox/chats/, and inbox/reports/ (excluding inbox/reports/atlas-distill/). NEVER read system/ or archive/ as sources, and never cite the Morphy board files (Atlas/Projects/Morphy/_board-snapshot.md, system/morphy-state.json) as canon — they are regenerated from Notion.\n\nCanon-worthy means: (a) a commitment Daniel will act on later, (b) a change to a standing workflow, tool, or configuration, or (c) a durable fact future sessions need that repos/git history don't hold. NOT canon-worthy: news items, schedule entries, metric readings, one-off task chatter — those already have homes. Anything tagged #sensitive (or inside a #sensitive note) is NEVER promoted.\n\nTwo-tier write policy:\n- Tier 1 (apply directly): durable facts that fit an EXISTING Atlas/Areas/ note. Append a dated bullet ("- YYYY-MM-DD: <fact>") in the note's existing style and bump its \`updated:\` frontmatter. APPEND-ONLY — never rewrite, reorder, or delete existing lines. Before appending, check the note for an equivalent existing fact (same date + substance) and skip duplicates.\n- Tier 2 (draft, never apply): new Atlas/Decisions/ records, new Area files, and anything that CONTRADICTS existing canon. Put these in the report as ready-to-paste drafts, each with a proposed filename following the existing conventions (Decisions: YYYY-MM-DD-slug.md with type: decision frontmatter). Never auto-resolve a contradiction — flag it and quote both sides.\n\nReport at ${deliverable}: YAML frontmatter \`date\`, \`skill: atlas-distill\`, \`tags: [atlas, distill]\`, and \`pending-review: true\` if the report contains any Tier-2 drafts (false otherwise). Body: "# Atlas Distill", then "## Applied" (every Tier-1 append — target note + the exact bullet added), then "## Drafts for review" (each Tier-2 draft with proposed filename), then "## Skipped" (notable items judged not canon-worthy or duplicate, one line each). If NOTHING was canon-worthy, still write the report with a single line saying so — no padding, no noise appends to Atlas.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "voice-ask": {
      const ask = (args.prompt || "").trim();
      if (!ask) return null;
      const convo = (args.context || "").trim();
      const convoBlock = convo
        ? `\n\nRecent voice conversation (context — the ask may refer back to it):\n${convo}`
        : "";
      return `${AUTONOMOUS_PREFIX}\n\nVoice request from the user (spoken via push-to-talk, machine-transcribed — minor transcription errors possible): ${JSON.stringify(ask)}${convoBlock}\n\nDo the task fully. Write the complete result as a markdown note at exactly ${deliverable} — YAML frontmatter \`date\`, \`skill: voice-ask\`, \`prompt: ${JSON.stringify(ask)}\`, \`tags: [voice]\`. If the REAL output of the task lives at a URL — a Gmail draft you created (the create_draft response includes the draft's message id — deep-link it: https://mail.google.com/mail/u/0/#drafts?compose=<message id>; only if no id came back, fall back to https://mail.google.com/mail/#drafts), a video, a doc, a page — ALSO add \`link: <that url>\` to the frontmatter; the dashboard will send the user there directly instead of to this note.\n\nIMPORTANT: the FIRST LINE of your final reply is read aloud to the user by text-to-speech. Make it ONE conversational sentence (under 200 characters) that directly answers the ask or states the outcome — no markdown, no file paths in it. After that line, end with: SAVED ${deliverable}`;
    }
    // --- EXAMPLE: adding your own skill -----------------------------------
    // case "my-skill":
    //   return `${AUTONOMOUS_PREFIX}\n\nTask: <what to do>. Save the result
    //   at exactly ${deliverable} with YAML frontmatter \`date\`,
    //   \`skill: my-skill\`. End your reply with: SAVED ${deliverable}`;
    // (also add a path in deliverablePathFor() and the name to
    //  ALLOWED_SKILLS in lib/skills.ts)
    default:
      return null;
  }
}

// Worker pool — parallel execution gated by category.
// MAX_CONCURRENT caps total in-flight claude -p subprocesses. SERIAL_SKILLS
// share one slot among themselves (they write the same shared file — the
// daily note). DEDUPE_SKILLS reject a new intent while the same skill is
// already in-flight.
const MAX_CONCURRENT = 3;
const SERIAL_SKILLS = new Set(["plan-today", "plan-tomorrow"]);
const DEDUPE_SKILLS = new Set(["morning-report", "inbox-brief", "weekly-review", "atlas-distill"]);
// Long-haul skills get a 20-min hard timeout instead of 10 — web-research and
// the week-spanning weekly synthesis routinely take longer than you'd guess.
const LONG_SKILLS = new Set(["morning-report", "weekly-review", "atlas-distill"]);
// Stall watchdog for LONG_SKILLS: a wedged claude -p (network/MCP hang)
// streams NOTHING — the 2026-06-28 weekly-review burned its whole 20-min
// timeout with an empty output block and the week's report was lost. Every
// healthy long run on record finishes in 2-3 min, so 5 silent minutes means
// dead, not slow. Stall-killed runs are requeued exactly once (see retryIntent).
export const STALL_TIMEOUT_MS = 5 * 60_000;

// Fresh intent for the one retry a stall-kill earns. New id (a completed run
// record for the old id blocks replays); retry:1 in the JSON stops loops —
// a retried intent that stalls again just fails.
export function retryIntent(intent) {
  if ((intent.retry || 0) >= 1) return null;
  return {
    id: randomUUID(),
    skill: intent.skill,
    args: intent.args || {},
    ts: new Date().toISOString(),
    source: intent.source || "runner",
    retry: (intent.retry || 0) + 1,
  };
}

let active = 0;
const inFlight = new Set(); // intent.skill values currently running
const pending = []; // queue filenames awaiting a slot
const processing = new Set(); // queue filenames currently being processed

// Intent files are always named `${crypto.randomUUID()}.json` (lib/skills.ts
// writeIntent, scripts/queue-intent.mjs). Anchoring the scan to that shape
// keeps Syncthing conflict copies (`<uuid>.sync-conflict-…json` — still ends
// in .json!) from re-executing a side-effectful skill as a fresh intent.
const UUID_JSON_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

export function isIntentFile(name) {
  return UUID_JSON_RE.test(String(name || ""));
}

function enqueueNew() {
  if (!existsSync(QUEUE_DIR)) return;
  const files = readdirSync(QUEUE_DIR).filter(isIntentFile);
  for (const f of files) {
    // processing guard — the queue file stays on disk until processOne
    // unlinks it at the end of the run; without this every poll re-adds
    // in-flight intents and the scheduler spawns DUPLICATE claude sessions
    if (!pending.includes(f) && !processing.has(f)) pending.push(f);
  }
}

function peekSkill(fileName) {
  try {
    const intent = readJson(join(QUEUE_DIR, fileName));
    return intent.skill || null;
  } catch {
    return null;
  }
}

// A file can be unreadable because its write hasn't flushed yet (tolerate) or
// because it's permanently poison — torn JSON, missing `skill` (dead-letter).
// After POISON_SKIPS ticks we hand it to processOne anyway, whose bad-json /
// unknown-skill paths write an error run record and unlink it.
const POISON_SKIPS = 10;
const skipCounts = new Map();

export function pickNext(pend = pending, flight = inFlight) {
  const serialBusy = [...flight].some((s) => SERIAL_SKILLS.has(s));
  for (let i = 0; i < pend.length; i++) {
    const skill = peekSkill(pend[i]);
    if (!skill) {
      const n = (skipCounts.get(pend[i]) || 0) + 1;
      skipCounts.set(pend[i], n);
      if (n <= POISON_SKIPS) continue; // unreadable yet (write race) — try later
      skipCounts.delete(pend[i]);
      return i; // poison — let processOne dead-letter it
    }
    skipCounts.delete(pend[i]);
    if (DEDUPE_SKILLS.has(skill) && flight.has(skill)) continue;
    if (SERIAL_SKILLS.has(skill) && serialBusy) continue;
    return i;
  }
  return -1;
}

// The spoken summary comes from stdout ONLY — stderr diagnostics (node
// warnings, MCP noise) must never end up in the TTS line.
export function summaryFromOutput(stdoutText) {
  const lines = String(stdoutText || "").trim().split(/\r?\n/);
  return (
    lines.find((l) => l.trim().length > 0 && !/^warning:/i.test(l)) ||
    lines.find((l) => l.trim().length > 0) ||
    "(no output)"
  );
}

// Exit code 0 alone doesn't make a run "ok" — the promised deliverable has to
// actually be on disk, or the success banner points at a 404.
export function runOutcome(code, deliverable) {
  if (code === 0 && deliverable && !existsSync(join(VAULT_ROOT, deliverable))) {
    return { status: "error", missing: true };
  }
  return { status: code === 0 ? "ok" : "error", missing: false };
}

// Rewrite the run .md's `status: running` frontmatter on completion so the
// note is a self-consistent record (Dataview etc. read frontmatter, not the
// footer). Non-global /m replace → only the first (frontmatter) occurrence.
export function finalizeRunMd(md, status, tsCompleted) {
  return String(md).replace(
    /^status: running$/m,
    `status: ${status}\nts_completed: ${tsCompleted}`
  );
}

// Kill the child's whole process group (spawned detached → it leads one), so
// grandchildren (MCP servers, shell tools) die too and can't hold the stdio
// pipes open or keep mutating the vault after a timeout.
function killTree(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// Retire a claimed queue file into an error run record — used by the boot
// sweep (runner died mid-run) and by loop() when processOne itself crashes.
export function retireClaim(fileName, summary) {
  const p = join(QUEUE_DIR, `${fileName}.claimed`);
  if (!existsSync(p)) return;
  let intent = null;
  try {
    intent = readJson(p);
  } catch {
    /* unreadable — retire it anyway */
  }
  const runId = intent?.id || basename(fileName, ".json");
  const ts = new Date().toISOString();
  try {
    writeJson(join(RUNS_DIR, `${runId}.json`), {
      id: runId,
      skill: intent?.skill || "(unknown)",
      args: intent?.args || {},
      ts_queued: intent?.ts || ts,
      ts_started: ts,
      ts_completed: ts,
      status: "error",
      exit_code: -4,
      summary: summary.slice(0, 200),
      md_path: `system/runs/${runId}.md`,
      log_path: `system/runs/${runId}.md`,
      deliverable_path: null,
    });
  } catch {
    /* ignore — the unlink below still stops the replay */
  }
  try {
    unlinkSync(p);
  } catch {
    /* ignore */
  }
  log(`${runId}: retired claimed intent — ${summary}`);
}

// On boot, sweep claims left by a runner that died mid-run. Re-running them
// would duplicate external side effects (Notion rows, Gmail drafts), so they
// become visible error records instead.
function sweepOrphanedClaims() {
  if (!existsSync(QUEUE_DIR)) return;
  for (const f of readdirSync(QUEUE_DIR)) {
    if (!f.endsWith(".json.claimed")) continue;
    retireClaim(f.slice(0, -".claimed".length), "orphaned by a runner restart mid-run — re-queue manually if still wanted");
  }
}

async function processOne(fileName) {
  const queuePath = join(QUEUE_DIR, fileName);
  // Claim on disk FIRST — rename is atomic, so a crash or `launchctl
  // kickstart -k` mid-run leaves a .claimed file the boot sweep retires,
  // never a live intent that silently re-executes its side effects.
  const claimedPath = `${queuePath}.claimed`;
  try {
    renameSync(queuePath, claimedPath);
  } catch {
    return; // vanished or already claimed — nothing to do
  }

  let intent;
  let lastErr = null;
  // Retry with backoff — covers the race where the intent file exists but
  // hasn't flushed content yet.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      intent = readJson(claimedPath);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr || !intent) {
    const runId = basename(fileName, ".json");
    const ts = new Date().toISOString();
    writeJson(join(RUNS_DIR, `${runId}.json`), {
      id: runId,
      skill: "(unknown)",
      args: {},
      ts_queued: ts,
      ts_started: ts,
      ts_completed: ts,
      status: "error",
      exit_code: -3,
      summary: `bad intent json after 5 retries: ${lastErr?.message || "empty"}`.slice(0, 200),
      md_path: `system/runs/${runId}.md`,
      log_path: `system/runs/${runId}.md`,
      deliverable_path: null,
    });
    log(`${runId}: bad json — wrote error run record: ${lastErr?.message}`);
    try {
      unlinkSync(claimedPath);
    } catch {
      /* ignore */
    }
    return;
  }

  const runId = intent.id || basename(fileName, ".json");

  // Second layer against replayed intents (conflict copies share the same
  // intent.id): an id that already completed must never run again.
  try {
    const prior = readJson(join(RUNS_DIR, `${runId}.json`));
    if (prior && prior.ts_completed) {
      log(`${runId}: already completed ${prior.ts_completed} — dropping duplicate queue file`);
      try {
        unlinkSync(claimedPath);
      } catch {
        /* ignore */
      }
      return;
    }
  } catch {
    /* no prior record — proceed */
  }

  // Native skills (Morphy ↔ Notion) run in-process via REST — no `claude -p`.
  if (NATIVE_SKILLS.has(intent.skill)) {
    await processNative({ ...intent, id: runId }, runId, claimedPath);
    return;
  }

  const runJsonPath = join(RUNS_DIR, `${runId}.json`);
  const runMdPath = join(RUNS_DIR, `${runId}.md`);
  const deliverable = deliverablePathFor({ ...intent, id: runId });

  const tsStarted = new Date().toISOString();
  const status = {
    id: runId,
    skill: intent.skill,
    args: intent.args || {},
    ts_queued: intent.ts || tsStarted,
    ts_started: tsStarted,
    ts_completed: null,
    status: "running",
    exit_code: null,
    summary: "",
    md_path: `system/runs/${runId}.md`,
    log_path: `system/runs/${runId}.md`,
    deliverable_path: deliverable,
  };
  writeJson(runJsonPath, status);

  const prompt = buildPrompt({ ...intent, id: runId }, deliverable);
  if (!prompt) {
    status.status = "error";
    status.exit_code = -1;
    status.summary = `unknown or invalid intent: ${intent.skill}`;
    status.ts_completed = new Date().toISOString();
    writeJson(runJsonPath, status);
    try {
      unlinkSync(claimedPath);
    } catch {
      /* ignore */
    }
    log(`${runId}: rejected — ${status.summary}`);
    return;
  }

  const runModel = modelFor(intent);
  log(
    `${runId}: running skill=${intent.skill}` +
      (runModel !== CLAUDE_MODEL ? ` model=${runModel} (per-ask override)` : "")
  );

  // Markdown run log with frontmatter so it renders as a note in the vault.
  const argsJson = JSON.stringify(intent.args || {});
  writeFileSync(
    runMdPath,
    `---
run_id: ${runId}
skill: ${intent.skill}
status: running
ts_queued: ${intent.ts || tsStarted}
ts_started: ${tsStarted}
args: ${argsJson}
---

# ${intent.skill} run

> in progress — output streams below.

\`\`\`
`,
    "utf8"
  );

  const out = []; // stdout only — the spoken summary is derived from this
  let stalled = false; // set by the stall watchdog — triggers the one retry below
  await new Promise((resolve) => {
    // --dangerously-skip-permissions: headless `claude -p` runs non-interactive,
    // so the default permission mode DENIES file writes (the deliverable never
    // lands) with no prompt to approve. A fresh install has no
    // permissions.defaultMode override, so this flag is required for ANY skill
    // to write its report. The runner only executes self-contained, dev-authored
    // skill prompts (and the user's own installed skills) against the user's own
    // vault on localhost — the same trust boundary as running the skill by hand.
    const proc = spawn(
      CLAUDE_BIN,
      ["-p", prompt, "--model", runModel, "--dangerously-skip-permissions"],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: VAULT_ROOT,
        detached: !IS_WINDOWS, // own process group → killTree reaches grandchildren
      }
    );

    let lastOutput = Date.now(); // either pipe counts — stderr chatter still means alive

    proc.stdout.on("data", (chunk) => {
      lastOutput = Date.now();
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });
    // stderr still lands in the run .md, but stays out of `out` so CLI
    // diagnostics can never become the spoken summary.
    proc.stderr.on("data", (chunk) => {
      lastOutput = Date.now();
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });

    const HARD_TIMEOUT_MIN = LONG_SKILLS.has(intent.skill) ? 20 : 10;
    let drainTimer = null;
    const timer = setTimeout(() => {
      out.push(`\n[runner: hard timeout ${HARD_TIMEOUT_MIN}m — killed]\n`);
      killTree(proc, "SIGTERM");
      // ponytail: fixed 10 s grace, then SIGKILL — no configurable escalation.
      // Never cancelled: SIGTERM-ignoring grandchildren must die even if the
      // run settles first (killTree on a dead group is a no-op).
      setTimeout(() => killTree(proc, "SIGKILL"), 10_000);
    }, 1000 * 60 * HARD_TIMEOUT_MIN);

    // Stall watchdog — LONG_SKILLS only (the short 10-min skills fail fast
    // enough on their own). Checked every 30s; cleared in finalize.
    const stallTimer = LONG_SKILLS.has(intent.skill)
      ? setInterval(() => {
          if (Date.now() - lastOutput <= STALL_TIMEOUT_MS) return;
          stalled = true;
          out.push(`\n[runner: stalled — no output for ${STALL_TIMEOUT_MS / 60_000}m — killed]\n`);
          killTree(proc, "SIGTERM");
          setTimeout(() => killTree(proc, "SIGKILL"), 10_000);
        }, 30_000)
      : null;

    // Everything below MUST settle the promise exactly once, whatever throws —
    // an unsettled promise here permanently leaks a concurrency slot and (for
    // DEDUPE skills) blocks that skill until a manual restart.
    let settled = false;
    const finalize = (code, spawnErrMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      if (stallTimer) clearInterval(stallTimer);
      try {
        const tsCompleted = new Date().toISOString();
        status.exit_code = spawnErrMsg ? -2 : code ?? -1;
        status.ts_completed = tsCompleted;
        if (spawnErrMsg) {
          status.status = "error";
          status.summary = spawnErrMsg.slice(0, 200);
        } else {
          const outcome = runOutcome(code, deliverable);
          status.status = outcome.status;
          status.summary = outcome.missing
            ? `exited ok but deliverable missing: ${deliverable}`.slice(0, 200)
            : summaryFromOutput(out.join("")).slice(0, 200);
        }
        try {
          writeJson(runJsonPath, status);
        } catch (e) {
          log(`${runId}: run record write failed: ${e.message}`);
        }
        try {
          const md = readFileSync(runMdPath, "utf8");
          writeFileSync(
            runMdPath,
            finalizeRunMd(md, status.status, tsCompleted) +
              `\n\`\`\`\n\n---\n*exit code=${code ?? "none"} · status=${status.status} · completed ${tsCompleted}*\n`,
            "utf8"
          );
        } catch {
          /* ignore */
        }
        log(`${runId}: completed exit=${code} status=${status.status}`);
      } catch (e) {
        try {
          log(`${runId}: finalize failed: ${e.message}`);
        } catch {
          /* ignore */
        }
      } finally {
        resolve();
      }
    };

    proc.on("close", (code) => finalize(code));
    // 'close' waits for the stdio pipes to drain — a grandchild that inherited
    // them can hold it open after the child died. 'exit' + a short drain
    // window guarantees the run settles either way.
    proc.on("exit", (code) => {
      drainTimer = setTimeout(() => finalize(code), 5000);
    });
    proc.on("error", (err) => {
      try {
        appendFileSync(runMdPath, `\n[runner spawn error] ${err.message}\n`);
      } catch {
        /* ignore */
      }
      finalize(null, `spawn error: ${err.message}`);
    });
  });

  // Stall-killed run → requeue once. The retry lands as a normal queue file
  // the scheduler picks up next tick (the skill leaves inFlight when this
  // processOne returns, so DEDUPE doesn't block it).
  let requeued = false;
  if (stalled && status.status === "error") {
    const retry = retryIntent(intent);
    if (retry) {
      try {
        writeJson(join(QUEUE_DIR, `${retry.id}.json`), retry);
        requeued = true;
        log(`${runId}: stalled — requeued ${intent.skill} as ${retry.id} (retry ${retry.retry})`);
      } catch (e) {
        log(`${runId}: stall retry write failed: ${e.message}`);
      }
    }
  }

  // Native banner: a deliverable landing → run-complete, any error → run-failed.
  // Fire-and-forget; a notification failure must never affect the run.
  // A stall that just requeued isn't a failure yet — the retry's own outcome
  // notifies; banner-then-success two minutes later would cry wolf.
  try {
    if (status.status === "ok" && deliverable) {
      notify(
        { type: "run-complete", skill: intent.skill, summary: status.summary, deliverable },
        NOTIFY_CONFIG,
        log
      );
    } else if (status.status === "error" && !requeued) {
      notify(
        { type: "run-failed", skill: intent.skill, summary: status.summary },
        NOTIFY_CONFIG,
        log
      );
    }
  } catch (e) {
    log(`${runId}: notify failed: ${e.message}`);
  }

  try {
    unlinkSync(claimedPath);
  } catch {
    /* ignore */
  }
}

// --- Morphy board sync ------------------------------------------------------
// Pull the Notion Tasks DB → write system/morphy-state.json (the HUD/voice read
// this; the HUD never calls Notion) + Atlas/Projects/Morphy/_board-snapshot.md
// (human-readable, regenerated each sync). Computes a delta vs the last cache.

const STATUS_KEYS = {
  idea: "idea",
  todo: "todo",
  "in progress": "in_progress",
  blocked: "blocked",
  done: "done",
};

export function morphyCounts(tasks) {
  const counts = { idea: 0, todo: 0, in_progress: 0, blocked: 0, done: 0 };
  const open_by_assignee = { Daniel: 0, Michael: 0, Both: 0, Unassigned: 0 };
  for (const t of tasks) {
    const key = STATUS_KEYS[(t.status || "").toLowerCase()] || "todo";
    counts[key]++;
    if (key !== "done") {
      const a = open_by_assignee[t.assignee] !== undefined ? t.assignee : "Unassigned";
      open_by_assignee[a]++;
    }
  }
  // "open" = active work the team is on the hook for — excludes Ideas (proposals
  // awaiting promotion) and Done.
  const open_total = counts.todo + counts.in_progress + counts.blocked;
  return { counts, open_by_assignee, open_total, ideas_awaiting: counts.idea };
}

export function morphySnapshotMd(tasks, ts) {
  const order = ["Todo", "In progress", "Blocked", "Idea", "Done"];
  const byStatus = {};
  for (const t of tasks) (byStatus[t.status] ||= []).push(t);
  let md =
    `---\ntype: generated\ntitle: Morphy board snapshot\nsource: Notion\nupdated: ${ts}\n---\n\n` +
    `# Morphy board — snapshot\n\n> GENERATED by HELM from Notion every sync. Do not hand-edit — change tasks in Notion.\n\n`;
  for (const st of order) {
    const list = byStatus[st];
    if (!list || !list.length) continue;
    md += `## ${st} (${list.length})\n`;
    for (const t of list) {
      const meta = [
        t.assignee && t.assignee !== "Unassigned" ? `@${t.assignee}` : null,
        t.priority,
      ]
        .filter(Boolean)
        .join(" · ");
      md += `- ${t.name}${meta ? ` — ${meta}` : ""}${t.addedBy === "HELM" ? " _(HELM)_" : ""}\n`;
    }
    md += `\n`;
  }
  return md;
}

async function morphySync(reason = "scheduled") {
  let prev = null;
  try {
    prev = readJson(MORPHY_STATE_FILE);
  } catch {
    /* first run / no cache */
  }

  if (!NOTION_TOKEN) {
    const state = {
      ok: false,
      reason: "no NOTION_TOKEN in ~/.claude/.env",
      last_sync_ts: new Date().toISOString(),
    };
    try {
      writeJson(MORPHY_STATE_FILE, state);
    } catch {
      /* ignore */
    }
    return state;
  }

  let tasks;
  try {
    tasks = await queryTasks(NOTION_TOKEN, MORPHY_DB_ID);
  } catch (e) {
    const state = {
      ...(prev || {}),
      ok: false,
      reason: String(e.message || e).slice(0, 160),
      last_sync_ts: new Date().toISOString(),
    };
    try {
      writeJson(MORPHY_STATE_FILE, state);
    } catch {
      /* ignore */
    }
    log(`morphy-sync error: ${e.message}`);
    return state;
  }

  const ts = new Date().toISOString();
  const { counts, open_by_assignee, open_total, ideas_awaiting } = morphyCounts(tasks);

  // delta vs the previous cache: new task ids = added; Todo→Done = closed
  const delta = { since: prev?.last_sync_ts ?? null, added: [], closed: [] };
  if (Array.isArray(prev?.tasks)) {
    const prevById = new Map(prev.tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      const p = prevById.get(t.id);
      if (!p) delta.added.push({ name: t.name, addedBy: t.addedBy });
      else if (p.status !== "Done" && t.status === "Done") delta.closed.push(t.name);
    }
  }

  const state = {
    ok: true,
    last_sync_ts: ts,
    total: tasks.length,
    counts,
    open_total,
    open_by_assignee,
    ideas_awaiting,
    delta,
    tasks: tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      assignee: t.assignee,
      addedBy: t.addedBy,
      priority: t.priority,
      due: t.due,
    })),
  };
  try {
    writeJson(MORPHY_STATE_FILE, state);
  } catch (e) {
    log(`morphy-sync cache write failed: ${e.message}`);
  }
  try {
    if (!existsSync(MORPHY_DIR)) mkdirSync(MORPHY_DIR, { recursive: true });
    writeFileSync(join(MORPHY_DIR, "_board-snapshot.md"), morphySnapshotMd(tasks, ts), "utf8");
  } catch (e) {
    log(`morphy-sync snapshot write failed: ${e.message}`);
  }
  log(
    `morphy-sync (${reason}): ${tasks.length} tasks, ${open_total} open, ${ideas_awaiting} ideas, +${delta.added.length}/-${delta.closed.length}`
  );

  // Notify only on the background cadence — that's "Michael changed the board
  // while I was away." Skip startup (delta vs a possibly-stale cache) and the
  // user-initiated syncs (after-add / on-demand), where Daniel made the change.
  if (reason === "scheduled" && (delta.added.length || delta.closed.length)) {
    try {
      notify({ type: "morphy-delta", added: delta.added, closed: delta.closed }, NOTIFY_CONFIG, log);
    } catch (e) {
      log(`morphy-sync notify failed: ${e.message}`);
    }
  }

  return state;
}

// --- Calendar agenda cache --------------------------------------------------
// Spawn the deterministic calendar-agenda feed, then validate its write. A
// well-formed cache (ok true OR false) is the source of truth — return it
// untouched, so the feed's own typed ok:false (auth / network / deps) and its
// "never clobber a valid same-day cache" rule both stand. Only when the feed
// produced nothing usable (spawn failure, torn output, timeout) do we write a
// clean, typed ok:false here so the HUD falls back to the daily-note ## Schedule
// instead of choking. A prior good cache for a different day is left alone: the
// HUD's date check guards staleness, so a transient failure never clobbers it.
//
// opts injects a stub feed in tests: { cmd, args, timeoutMs }.
export async function agendaSync(reason = "scheduled", opts = {}) {
  const date = todayDate();
  const tz = HUD_TZ;
  const cmd = opts.cmd || AGENDA_PYTHON;
  const args = opts.args || [AGENDA_FEED];
  const timeoutMs = opts.timeoutMs || AGENDA_SYNC_TIMEOUT_MS;

  const code = await new Promise((resolve) => {
    let settled = false;
    const finish = (c) => {
      if (!settled) {
        settled = true;
        resolve(c);
      }
    };
    let proc;
    try {
      proc = spawn(cmd, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        cwd: VAULT_ROOT,
        detached: !IS_WINDOWS,
        env: { ...process.env, VAULT_ROOT, HUD_TZ },
      });
    } catch (e) {
      log(`agenda-sync spawn failed: ${e.message}`);
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      killTree(proc, "SIGTERM");
      setTimeout(() => killTree(proc, "SIGKILL"), 5_000).unref?.();
      finish(-2);
    }, timeoutMs);
    let err = "";
    proc.stderr.on("data", (c) => {
      err += c.toString();
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      log(`agenda-sync error: ${e.message}`);
      finish(-1);
    });
    proc.on("close", (c) => {
      clearTimeout(timer);
      if (err.trim()) log(`agenda-sync feed: ${err.trim().slice(0, 200)}`);
      finish(c ?? 0);
    });
  });

  // A well-formed file (ok true OR false) is the source of truth.
  try {
    const cache = readJson(AGENDA_STATE_FILE);
    if (cache && typeof cache.ok === "boolean" && Array.isArray(cache.events)) {
      log(
        `agenda-sync (${reason}): ok=${cache.ok} events=${cache.events.length} date=${cache.date}` +
          (cache.ok ? "" : ` reason=${cache.reason || "?"}`)
      );
      return cache;
    }
  } catch {
    /* no parseable cache — fall through */
  }

  const fallback = {
    ok: false,
    reason:
      code === -2
        ? "timeout: agenda feed exceeded its window"
        : "feed-missing: agenda feed produced no valid cache",
    last_sync_ts: new Date().toISOString(),
    date,
    tz,
    events: [],
  };
  try {
    writeJson(AGENDA_STATE_FILE, fallback);
  } catch {
    /* ignore */
  }
  log(`agenda-sync (${reason}): no valid cache (code ${code}) — wrote ok:false (${fallback.reason})`);
  return fallback;
}

// Native skills execute in Node (direct Notion REST) instead of `claude -p`.
async function processNative(intent, runId, queuePath) {
  const tsStarted = new Date().toISOString();
  const runJsonPath = join(RUNS_DIR, `${runId}.json`);
  const runMdPath = join(RUNS_DIR, `${runId}.md`);
  const status = {
    id: runId,
    skill: intent.skill,
    args: intent.args || {},
    ts_queued: intent.ts || tsStarted,
    ts_started: tsStarted,
    ts_completed: null,
    status: "running",
    exit_code: null,
    summary: "",
    md_path: `system/runs/${runId}.md`,
    log_path: `system/runs/${runId}.md`,
    deliverable_path: "Atlas/Projects/Morphy/_board-snapshot.md",
  };
  writeJson(runJsonPath, status);

  let ok = true;
  let summary = "";
  try {
    if (intent.skill === "morphy-task-add") {
      const a = intent.args || {};
      const title = String(a.title || "").trim();
      if (!title) throw new Error("no task title in intent args");
      if (!NOTION_TOKEN) throw new Error("Notion not connected (no NOTION_TOKEN)");
      await createTask(NOTION_TOKEN, MORPHY_DB_ID, {
        title,
        status: a.status || "Todo",
        assignee: a.assignee || "Unassigned",
        addedBy: a.addedBy || "Daniel",
        priority: a.priority || "Med",
        notes: a.notes,
      });
      // createTask succeeded → the task EXISTS on the board. A flaky after-add
      // cache refresh must not report failure (it invites a duplicate retry on
      // the shared board); the 30-min scheduled sync catches the cache up.
      const st = await morphySync("after-add");
      const who = a.assignee && a.assignee !== "Unassigned" ? ` (${a.assignee})` : "";
      summary = `Added Morphy task: ${title}${who}.${st.ok === false ? " Board cache refresh pending." : ""}`;
    } else {
      // morphy-sync
      const st = await morphySync("on-demand");
      if (st.ok === false) {
        ok = false;
        summary = `Morphy not connected: ${st.reason}`;
      } else {
        summary = `Morphy synced — ${st.open_total} open, ${st.ideas_awaiting} ideas.`;
      }
    }
  } catch (e) {
    ok = false;
    summary = `${intent.skill} failed: ${e.message}`.slice(0, 200);
    log(`${runId}: ${summary}`);
  }

  status.status = ok ? "ok" : "error";
  status.exit_code = ok ? 0 : -1;
  status.ts_completed = new Date().toISOString();
  status.summary = summary.slice(0, 200);
  writeJson(runJsonPath, status);
  try {
    writeFileSync(
      runMdPath,
      `---\nrun_id: ${runId}\nskill: ${intent.skill}\nstatus: ${status.status}\nts_started: ${tsStarted}\nts_completed: ${status.ts_completed}\n---\n\n# ${intent.skill}\n\n${summary}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(queuePath);
  } catch {
    /* ignore */
  }
  log(`${runId}: native ${intent.skill} ${status.status} — ${summary}`);
}

async function loop() {
  while (true) {
    // One transient FS error must cost one tick, not the scheduler — an
    // uncaught throw here rejects loop()'s promise and kills intent
    // processing forever while the heartbeat keeps reporting healthy.
    try {
      enqueueNew();
      // Greedy fill — grab runnable intents until the concurrency cap.
      let progress = true;
      while (progress && active < MAX_CONCURRENT && pending.length > 0) {
        const idx = pickNext();
        if (idx < 0) {
          progress = false;
          break;
        }
        const next = pending.splice(idx, 1)[0];
        const skill = peekSkill(next);
        active++;
        if (skill) inFlight.add(skill);
        processing.add(next);
        processOne(next)
          .catch((e) => {
            log(`processOne crashed: ${e.message}`);
            // the claim would otherwise sit until the next boot sweep
            retireClaim(next, `processOne crashed: ${e.message}`);
          })
          .finally(() => {
            active--;
            if (skill) inFlight.delete(skill);
            processing.delete(next);
          });
      }
    } catch (e) {
      log(`loop tick failed: ${e.message} — retrying next tick`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function watchLoop() {
  try {
    const watcher = watch(QUEUE_DIR, { persistent: true });
    for await (const ev of watcher) {
      if (ev.filename && isIntentFile(ev.filename)) {
        enqueueNew();
      }
    }
  } catch (e) {
    log(`watcher error: ${e.message} — falling back to polling`);
  }
}

process.on("uncaughtException", (err) => {
  log(`uncaught: ${err.stack || err.message}`);
});

// --- Singleton lock — refuse to boot if another runner is alive.
const PIDFILE = join(RUNNER_DIR, "runner.pid");

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 = liveness check, throws if dead
    return true;
  } catch {
    return false;
  }
}

// A recycled pid (stale pidfile surviving power loss + reboot) can pass the
// bare liveness probe while belonging to some unrelated login process — which
// would make every launchd respawn defer and exit, forever. Only defer to a
// process that actually looks like a runner.
export function pidLooksLikeRunner(pid) {
  try {
    const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    return cmd.includes("runner.js");
  } catch {
    return false; // ps failed or no such process — treat the pidfile as stale
  }
}

// Boot the daemon. Pulled into a function and gated behind the entrypoint check
// below so the module can be IMPORTED (by the skill-contract test) without
// acquiring the lock, writing the heartbeat, or starting any loops/spawns.
function main() {
  if (existsSync(PIDFILE)) {
    try {
      const otherPid = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
      if (
        Number.isInteger(otherPid) &&
        otherPid !== process.pid &&
        pidAlive(otherPid) &&
        pidLooksLikeRunner(otherPid)
      ) {
        log(`another runner alive at pid ${otherPid} — exiting this one (pid ${process.pid})`);
        process.exit(0);
      }
    } catch {
      /* stale pidfile — overwrite */
    }
  }
  writeFileSync(PIDFILE, String(process.pid), "utf8");
  process.on("exit", () => {
    try {
      const cur = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
      if (cur === process.pid) unlinkSync(PIDFILE);
    } catch {
      /* ignore */
    }
  });
  // SIGTERM/SIGINT don't run 'exit' handlers by default — exit explicitly so
  // the pidfile cleanup above fires on launchd stop / Ctrl-C too.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => process.exit(0));
  }

  ensureDirs();
  sweepOrphanedClaims();
  pruneRuns();
  setInterval(pruneRuns, 24 * 3600 * 1000).unref?.();
  log(
    `runner booted (pid ${process.pid}) vault=${VAULT_ROOT} model=${CLAUDE_MODEL} ` +
      `notify=${NOTIFY_CONFIG.enabled ? [...NOTIFY_CONFIG.types].join("+") || "none" : "off"}`
  );
  writeHeartbeat();
  setInterval(writeHeartbeat, 15_000);
  // Morphy board: sync once on boot, then every 30 min while the runner is alive.
  morphySync("startup").catch((e) => log(`morphy startup sync: ${e.message}`));
  setInterval(
    () => morphySync("scheduled").catch((e) => log(`morphy sync: ${e.message}`)),
    MORPHY_SYNC_INTERVAL_MS
  );
  // Calendar agenda: same cache-on-a-cadence shape, refreshed by the deterministic feed.
  agendaSync("startup").catch((e) => log(`agenda startup sync: ${e.message}`));
  setInterval(
    () => agendaSync("scheduled").catch((e) => log(`agenda sync: ${e.message}`)),
    AGENDA_SYNC_INTERVAL_MS
  );
  // Fleet watchdog (issue #58): freshness math over every scheduled producer,
  // one kick per staleness episode, health file for the HUD dot. The watchdog
  // must never take down the runner it watches — every pass is caught.
  const runFleetCheck = () =>
    fleetCheck({
      vaultRoot: VAULT_ROOT,
      tz: HUD_TZ,
      agendaIntervalMin: AGENDA_SYNC_INTERVAL_MS / 60_000,
      agendaSync,
      morphySync,
      kickstart: (label) =>
        execFileSync("launchctl", ["kickstart", `gui/${process.getuid()}/${label}`]),
      notify: (event) => notify(event, NOTIFY_CONFIG, log),
      log,
    }).catch((e) => log(`fleet check: ${e.message}`));
  setTimeout(runFleetCheck, 60_000).unref?.(); // first pass after boot settles
  setInterval(runFleetCheck, FLEET_CHECK_INTERVAL_MS);
  watchLoop();
  // The tick body is try/caught, so this catch is the last-resort backstop:
  // if the scheduler still dies, exit non-zero and let launchd (KeepAlive)
  // relaunch a working runner instead of leaving a heartbeat-only zombie.
  loop().catch((e) => {
    log(`scheduler loop crashed: ${e.stack || e.message} — exiting for launchd restart`);
    process.exit(1);
  });
}

// Only boot when run directly (`node runner/runner.js`), never when imported.
function runningAsEntrypoint() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
}

if (runningAsEntrypoint()) main();
