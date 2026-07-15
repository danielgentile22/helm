// Rules-engine sweep — dispatch-vs-reference, question hijack, in-flight
// guard, rundown anchoring, offer round-trip. Pure rulesRoute/inFlightGuard
// against synthetic state: no network, no Haiku spend, nothing written to the
// real queue. Hermetic: VAULT_ROOT points at an empty tempdir (fresh clones
// pass, briefing cases can't read the live vault) and HELM_TEST_TIME pins the
// HUD_TZ clock so time-dependent lanes assert exact output.
// Run: npx -y tsx scripts/test-router.ts
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteResult } from "../lib/router";
import type { Metric, VaultState } from "../lib/vault";
import type { Exchange } from "../lib/voiceMemory";

process.env.VOICE_NO_WARMUP = "1"; // must be set BEFORE the module loads
// hermetic vault — set unconditionally so ~/.claude/.env can't leak the real
// one in (lib/config prefers process.env); the sweep never touches disk state
process.env.VAULT_ROOT = join(tmpdir(), "helm-router-sweep");
// deterministic HUD_TZ wall clock — 03:07 so a regression back to the host
// clock fails the sweep at any civilised hour
process.env.HELM_TEST_TIME = "03:07";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rulesRoute, inFlightGuard, briefingOffer, SKILL_ALIASES, validateRouted } =
  require("../lib/router") as typeof import("../lib/router");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ALLOWED_SKILLS } = require("../lib/skills") as typeof import("../lib/skills");

function state(over: Partial<VaultState> = {}): VaultState {
  return {
    generated_at: new Date().toISOString(),
    vault_root: "",
    tz: "America/New_York",
    metrics: [],
    runner: {
      ts: "",
      pid: 0,
      version: "",
      busy: false,
      active: 0,
      max_concurrent: 3,
      pending: 0,
      heartbeat_age_s: 1,
      alive: true,
    },
    daily: null,
    runs: [],
    queue: [],
    morning: null,
    morphy: null,
    agenda: null,
    fleet: null,
    etas: {},
    ...over,
  };
}

const briefRunning = state({
  runs: [
    {
      id: "r1",
      skill: "inbox-brief",
      label: null,
      link: null,
      status: "running",
      summary: "",
      ts_completed: null,
      ts_started: new Date().toISOString(),
      duration_s: null,
      deliverable_path: null,
    },
  ],
});

const morphyBoard = state({
  morphy: {
    ok: true,
    last_sync_ts: new Date().toISOString(),
    total: 4,
    counts: { idea: 1, todo: 2, in_progress: 1, blocked: 0, done: 0 },
    open_total: 3,
    open_by_assignee: { Daniel: 2, Michael: 1, Both: 0, Unassigned: 0 },
    ideas_awaiting: 1,
    delta: { since: null, added: [{ name: "Email the AR rep", addedBy: "Michael" }], closed: [] },
    tasks: [
      { id: "1", name: "Slice B", status: "Todo", assignee: "Daniel", addedBy: "Daniel", priority: "High", due: null },
      { id: "2", name: "Call the landowner", status: "In progress", assignee: "Michael", addedBy: "Michael", priority: "Med", due: null },
      { id: "3", name: "Auto-emailing", status: "Idea", assignee: "Unassigned", addedBy: "Daniel", priority: "Low", due: null },
    ],
  },
});

// the four metric families the feeds actually write
const mkMetric = (source: string, name: string, value: number): Metric => ({
  source,
  metric: name,
  value,
  status: "ok",
  timestamp: new Date().toISOString(),
  history: [],
  delta: null,
  deltaWeek: null,
});
const vitals = state({
  metrics: [
    mkMetric("uscf", "rating", 1545),
    mkMetric("jobs", "applications", 42),
    mkMetric("jobs", "applied_7d", 3),
    mkMetric("github", "commits_7d", 12),
    mkMetric("github", "open_prs", 2),
    mkMetric("github", "open_issues", 5),
  ],
});

// sweep clock is 03:07 — 03:05 is past, 03:30 is the next item
const scheduled = state({
  daily: {
    date: "2026-01-01",
    isToday: true,
    top3: [],
    schedule: [
      { time: "03:05", item: "early sync" },
      { time: "03:30", item: "deep work" },
    ],
    focus: "ship the router fixes",
  },
});

interface Case {
  name: string;
  transcript: string;
  state?: VaultState;
  expect: (r: RouteResult) => boolean;
  want: string;
}

