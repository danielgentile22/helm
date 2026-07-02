// Callout derivation sweep — deriveCallouts(prev, cur) turns two vault
// snapshots into the new toasts the shell should surface. Pure: imports
// lib/callouts only. Guards that toasts fire on transitions and never repeat.
// Run: npx -y tsx scripts/test-callouts.ts
import {
  deriveCallouts,
  mergeToasts,
  runsNeedingFeedLine,
  type CalloutSnapshot,
  type CalloutRun,
  type Toast,
} from "../lib/callouts";

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

// ---------------------------------------------------------------------------
// mergeToasts — the shell's stack merge honors the "replace started with done
// in place" contract (review #41: both used to show at once for fast runs)
// ---------------------------------------------------------------------------

const toast = (id: string, kind: Toast["kind"]): Toast => ({ id, kind, label: "x" });

{
  const next = mergeToasts([toast("started:a", "started")], [toast("done:a", "done")]);
  check(
    next.length === 1 && next[0].id === "done:a",
    "a done toast replaces its run's started toast in place"
  );
}
{
  const next = mergeToasts([toast("started:a", "started")], [toast("failed:a", "failed")]);
  check(next.length === 1 && next[0].id === "failed:a", "a failed toast also replaces the started toast");
}
{
  const next = mergeToasts([toast("started:a", "started")], [toast("done:b", "done")]);
  check(next.length === 2, "an unrelated run's done toast leaves other started toasts alone");
}
{
  const next = mergeToasts([toast("done:a", "done")], [toast("done:a", "done")]);
  check(next.length === 1, "duplicate ids never stack");
}

// ---------------------------------------------------------------------------
// runsNeedingFeedLine — the feed logs first sight AND the terminal transition
// (review #37: outcomes used to never reach the persistent feed)
// ---------------------------------------------------------------------------

{
  const seen = new Map<string, string>();
  const first = runsNeedingFeedLine(seen, [{ id: "a", status: "running" }]);
  check(first.length === 1, "a newly-seen running run gets a feed line");
  first.forEach((r) => seen.set(r.id, r.status));

  const again = runsNeedingFeedLine(seen, [{ id: "a", status: "running" }]);
  check(again.length === 0, "a run that stays running doesn't re-log");

  const done = runsNeedingFeedLine(seen, [{ id: "a", status: "ok" }]);
  check(done.length === 1, "the running → ok transition gets an outcome line");
  done.forEach((r) => seen.set(r.id, r.status));

  const settled = runsNeedingFeedLine(seen, [{ id: "a", status: "ok" }]);
  check(settled.length === 0, "a terminal run never re-logs");
}
{
  const seen = new Map<string, string>();
  const t = runsNeedingFeedLine(seen, [{ id: "b", status: "error" }]);
  check(t.length === 1, "a run first seen already failed still gets its err line");
}

console.log(failed === 0 ? `\nAll callout checks pass.` : `\n${failed} callout check(s) failed.`);
process.exit(failed ? 1 : 0);
