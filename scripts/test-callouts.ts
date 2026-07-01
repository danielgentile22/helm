// Callout derivation sweep — deriveCallouts(prev, cur) turns two vault
// snapshots into the new toasts the shell should surface. Pure: imports
// lib/callouts only. Guards that toasts fire on transitions and never repeat.
// Run: npx -y tsx scripts/test-callouts.ts
import { deriveCallouts, type CalloutSnapshot, type CalloutRun } from "../lib/callouts";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

const r = (id: string, status: string, over: Partial<CalloutRun> = {}): CalloutRun => ({
  id,
  skill: "morning-report",
  label: null,
  status,
  deliverable_path: null,
  link: null,
  ...over,
});
const snap = (runs: CalloutRun[], reportRel: string | null = null): CalloutSnapshot => ({ runs, reportRel });

// --- prime silently on first sight -----------------------------------------
{
  const t = deriveCallouts(null, snap([r("a", "ok", { deliverable_path: "inbox/a.md" })], "inbox/rep.md"));
  check(t.length === 0, "first call primes silently (no toasts for pre-existing state)");
}

// --- a run starting → started toast ----------------------------------------
{
  const t = deriveCallouts(snap([]), snap([r("a", "running")]));
  check(t.length === 1 && t[0].kind === "started", "a newly-running run emits a started toast");
  check(t[0].id === "started:a", "started toast is keyed by run id");
}

// --- a run completing with a deliverable → done toast w/ target ------------
{
  const prev = snap([r("a", "running")]);
  const cur = snap([r("a", "ok", { deliverable_path: "inbox/reports/x.md" })]);
  const t = deriveCallouts(prev, cur);
  check(t.length === 1 && t[0].kind === "done", "completion emits a done toast");
  check(t[0].target === "inbox/reports/x.md", "done toast targets the deliverable");
}

// --- external-output run → done toast targets the link ---------------------
{
  const prev = snap([r("a", "running")]);
  const cur = snap([r("a", "ok", { deliverable_path: "inbox/x.md", link: "https://mail.google.com/x" })]);
  const t = deriveCallouts(prev, cur);
  check(t[0].target === "https://mail.google.com/x", "link output wins over the local deliverable");
}

// --- a run failing → failed toast, no target -------------------------------
{
  const t = deriveCallouts(snap([r("a", "running")]), snap([r("a", "error")]));
  check(t.length === 1 && t[0].kind === "failed" && t[0].target === undefined, "failure emits a targetless failed toast");
}

// --- no duplicate once terminal --------------------------------------------
{
  const done = snap([r("a", "ok", { deliverable_path: "inbox/a.md" })]);
  const t = deriveCallouts(done, done);
  check(t.length === 0, "an already-terminal run never re-emits");
}

// --- a running run that stays running doesn't re-announce ------------------
{
  const t = deriveCallouts(snap([r("a", "running")]), snap([r("a", "running")]));
  check(t.length === 0, "a run that stays running only announces its start once");
}

// --- a fresh morning report → report toast ---------------------------------
{
  const t = deriveCallouts(snap([], "inbox/old.md"), snap([], "inbox/new.md"));
  check(t.length === 1 && t[0].kind === "report", "a new report path emits a report toast");
  check(t[0].target === "inbox/new.md", "report toast targets the report");
}

// --- the same report path doesn't re-fire ----------------------------------
{
  const t = deriveCallouts(snap([], "inbox/rep.md"), snap([], "inbox/rep.md"));
  check(t.length === 0, "an unchanged report path emits nothing");
}

// --- a run whose start we missed still reports its completion ---------------
{
  // run appears already ok (start poll was missed) — prev has no record of it
  const t = deriveCallouts(snap([]), snap([r("a", "ok", { deliverable_path: "inbox/a.md" })]));
  check(t.length === 1 && t[0].kind === "done", "a run seen only at completion still emits done");
}

// --- voice-ask label formatting --------------------------------------------
{
  const t = deriveCallouts(snap([r("v", "running")]), snap([r("v", "ok", { skill: "voice-ask", label: "fable 5 news" })]));
  check(t[0].label === "fable 5 news ask", "a voice-ask toast uses its topic label");
}

console.log(failed === 0 ? `\nAll callout checks pass.` : `\n${failed} callout check(s) failed.`);
process.exit(failed ? 1 : 0);