const dispatched = (skill: string) => (r: RouteResult) => r.tier === 1 && r.skill === skill;
const fallsThrough = (r: RouteResult) => r.fallthrough === true;

const CASES: Case[] = [
  // --- clear-cut dispatch still instant (bare alias, ≤5 words, not a question)
  { name: "bare alias", transcript: "morning report", expect: dispatched("morning-report"), want: "tier 1 morning-report" },
  { name: "short command", transcript: "run the morning report", expect: dispatched("morning-report"), want: "tier 1 morning-report" },
  { name: "short audit", transcript: "run the inbox audit", expect: dispatched("inbox-brief"), want: "tier 1 inbox-brief" },
  { name: "polite alias", transcript: "the inbox brief please", expect: dispatched("inbox-brief"), want: "tier 1 inbox-brief" },
  { name: "cleanup dispatch", transcript: "clean up the vault", expect: dispatched("vault-cleanup"), want: "tier 1 vault-cleanup" },
  { name: "plan today dispatch", transcript: "plan today", expect: dispatched("plan-today"), want: "tier 1 plan-today" },
  { name: "plan tomorrow dispatch", transcript: "plan tomorrow", expect: dispatched("plan-tomorrow"), want: "tier 1 plan-tomorrow" },
  // whisper adds terminal punctuation — a trailing period must not block dispatch
  { name: "punctuated command", transcript: "Run the morning report.", expect: dispatched("morning-report"), want: "tier 1 morning-report" },
  // pinned: a trailing "?" reads as a question — rules defer to the model
  // engines rather than guess dispatch intent
  { name: "question-mark alias defers", transcript: "Morning report?", expect: fallsThrough, want: "fallthrough" },

  // --- "queue" as a dispatch verb must reach matchSkill, not the queue lane
  { name: "queue-verb dispatch", transcript: "queue the inbox brief", expect: dispatched("inbox-brief"), want: "tier 1 inbox-brief" },
  { name: "queue-verb dispatch 2", transcript: "queue up the morning report", expect: dispatched("morning-report"), want: "tier 1 morning-report" },

  // --- analytical question naming a skill must not re-run it
  {
    name: "question naming skill must NOT dispatch",
    transcript:
      "Based on this morning report, do you have any stories you think we should dig into? Maybe like three of them?",
    expect: fallsThrough,
    want: "fallthrough to model engines",
  },
  // interrogative "do" used to count as a command verb — keep it dead
  {
    name: "interrogative do + alias",
    transcript: "do you think the morning report stuff matters this week?",
    expect: fallsThrough,
    want: "fallthrough",
  },
  // long command phrasing now defers to the model engines (1-2s, still dispatches)
  {
    name: "long command sentence defers",
    transcript: "can you run the inbox audit for me when you get a chance",
    expect: fallsThrough,
    want: "fallthrough",
  },
  // skill reference inside a bigger ask — never a re-dispatch
  {
    name: "reference not order",
    transcript: "once you're done with that inbox brief tell me about fable 5",
    expect: fallsThrough,
    want: "fallthrough",
  },
  {
    name: "question about report content",
    transcript: "what's going on with the morning report today",
    expect: fallsThrough,
    want: "fallthrough",
  },

  // --- alias-as-substring must NOT dispatch (word-boundary guard, issue #22)
  { name: "team report != am report", transcript: "team report", expect: fallsThrough, want: "fallthrough" },
  { name: "inboxes != inbox", transcript: "inboxes", expect: fallsThrough, want: "fallthrough" },

  // --- rundown stays anchored (deterministic: empty vault, 03:07 clock)
  {
    name: "rundown trigger",
    transcript: "give me the rundown",
    expect: (r) => r.tier === 2 && /midnight oil/i.test(r.reply) && /want me to run the morning report/i.test(r.reply),
    want: "tier 2 briefing with the morning-report offer",
  },
  { name: "brief me", transcript: "hey helm brief me", expect: (r) => r.tier === 2, want: "tier 2 briefing" },

  // --- instant tier-2 lanes: the metrics the feeds ACTUALLY write
  { name: "mic check", transcript: "can you hear me", expect: (r) => r.tier === 2 && r.reply === "Loud and clear.", want: "Loud and clear." },
  {
    name: "chess rating",
    transcript: "what's my chess rating",
    state: vitals,
    expect: (r) => r.tier === 2 && /1545/.test(r.reply) && r.panels?.includes("vitals") === true,
    want: "tier 2 rating answer",
  },
  {
    name: "job applications",
    transcript: "how many applications this week",
    state: vitals,
    expect: (r) => r.tier === 2 && /42 applications total/.test(r.reply) && /3 in the last week/.test(r.reply),
    want: "tier 2 applications answer",
  },
  {
    name: "morphy repo = github, not the board",
    transcript: "how's the morphy repo",
    state: vitals,
    expect: (r) => r.tier === 2 && /12 commits/.test(r.reply) && r.panels?.includes("vitals") === true,
    want: "tier 2 github answer",
  },
  // the creator-template branches are gone — dead metrics defer to the models
  {
    name: "dead template metric falls through",
    transcript: "how many subscribers do I have",
    expect: fallsThrough,
    want: "fallthrough (no youtube feed exists)",
  },
  { name: "queue", transcript: "what's in the queue", expect: (r) => r.tier === 2, want: "tier 2 queue answer" },

  // --- schedule lane: apostrophes survive the normalizer
  {
    name: "what's next (apostrophe)",
    transcript: "what's next",
    state: scheduled,
    expect: (r) => r.tier === 2 && /3:30 AM/.test(r.reply) && /deep work/.test(r.reply),
    want: "tier 2 'Coming up at 3:30 AM — deep work.'",
  },
  {
    name: "next item in HUD_TZ",
    transcript: "what's on the schedule",
    state: scheduled,
    expect: (r) => r.tier === 2 && /3:30 AM/.test(r.reply),
    want: "tier 2 next-item from the pinned HUD_TZ clock",
  },

  // --- focus lane answers asks ABOUT the focus, not any sentence using the verb
  {
    name: "focus question",
    transcript: "what's today's focus",
    state: scheduled,
    expect: (r) => r.tier === 2 && /focus is ship the router fixes/i.test(r.reply),
    want: "tier 2 focus answer",
  },
  {
    name: "focus as a verb must NOT hijack",
    transcript: "let's focus on the morphy stuff today",
    expect: (r) => !/focus is/i.test(r.reply) && r.panels?.includes("morphy") === true,
    want: "morphy lane, not the focus answer",
  },

  // --- in-flight guard on the surviving dispatch path
  {
    name: "in-flight bare re-ask",
    transcript: "run the inbox brief",
    state: briefRunning,
    expect: (r) => r.tier === 2 && /already running/.test(r.reply),
    want: "tier 2 already-running",
  },
  {
    name: "explicit re-run passes",
    transcript: "run inbox brief again",
    state: briefRunning,
    expect: dispatched("inbox-brief"),
    want: "tier 1 inbox-brief",
  },

  // --- Morphy board: command dispatches, queries answer from the cache
  {
    name: "sync morphy dispatches",
    transcript: "sync morphy",
    expect: dispatched("morphy-sync"),
    want: "tier 1 morphy-sync",
  },
  {
    name: "morphy board query",
    transcript: "what's on the morphy board",
    state: morphyBoard,
    expect: (r) => r.tier === 2 && r.panels?.includes("morphy") === true && /open|idea/i.test(r.reply),
    want: "tier 2 morphy board status",
  },
  {
    name: "michael's plate",
    transcript: "what's on michael's plate",
    state: morphyBoard,
    expect: (r) => r.tier === 2 && /michael/i.test(r.reply) && r.panels?.includes("morphy") === true,
    want: "tier 2 michael's open tasks",
  },
];

