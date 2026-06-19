// Skill-contract sweep — the load-bearing coupling between lib/skills.ts and
// runner.js, checked by behavior rather than by eye. Every skill in
// ALLOWED_SKILLS must be EITHER native (executed in-process by the runner) OR
// have BOTH a deliverablePathFor() path and a buildPrompt() case. A skill that
// the HUD will happily queue but the runner can't build a prompt for is a silent
// misroute — this test makes that a red build.
//
// Pure: imports the runner module for its exported contract functions only. The
// runner's boot sequence is gated behind an entrypoint check, so importing it
// here spawns nothing and writes nothing. No queue writes, no `claude` spend.
//
// Run: npx -y tsx scripts/test-skill-contract.ts
import { tmpdir } from "node:os";
import { join } from "node:path";

// runner.js + lib/config both read VAULT_ROOT at module load. Set a throwaway
// one BEFORE the dynamic imports below so init doesn't throw/exit — the
// contract functions never touch the filesystem, so the path need not exist.
process.env.VAULT_ROOT = process.env.VAULT_ROOT || join(tmpdir(), "helm-skill-contract");

// Representative args so skills that require input (voice-ask needs a prompt,
// morphy-task-add a title) still build — we're testing "is there a case", not
// "does it run with empty input".
const PROBE_ARGS = { prompt: "skill-contract probe", title: "skill-contract probe", context: "" };
const PROBE_ID = "contracttest0000";

async function run(): Promise<void> {
  const { ALLOWED_SKILLS } = await import("../lib/skills");
  const { buildPrompt, deliverablePathFor, NATIVE_SKILLS } = await import("../runner/runner.js");

  let failed = 0;
  const pass = (msg: string) => console.log(`PASS  ${msg}`);
  const fail = (msg: string) => {
    failed++;
    console.log(`FAIL  ${msg}`);
  };

  // 1. Every allowed skill is native, or has a path + a prompt.
  for (const skill of ALLOWED_SKILLS) {
    if (NATIVE_SKILLS.has(skill)) {
      pass(`${skill} — native (in-process, no prompt needed)`);
      continue;
    }
    const intent = { id: PROBE_ID, skill, args: PROBE_ARGS };
    const path = deliverablePathFor(intent);
    if (!path) {
      fail(`${skill} — deliverablePathFor() returned null (no deliverable path)`);
      continue;
    }
    const prompt = buildPrompt(intent, path);
    if (!prompt) {
      fail(`${skill} — buildPrompt() returned null (no prompt-builder case)`);
      continue;
    }
    pass(`${skill} — ${path} + prompt (${prompt.length} chars)`);
  }

  // 2. Every native skill is actually allowed (the reverse coupling).
  for (const skill of NATIVE_SKILLS) {
    if (!ALLOWED_SKILLS.has(skill)) fail(`native skill "${skill}" is missing from ALLOWED_SKILLS`);
  }

  // 3. weekly-review specifically satisfies the contract and lands in the
  //    reports trail (slice-10 acceptance criterion).
  if (!ALLOWED_SKILLS.has("weekly-review")) {
    fail("weekly-review is not in ALLOWED_SKILLS");
  } else if (NATIVE_SKILLS.has("weekly-review")) {
    fail("weekly-review must be a headless `claude -p` skill, not native");
  } else {
    const intent = { id: PROBE_ID, skill: "weekly-review", args: {} };
    const path = deliverablePathFor(intent);
    const prompt = buildPrompt(intent, path);
    if (!path || !path.startsWith("inbox/reports/")) {
      fail(`weekly-review deliverable is not in the reports trail: ${path}`);
    } else if (!prompt) {
      fail("weekly-review has no prompt-builder case");
    } else {
      pass(`weekly-review — reports trail (${path}) + prompt`);
    }
  }

  const total = ALLOWED_SKILLS.size;
  console.log(
    failed === 0
      ? `\nAll ${total} allowed skills satisfy the contract.`
      : `\n${failed} contract violation(s) across ${total} allowed skills.`
  );
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(`test-skill-contract crashed: ${e?.stack || e}`);
  process.exit(1);
});
