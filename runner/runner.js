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

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs/promises";
import { queryTasks, createTask, MORPHY_DB_ID_DEFAULT } from "./notion.js";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));

// --- Config — env vars first (shell or ~/.claude/.env). VAULT_ROOT is
// required and has no default; the runner exits if it's unset (see below).
function loadEnvFile() {
  const envPath = join(homedir(), ".claude", ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  try {
    for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const idx = line.indexOf("=");
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

const _env = loadEnvFile();
const env = (k) => process.env[k] || _env[k];

const VAULT_ROOT = env("VAULT_ROOT") || env("AGENTIC_OS_VAULT");
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
const HUD_TZ = env("HUD_TZ") || "America/Chicago";
const QUEUE_DIR = join(VAULT_ROOT, "system", "queue");
const RUNS_DIR = join(VAULT_ROOT, "system", "runs");
const STATUS_FILE = join(VAULT_ROOT, "system", "runner-status.json");
const RUNNER_LOG = join(RUNNER_DIR, "runner.log");

// --- Morphy ↔ Notion ------------------------------------------------------
// The runner owns ALL Notion I/O. NOTION_TOKEN is secret (~/.claude/.env); the
// board IDs are not (default in notion.js, env-overridable). morphySync() pulls
// the board → a JSON cache the HUD reads + a human snapshot in the vault.
const NOTION_TOKEN = env("NOTION_TOKEN") || null;
const MORPHY_DB_ID = env("MORPHY_DB_ID") || MORPHY_DB_ID_DEFAULT;
const MORPHY_DIR = join(VAULT_ROOT, "Atlas", "Projects", "Morphy");
const MORPHY_STATE_FILE = join(VAULT_ROOT, "system", "morphy-state.json");
// Native skills run in Node here (Notion REST), NOT via headless `claude -p`.
const NATIVE_SKILLS = new Set(["morphy-sync", "morphy-task-add"]);
const MORPHY_SYNC_INTERVAL_MS = 30 * 60_000;

// Calendar agenda cache. The runner has no Google OAuth, so a headless agent
// reaches Calendar via MCP and writes system/agenda.json (the HUD reads this and
// never calls Calendar — same local-only firewall as the Morphy board). Each
// refresh spawns `claude -p`, so the cadence is gentle and env-overridable.
const AGENDA_STATE_FILE = join(VAULT_ROOT, "system", "agenda.json");
const AGENDA_SYNC_INTERVAL_MS = (Number(env("AGENDA_SYNC_MIN")) || 30) * 60_000;
const AGENDA_SYNC_TIMEOUT_MS = 3 * 60_000;

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

function writeHeartbeat() {
  try {
    writeFileSync(
      STATUS_FILE,
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          pid: process.pid,
          version: "1.0.1",
          busy: active > 0,
          active,
          max_concurrent: MAX_CONCURRENT,
          pending: pending.length,
          in_flight: [...inFlight],
        },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* ignore */
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function slugify(s, max = 48) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, max) || "untitled";
}

function todayDate() {
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
function deliverablePathFor(intent) {
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
function buildPrompt(intent, deliverable) {
  const skill = intent.skill;
  const args = intent.args || {};

  switch (skill) {
    case "plan-today":
      return `${AUTONOMOUS_PREFIX}\n\nTask: plan today's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read the last 3 daily notes under daily-notes/ for incomplete Top 3 priorities and reflections (carryover candidates).\n2. If a Google Calendar MCP connector is available, pull today's events (timeZone=${HUD_TZ}, sorted by start time). If not, skip the schedule.\n3. Scan projects/*.md (if the folder exists) for active or due items.\n4. Pick the 3 highest-leverage priorities: carryover from yesterday beats new, due-today beats someday.\n5. Write the daily note following the schema at system/schemas/daily-note.md — exact section order. If the note already exists, MERGE: fill only empty Top 3 slots and replace ## Schedule; never overwrite user-set text.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "plan-tomorrow":
      return `${AUTONOMOUS_PREFIX}\n\nTask: draft tomorrow's daily note at exactly ${deliverable}.\n\nSteps:\n1. Read today's daily note for unfinished Top 3 priorities (carryover).\n2. If a Google Calendar MCP connector is available, pull tomorrow's events (timeZone=${HUD_TZ}).\n3. Suggest 3 priorities for tomorrow.\n4. Write the note following the schema at system/schemas/daily-note.md.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "morning-report":
      return `${AUTONOMOUS_PREFIX}\n\nTask: produce Daniel's personalized morning briefing and save it at exactly ${deliverable}.\n\nResearch the last ~24 hours via web search across Daniel's beat: (1) AI tooling and agent/dev-tool launches plus notable AI startup news and funding; (2) the job market for AI and software-engineering roles — hiring trends, notable openings, layoffs; (3) DMV-area (DC / Maryland / Virginia) tech and local news, falling back to major US/world headlines if the DMV is quiet; (4) chess news — major tournaments, results, notable games; (5) antenna / RF / wireless-industry news relevant to Morphy Consulting. Structure the note: top-level "# Morning Report" + "**Date:** <today>", then "## Headlines" (3-5 bullets ranked by impact ACROSS all beats; each bullet MUST end with a markdown link to its primary source, e.g. [source](https://...)), then "## AI & Startups", "## Jobs — AI & SWE Market", "## DMV & General News", "## Chess", "## RF & Antennas — Morphy Consulting", "## Morphy Board", "## Sources". For "## Morphy Board": read system/morphy-state.json (the runner's cache of the shared Notion task board) and report the open task count, ideas awaiting review, and any overnight changes from its delta (delta.added / delta.closed, naming a few); if that file is missing or its "ok" field is false, write a single line noting the board isn't syncing. Omit a topical NEWS section if there is genuinely nothing worth reporting, but always include "## Morphy Board" when the cache file exists. YAML frontmatter: \`date\`, \`skill: morning-report\`, \`tags: [morning, briefing]\`.\n\nThe HUD's AI Wire panel and the spoken daily brief both read the ## Headlines section — keep those bullets tight.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "inbox-brief":
      return `${AUTONOMOUS_PREFIX}\n\nTask: triage the Gmail inbox and save the brief at exactly ${deliverable}.\n\nSteps:\n1. Pull the last 24h via the Anthropic Gmail MCP connector — mcp__claude_ai_Gmail__search_threads with query "in:inbox newer_than:1d", pageSize 50. If the connector is unavailable, write a short note saying so and stop.\n2. Classify each thread: urgent (deadlines, money, blocked people) / warm (real humans worth replying to) / opportunities (sponsorships, partnerships) / meetings / noise.\n3. Save the triage at ${deliverable}. YAML frontmatter \`date\`, \`skill: inbox-brief\`, \`tags: [inbox, triage]\`. Body groups messages by category, most urgent first.\n4. Do NOT send anything — drafting and sending stay manual.\n\nEnd your reply with: SAVED ${deliverable}`;
    case "vault-cleanup":
      return `${AUTONOMOUS_PREFIX}\n\nTask: tidy the vault and report at exactly ${deliverable}.\n\nScan the vault for stale files (untouched > 7 days, outside system/ and archive/). Move them into archive/ subfolders mirroring their source folder. Write a one-page report at ${deliverable} — YAML frontmatter \`date\`, \`skill: vault-cleanup\`, \`tags: [cleanup, ops]\`; body lists what moved and what was skipped.\n\nEnd your reply with: SAVED ${deliverable}`;
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
const DEDUPE_SKILLS = new Set(["morning-report", "inbox-brief"]);
// Long-haul skills get a 20-min hard timeout instead of 10 — web-research
// runs routinely take longer than you'd guess.
const LONG_SKILLS = new Set(["morning-report"]);

let active = 0;
const inFlight = new Set(); // intent.skill values currently running
const pending = []; // queue filenames awaiting a slot
const processing = new Set(); // queue filenames currently being processed

function enqueueNew() {
  if (!existsSync(QUEUE_DIR)) return;
  const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith(".json"));
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

function pickNext() {
  const serialBusy = [...inFlight].some((s) => SERIAL_SKILLS.has(s));
  for (let i = 0; i < pending.length; i++) {
    const skill = peekSkill(pending[i]);
    if (!skill) continue; // unreadable yet (write race) — try later
    if (DEDUPE_SKILLS.has(skill) && inFlight.has(skill)) continue;
    if (SERIAL_SKILLS.has(skill) && serialBusy) continue;
    return i;
  }
  return -1;
}

async function processOne(fileName) {
  const queuePath = join(QUEUE_DIR, fileName);
  if (!existsSync(queuePath)) return;

  let intent;
  let lastErr = null;
  // Retry with backoff — covers the race where the intent file exists but
  // hasn't flushed content yet.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      intent = readJson(queuePath);
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
      unlinkSync(queuePath);
    } catch {
      /* ignore */
    }
    return;
  }

  const runId = intent.id || basename(fileName, ".json");

  // Native skills (Morphy ↔ Notion) run in-process via REST — no `claude -p`.
  if (NATIVE_SKILLS.has(intent.skill)) {
    await processNative({ ...intent, id: runId }, runId, queuePath);
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
      unlinkSync(queuePath);
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

  const out = [];
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
      }
    );

    proc.stdout.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });
    proc.stderr.on("data", (chunk) => {
      out.push(chunk.toString());
      try {
        appendFileSync(runMdPath, chunk);
      } catch {
        /* ignore */
      }
    });

    const HARD_TIMEOUT_MIN = LONG_SKILLS.has(intent.skill) ? 20 : 10;
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      out.push(`\n[runner: hard timeout ${HARD_TIMEOUT_MIN}m — killed]\n`);
    }, 1000 * 60 * HARD_TIMEOUT_MIN);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const tsCompleted = new Date().toISOString();
      const joined = out.join("").trim();
      const lines = joined.split(/\r?\n/);
      const firstLine =
        lines.find(
          (l) =>
            l.trim().length > 0 &&
            !l.startsWith("Warning:") &&
            !l.startsWith("warning:")
        ) ||
        lines.find((l) => l.trim().length > 0) ||
        "(no output)";
      status.status = code === 0 ? "ok" : "error";
      status.exit_code = code ?? -1;
      status.ts_completed = tsCompleted;
      status.summary = firstLine.slice(0, 200);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(
          runMdPath,
          `\n\`\`\`\n\n---\n*exit code=${code} · status=${status.status} · completed ${tsCompleted}*\n`
        );
      } catch {
        /* ignore */
      }
      log(`${runId}: completed exit=${code} status=${status.status}`);
      resolve();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      status.status = "error";
      status.exit_code = -2;
      status.ts_completed = new Date().toISOString();
      status.summary = `spawn error: ${err.message}`.slice(0, 200);
      writeJson(runJsonPath, status);
      try {
        appendFileSync(runMdPath, `\n\`\`\`\n\n[runner spawn error] ${err.message}\n`);
      } catch {
        /* ignore */
      }
      log(`${runId}: spawn error ${err.message}`);
      resolve();
    });
  });

  try {
    unlinkSync(queuePath);
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

function morphyCounts(tasks) {
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

function morphySnapshotMd(tasks, ts) {
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
  return state;
}

// --- Calendar agenda cache --------------------------------------------------
// A headless `claude -p` reaches Calendar via MCP and writes system/agenda.json.
// If Calendar isn't reachable in headless mode the agent writes ok:false, and
// the HUD falls back to the daily-note ## Schedule. Mirrors morphySync's
// cache-on-a-cadence shape; the runner validates the agent's write so the HUD
// always reads a well-formed file.
function agendaSyncPrompt(date, tz) {
  return (
    "Execute autonomously in headless mode. Do not ask for confirmation, do not " +
    "call AskUserQuestion, produce no spoken summary. Your only job is to write " +
    "one JSON file.\n\n" +
    "Task: write today's calendar agenda to exactly system/agenda.json (relative " +
    "to the current directory).\n\n" +
    `1. If a Google Calendar MCP connector is available, list today's events for ${date} ` +
    `in timezone ${tz}, sorted by start time, from the user's primary calendar.\n` +
    "2. Write system/agenda.json with EXACTLY this shape and nothing else:\n" +
    `{"ok": true, "last_sync_ts": "<current UTC time as ISO-8601, e.g. 2026-06-19T16:30:00Z>", ` +
    `"date": "${date}", "tz": "${tz}", "events": [{"time": "09:00", "end": "09:30", ` +
    `"item": "Event title", "allDay": false, "location": ""}]}\n` +
    `   - time and end are 24-hour HH:MM in ${tz}. For an all-day event set ` +
    `"time":"all-day", "end":"", "allDay":true, and list it first.\n` +
    "   - item is the event title; location may be \"\". Keep events sorted by start.\n" +
    "   - An empty day is valid: write \"events\": [].\n" +
    "3. If NO Google Calendar connector is available, or the lookup fails, instead " +
    `write: {"ok": false, "reason": "<short reason>", "last_sync_ts": "<UTC ISO>", ` +
    `"date": "${date}", "tz": "${tz}", "events": []}\n\n` +
    "Write ONLY that one file — no other files, no markdown. Your final reply must be the single word DONE."
  );
}

async function agendaSync(reason = "scheduled") {
  const date = todayDate();
  const tz = HUD_TZ;
  const prompt = agendaSyncPrompt(date, tz);

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
      proc = spawn(
        CLAUDE_BIN,
        ["-p", prompt, "--model", CLAUDE_MODEL, "--dangerously-skip-permissions"],
        { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: VAULT_ROOT }
      );
    } catch (e) {
      log(`agenda-sync spawn failed: ${e.message}`);
      finish(-1);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      finish(-2);
    }, AGENDA_SYNC_TIMEOUT_MS);
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
      if (err.trim()) log(`agenda-sync stderr: ${err.trim().slice(0, 160)}`);
      finish(c ?? 0);
    });
  });

  // Validate the agent's write. A well-formed file (ok true OR false) is the
  // source of truth — return it untouched. Only when the agent produced nothing
  // usable do we write a clean ok:false so the HUD falls back instead of choking.
  // A prior good cache for a different day is left alone: the HUD's date check
  // guards staleness, so we never clobber yesterday on a transient failure.
  try {
    const cache = readJson(AGENDA_STATE_FILE);
    if (cache && typeof cache.ok === "boolean" && Array.isArray(cache.events)) {
      log(`agenda-sync (${reason}): ok=${cache.ok} events=${cache.events.length} date=${cache.date}`);
      return cache;
    }
  } catch {
    /* no parseable cache — fall through */
  }

  const fallback = {
    ok: false,
    reason: code === -2 ? "agenda agent timed out" : "agenda agent produced no valid cache",
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
  log(`agenda-sync (${reason}): no valid cache (code ${code}) — wrote ok:false`);
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
      const st = await morphySync("after-add");
      ok = st.ok !== false;
      const who = a.assignee && a.assignee !== "Unassigned" ? ` (${a.assignee})` : "";
      summary = `Added Morphy task: ${title}${who}.`;
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
        .catch((e) => log(`processOne crashed: ${e.message}`))
        .finally(() => {
          active--;
          if (skill) inFlight.delete(skill);
          processing.delete(next);
        });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function watchLoop() {
  try {
    const watcher = watch(QUEUE_DIR, { persistent: true });
    for await (const ev of watcher) {
      if (ev.filename && ev.filename.endsWith(".json")) {
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

if (existsSync(PIDFILE)) {
  try {
    const otherPid = parseInt(readFileSync(PIDFILE, "utf8").trim(), 10);
    if (Number.isInteger(otherPid) && otherPid !== process.pid && pidAlive(otherPid)) {
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

ensureDirs();
log(`runner booted (pid ${process.pid}) vault=${VAULT_ROOT} model=${CLAUDE_MODEL}`);
writeHeartbeat();
setInterval(writeHeartbeat, 15_000);
// Morphy board: sync once on boot, then every 30 min while the runner is alive.
morphySync("startup").catch((e) => log(`morphy startup sync: ${e.message}`));
setInterval(
  () => morphySync("scheduled").catch((e) => log(`morphy sync: ${e.message}`)),
  MORPHY_SYNC_INTERVAL_MS
);
// Calendar agenda: same cache-on-a-cadence shape, refreshed by a headless agent.
agendaSync("startup").catch((e) => log(`agenda startup sync: ${e.message}`));
setInterval(
  () => agendaSync("scheduled").catch((e) => log(`agenda sync: ${e.message}`)),
  AGENDA_SYNC_INTERVAL_MS
);
watchLoop();
loop();