let failed = 0;
for (const c of CASES) {
  const s = c.state ?? state();
  const r = inFlightGuard(rulesRoute(c.transcript, s), c.transcript, s);
  const ok = c.expect(r);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.name}\n      got: tier ${r.tier}${r.skill ? ` skill=${r.skill}` : ""}${r.fallthrough ? " (fallthrough)" : ""} — "${r.reply.slice(0, 80)}"${ok ? "" : `\n      want: ${c.want}`}`
  );
}

// --- offer coupling: briefingOffer wording ⟷ pendingOffer regex ⟷ OFFER_SKILLS
// (CLAUDE.md load-bearing coupling #2). Both literal offer strings are fed
// back through the yes/no path with synthetic convo memory — rewording either
// side turns this red instead of silently degrading every "yes".

function check(name: string, ok: boolean, got: string, want: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      got: ${got}${ok ? "" : `\n      want: ${want}`}`);
}

const offerExchange = (helm: string, ageMs = 0): Exchange[] => [
  { ts: new Date(Date.now() - ageMs).toISOString(), you: "brief me", helm, tier: 2 },
];

// every SKILL_ALIASES target must be a skill the runner can actually build —
// the voice path queues tier-1 results without re-validating
for (const [re, skill] of SKILL_ALIASES) {
  check(`alias ${re} → allowed skill`, ALLOWED_SKILLS.has(skill), skill, "member of ALLOWED_SKILLS");
}

