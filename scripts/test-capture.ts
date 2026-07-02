// Voice parser sweep — parseMorphyCapture (spoken capture → the shared
// Notion board Michael co-edits) and extractModelOverride (which model
// spends money on a run), plus the normalizeForSpeech money cases from
// review #40. Pure functions, no I/O. Run: npx -y tsx scripts/test-capture.ts
import { parseMorphyCapture } from "../lib/voiceDispatch";
import { extractModelOverride } from "../lib/modelOverride";
import { normalizeForSpeech } from "../lib/spokenText";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const eq = (got: unknown, want: unknown, msg: string) =>
  check(JSON.stringify(got) === JSON.stringify(want), `${msg} (got ${JSON.stringify(got)})`);

// --- parseMorphyCapture: capture gate ---------------------------------------
check(parseMorphyCapture("what's on the morphy board") === null, "question about the board is not a capture");
check(parseMorphyCapture("add a task to buy milk") === null, "non-morphy task is not a capture");
check(parseMorphyCapture("add a morphy task to email the AR rep") !== null, "add a morphy task → capture");

// --- title / assignee / priority extraction ----------------------------------
eq(
  parseMorphyCapture("add a Morphy task to email the AR rep, assign Michael, high priority"),
  { title: "Email the AR rep", assignee: "Michael", priority: "High" },
  "canonical spoken capture"
);
eq(
  parseMorphyCapture("add a morphy to-do for me: review the lease"),
  { title: "Review the lease", assignee: "Daniel", priority: "Med" },
  "'for me' → Daniel, colon title"
);
eq(
  parseMorphyCapture("make a morphy task assign both to call the tower crew"),
  { title: "Call the tower crew", assignee: "Both", priority: "Med" },
  "'assign both' → Both"
);
eq(
  parseMorphyCapture("priority low, add a morphy item to send the invoice"),
  { title: "Send the invoice", assignee: "Unassigned", priority: "Low" },
  "leading 'priority low' extracted"
);
eq(
  parseMorphyCapture("add morphy task to fix the high tower antenna"),
  { title: "Fix the high tower antenna", assignee: "Unassigned", priority: "Med" },
  "'high tower' stays in the title — no 'priority' adjacency"
);

// --- extractModelOverride -----------------------------------------------------
const lead = extractModelOverride("use opus, summarize the lease doc");
check(lead?.model === "claude-opus-4-8", "use opus → opus model id");
check(lead?.stripped === "summarize the lease doc", `leading phrase + comma stripped (got ${JSON.stringify(lead?.stripped)})`);
const tail = extractModelOverride("summarize the lease doc and use fable");
check(tail?.model === "claude-fable-5", "trailing use fable → fable model id");
check(tail?.stripped === "summarize the lease doc", `dangling 'and' stripped (got ${JSON.stringify(tail?.stripped)})`);
check(extractModelOverride("useful summary of the meeting") === null, "'useful' never matches");
check(extractModelOverride("opus is a nice word") === null, "bare model name never matches");

// --- normalizeForSpeech money (review #40 finding 20) -------------------------
const speak = (s: string) => normalizeForSpeech(s);
eq(speak("MRR is $4200 this month"), "MRR is 4 thousand dollars this month", "$4200 (no comma) rounds whole");
eq(speak("up from $4200.50"), "up from 4 thousand dollars", "cents dropped on comma-less amounts");
eq(speak("$4,200 total"), "4 thousand dollars total", "comma-grouped amounts still work");
eq(speak("$1 fee"), "one dollar fee", "$1 → singular dollar");
eq(speak("$999500 raised"), "1 million dollars raised", "999,500 rounds to one million, not '1000 thousand'");
eq(speak("$200M run rate"), "two hundred million dollars run rate", "suffix amounts untouched by the fix");

// --- summary -------------------------------------------------------------------
console.log(failed === 0 ? `\nAll capture checks pass.` : `\n${failed} capture check(s) failed.`);
process.exit(failed ? 1 : 0);
