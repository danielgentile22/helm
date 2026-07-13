// Chat-route helpers sweep — model allowlist, message/threadId validation,
// claude-stdout parsing, and the per-process busy-lock. Pure lib/chat.ts
// against synthetic input: no network, no claude spawn, nothing written.
// Run: npx -y tsx scripts/test-chat.ts
import {
  CHAT_SKILLS,
  DEFAULT_MODEL,
  acquireThread,
  chatSystem,
  modelFor,
  parseClaudeJson,
  parseDispatch,
  releaseThread,
  resolveThreadId,
  stripDispatch,
  validateMessage,
} from "../lib/chat";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const eq = (got: unknown, want: unknown, msg: string) =>
  got === want ? pass(msg) : fail(`${msg}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

// --- model selection ---------------------------------------------------------
eq(modelFor("claude-opus-4-8"), "claude-opus-4-8", "allowlisted model passes through");
eq(modelFor("claude-sonnet-4-6"), "claude-sonnet-4-6", "default model is allowlisted");
eq(modelFor("gpt-4o"), DEFAULT_MODEL, "unknown model → default");
eq(modelFor(undefined), DEFAULT_MODEL, "absent model → default");
eq(modelFor(42), DEFAULT_MODEL, "non-string model → default");

// --- message validation ------------------------------------------------------
{
  const r = validateMessage("");
  check(!r.ok && r.status === 400, "empty message → 400");
}
{
  const r = validateMessage("   \n\t ");
  check(!r.ok && r.status === 400, "whitespace-only message → 400");
}
{
  const r = validateMessage("x".repeat(8001));
  check(!r.ok && r.status === 413, "over-length message → 413");
}
{
  const r = validateMessage("  hello vault  ");
  check(r.ok && r.message === "hello vault", "valid message → trimmed + ok");
}
{
  const r = validateMessage("x".repeat(8000));
  check(r.ok, "exactly MAX_MESSAGE chars is allowed (boundary)");
}

// --- threadId resolution -----------------------------------------------------
{
  const valid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  eq(resolveThreadId(valid), valid, "valid threadId is preserved");
}
{
  const fresh = resolveThreadId("not a uuid!");
  check(/^[a-f0-9-]{8,40}$/i.test(fresh), "invalid threadId → fresh uuid (matches the same shape)");
}
{
  const fresh = resolveThreadId(undefined);
  check(/^[a-f0-9-]{8,40}$/i.test(fresh), "absent threadId → fresh uuid");
  check(fresh !== resolveThreadId(undefined), "each minted threadId is distinct");
}
check(resolveThreadId("short") !== "short", "too-short threadId is rejected (minted instead)");

// --- claude stdout parsing ---------------------------------------------------
eq(parseClaudeJson("not json at all"), null, "malformed stdout → null");
eq(parseClaudeJson(""), null, "empty stdout → null");
{
  const obj = parseClaudeJson('{"result":"hi","session_id":"s1"}');
  check(obj?.result === "hi" && obj?.session_id === "s1", "well-formed stdout → parsed object");
}
{
  // claude sometimes prints log lines before the JSON object — grab the last block
  const obj = parseClaudeJson('warming up...\nloaded\n{"result":"ok","session_id":"s2"}\n');
  check(obj?.result === "ok" && obj?.session_id === "s2", "stray leading lines → last {...} block parsed");
}

// --- busy-lock (concurrent turns on a thread rejected) -----------------------
{
  const t = "lock-test-thread";
  check(acquireThread(t), "first acquire succeeds");
  check(!acquireThread(t), "second acquire on a busy thread is rejected");
  releaseThread(t);
  check(acquireThread(t), "acquire succeeds again after release");
  releaseThread(t);
  check(acquireThread("other-thread"), "a different thread is independently lockable");
}

// --- dispatch enforcement (issue #16) ----------------------------------------
// The security property: route code, not model obedience, decides what queues.
eq(parseDispatch("DISPATCH morning-report"), "morning-report", "allowed skill on its own line → dispatched");
eq(parseDispatch("Sure, running it now.\nDISPATCH weekly-review\nIt's queued."), "weekly-review", "sentinel embedded in prose is still parsed");
eq(parseDispatch("DISPATCH Morning-Report"), "morning-report", "sentinel is case-insensitive, normalized lowercase");
// (a) a non-CHAT_SKILLS skill is rejected by parse, not by the prompt
eq(parseDispatch("DISPATCH voice-ask"), null, "injected voice-ask sentinel is rejected");
eq(parseDispatch("DISPATCH morphy-task-add"), null, "injected morphy-task-add sentinel is rejected");
eq(parseDispatch("DISPATCH rm-rf-vault"), null, "unknown skill sentinel is rejected");
eq(parseDispatch("Please dispatch morning-report for me"), null, "skill named only in prose does not dispatch");
eq(parseDispatch("no sentinel here"), null, "reply with no sentinel → null");
for (const skill of CHAT_SKILLS) {
  eq(parseDispatch(`DISPATCH ${skill}`), skill, `every CHAT_SKILLS skill dispatches: ${skill}`);
}

// stripDispatch hides the machine token from the user-facing reply
eq(stripDispatch("It's queued.\nDISPATCH morning-report\n"), "It's queued.", "sentinel line stripped from reply");
eq(stripDispatch("DISPATCH morning-report"), "", "reply that is only a sentinel → empty (route shows '(no reply)')");
eq(stripDispatch("plain reply, no sentinel"), "plain reply, no sentinel", "reply without a sentinel is untouched");

// (b) the CHAT_ONLY prompt variant carries NO queue/dispatch contract
{
  const chatOnly = chatSystem(true);
  check(!chatOnly.includes("DISPATCH"), "CHAT_ONLY prompt does not teach the DISPATCH sentinel");
  check(!chatOnly.includes("system/queue/"), "CHAT_ONLY prompt does not teach the queue file contract");
  check(chatOnly.includes("Mac"), "CHAT_ONLY prompt points him at the Mac to dispatch");
  const normal = chatSystem(false);
  check(normal.includes("DISPATCH"), "normal prompt DOES teach the DISPATCH sentinel");
}

console.log(failed === 0 ? `\nAll chat checks pass.` : `\n${failed} chat check(s) failed.`);
process.exit(failed ? 1 : 0);