process.env.HELM_TEST_TIME = "09:00";
const morningOffer = briefingOffer(state(), false); // morning, no report yet
process.env.HELM_TEST_TIME = "17:00";
const lateOffer = briefingOffer(state(), false); // after 16:00 — inbox audit
const reportOffer = briefingOffer(state(), true); // report exists — inbox audit
process.env.HELM_TEST_TIME = "03:07"; // restore the sweep clock

const yes1 = rulesRoute("yes", state(), offerExchange(morningOffer));
check("yes after morning offer", yes1.tier === 1 && yes1.skill === "morning-report", `tier ${yes1.tier} skill=${yes1.skill}`, "tier 1 morning-report");

const yes2 = rulesRoute("yes please", state(), offerExchange(lateOffer));
check("yes after late-day offer", yes2.tier === 1 && yes2.skill === "inbox-brief", `tier ${yes2.tier} skill=${yes2.skill}`, "tier 1 inbox-brief");

// composed answers — "Yes, do it." / "No, not right now." must not fall through
const yes3 = rulesRoute("yes do it", state(), offerExchange(reportOffer));
check("composed affirm", yes3.tier === 1 && yes3.skill === "inbox-brief", `tier ${yes3.tier} skill=${yes3.skill}`, "tier 1 inbox-brief");

const no1 = rulesRoute("no not right now", state(), offerExchange(morningOffer));
check("composed decline", no1.tier === 2 && no1.reply === "Standing by.", `tier ${no1.tier} "${no1.reply}"`, 'tier 2 "Standing by."');

const no2 = rulesRoute("no thanks", state(), offerExchange(morningOffer));
check("plain decline", no2.tier === 2 && no2.reply === "Standing by.", `tier ${no2.tier} "${no2.reply}"`, 'tier 2 "Standing by."');

// a stale offer (>3 min) must not dispatch on a bare "yes"
const stale = rulesRoute("yes", state(), offerExchange(morningOffer, 4 * 60 * 1000));
check("stale offer ignored", stale.tier !== 1, `tier ${stale.tier}`, "not tier 1");

// --- validateRouted tier coercion (issue #22): only an explicit 1/2/3 may
// pass; anything else returns null so the caller's rulesRoute/next-engine
// fallback takes over instead of a silent tier-3 escalation. Uses Number()
// per spec, so a stringified "3" is still an honest tier-3 intent.
const vr = (parsed: object) => validateRouted(parsed as never, "haiku");
check("tier 3 accepted", vr({ tier: 3, reply: "ok" })?.tier === 3, `${vr({ tier: 3, reply: "ok" })?.tier}`, "tier 3");
check("tier 2 accepted", vr({ tier: 2, reply: "ok" })?.tier === 2, `${vr({ tier: 2, reply: "ok" })?.tier}`, "tier 2");
const vr1 = vr({ tier: 1, skill: "morning-report" });
check("tier 1 + valid skill", vr1?.tier === 1 && vr1.skill === "morning-report", `tier ${vr1?.tier} skill=${vr1?.skill}`, "tier 1 morning-report");
check("tier 1 no skill → null", vr({ tier: 1 }) === null, `${vr({ tier: 1 })}`, "null");
check("tier 0 → null", vr({ tier: 0 }) === null, `${vr({ tier: 0 })}`, "null");
check("tier 4 → null", vr({ tier: 4 }) === null, `${vr({ tier: 4 })}`, "null");
check("tier undefined → null", vr({}) === null, `${vr({})}`, "null");
check("tier garbage string → null", vr({ tier: "nope" }) === null, `${vr({ tier: "nope" })}`, "null");
check('stringified "3" coerces to tier 3', vr({ tier: "3", reply: "ok" })?.tier === 3, `${vr({ tier: "3", reply: "ok" })?.tier}`, "tier 3");

const total = CASES.length + SKILL_ALIASES.length + 6 + 9;
console.log(failed === 0 ? `\nAll ${total} cases pass.` : `\n${failed}/${total} FAILED`);
process.exit(failed ? 1 : 0);
