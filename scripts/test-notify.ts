// Notification-decision sweep — the pure half of runner/notify.js, checked by
// behavior. decideNotification(event, config) and loadNotifyConfig(env) carry
// all the logic (what fires, what stays silent, what the config gates); the
// emitter is a thin osascript shell. This test never posts a real banner: it
// drives the decision + config functions directly and only touches the emitter
// on its guard paths (null / titleless notes), which short-circuit before any
// osascript call on every platform.
// Run: npx -y tsx scripts/test-notify.ts
import {
  decideNotification,
  loadNotifyConfig,
  emitNotification,
  NOTIFY_EVENT_TYPES,
} from "../runner/notify.js";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// An env accessor backed by a plain map — lets us drive loadNotifyConfig with
// no process.env mutation.
const envOf = (map: Record<string, string>) => (k: string) => map[k];

// All three event types on, the default config (nothing in env).
const allOn = loadNotifyConfig(envOf({}));

// --- loadNotifyConfig -------------------------------------------------------
check(allOn.enabled === true, "default config is enabled");
check(
  NOTIFY_EVENT_TYPES.every((t) => allOn.types.has(t)) && allOn.types.size === 3,
  "default config allows all three event types"
);

const off = loadNotifyConfig(envOf({ HELM_NOTIFY: "off" }));
check(off.enabled === false, "HELM_NOTIFY=off disables notifications");

const offCased = loadNotifyConfig(envOf({ HELM_NOTIFY: "OFF" }));
check(offCased.enabled === false, "HELM_NOTIFY is case-insensitive (OFF)");

const onlyFailed = loadNotifyConfig(envOf({ HELM_NOTIFY_EVENTS: "run-failed" }));
check(
  onlyFailed.types.has("run-failed") && onlyFailed.types.size === 1,
  "HELM_NOTIFY_EVENTS=run-failed allows only that type"
);

const twoTypes = loadNotifyConfig(
  envOf({ HELM_NOTIFY_EVENTS: "run-complete, morphy-delta" })
);
check(
  twoTypes.types.has("run-complete") &&
    twoTypes.types.has("morphy-delta") &&
    !twoTypes.types.has("run-failed"),
  "HELM_NOTIFY_EVENTS parses a comma list and trims whitespace"
);

const withGarbage = loadNotifyConfig(
  envOf({ HELM_NOTIFY_EVENTS: "run-failed, made-up-event" })
);
check(
  withGarbage.types.has("run-failed") && withGarbage.types.size === 1,
  "unknown event names are dropped from HELM_NOTIFY_EVENTS"
);

const emptyList = loadNotifyConfig(envOf({ HELM_NOTIFY_EVENTS: "" }));
check(emptyList.enabled === true && emptyList.types.size === 0, "empty HELM_NOTIFY_EVENTS → nothing fires");

// --- decideNotification: run-complete ---------------------------------------
const landed = decideNotification(
  { type: "run-complete", skill: "morning-report", summary: "Your day at a glance", deliverable: "inbox/reports/2026-06-19-report.md" },
  allOn
);
check(
  landed !== null && /morning-report/.test(landed!.title) && landed!.body === "Your day at a glance",
  "run-complete with a deliverable produces a banner (summary as body)"
);

const landedNoSummary = decideNotification(
  { type: "run-complete", skill: "morning-report", deliverable: "inbox/reports/a/b/2026-report.md" },
  allOn
);
check(
  landedNoSummary !== null && landedNoSummary!.body === "2026-report.md",
  "run-complete with no summary falls back to the deliverable filename"
);

const noDeliverable = decideNotification(
  { type: "run-complete", skill: "vault-cleanup", summary: "tidied up" },
  allOn
);
check(noDeliverable === null, "run-complete with no deliverable stays silent");

// --- decideNotification: run-failed -----------------------------------------
const failedRun = decideNotification(
  { type: "run-failed", skill: "weekly-review", summary: "claude exited 1" },
  allOn
);
check(
  failedRun !== null && /weekly-review/.test(failedRun!.title) && failedRun!.body === "claude exited 1",
  "run-failed produces a banner with the skill and summary"
);

const failedNoSummary = decideNotification({ type: "run-failed", skill: "weekly-review" }, allOn);
check(
  failedNoSummary !== null && failedNoSummary!.body.length > 0,
  "run-failed with no summary still has a body"
);

// --- decideNotification: morphy-delta ---------------------------------------
const boardChanged = decideNotification(
  { type: "morphy-delta", added: [{ name: "Site survey" }, { name: "Lease draft" }], closed: [{ name: "Kickoff" }] },
  allOn
);
check(
  boardChanged !== null && /Morphy/.test(boardChanged!.title) && /\+2 added/.test(boardChanged!.body) && /1 closed/.test(boardChanged!.body),
  "morphy-delta summarizes added + closed counts"
);
check(
  boardChanged !== null && /Site survey/.test(boardChanged!.body),
  "morphy-delta names the changed cards"
);

const manyAdded = decideNotification(
  { type: "morphy-delta", added: ["a", "b", "c", "d", "e"], closed: [] },
  allOn
);
check(
  manyAdded !== null && /\+2 more/.test(manyAdded!.body),
  "morphy-delta truncates a long card list with a +N more tail"
);

const noChange = decideNotification({ type: "morphy-delta", added: [], closed: [] }, allOn);
check(noChange === null, "a morphy-delta with no added/closed stays silent");

// --- decideNotification: config gating & bad input --------------------------
check(
  decideNotification({ type: "run-complete", skill: "x", deliverable: "y.md" }, off) === null,
  "a disabled config silences every event"
);
check(
  decideNotification({ type: "run-complete", skill: "x", deliverable: "y.md" }, onlyFailed) === null,
  "an event whose type is filtered out stays silent"
);
check(
  decideNotification({ type: "run-failed", skill: "x" }, onlyFailed) !== null,
  "the one allowed type still fires under a narrowed filter"
);
check(decideNotification({ type: "totally-unknown" }, allOn) === null, "an unknown event type returns null");
check(decideNotification(null as never, allOn) === null, "a null event returns null");
check(decideNotification({} as never, allOn) === null, "an event with no type returns null");

// --- emitNotification: guard paths only (no real banner posted) -------------
check(emitNotification(null as never) === false, "emitNotification(null) is a no-op, returns false");
check(emitNotification({ body: "no title" } as never) === false, "emitNotification with no title is a no-op");

// --- summary ----------------------------------------------------------------
console.log(failed === 0 ? `\nAll notification checks pass.` : `\n${failed} notification check(s) failed.`);
process.exit(failed ? 1 : 0);
