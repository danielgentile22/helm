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
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

  // 3b. vault-cleanup guardrails (PRD C): the built prompt must name every
  //     protected path and must not regress to the old deny-list phrasing
  //     ("outside system/ and archive/") that made Atlas and daily-notes
  //     archival candidates.
  {
    const prompt = buildPrompt({ id: PROBE_ID, skill: "vault-cleanup", args: {} }, "inbox/reports/vault-cleanup/probe.md") ?? "";
    const protectedPaths = ["Atlas/", "daily-notes/", "CLAUDE.md", "system/", "archive/", "_board-snapshot.md", "morphy-state.json"];
    const unnamed = protectedPaths.filter((p) => !prompt.includes(p));
    if (unnamed.length) {
      fail(`vault-cleanup prompt no longer names protected path(s): [${unnamed}]`);
    } else if (prompt.includes("outside system/ and archive/")) {
      fail("vault-cleanup prompt reintroduced deny-list scoping — Atlas/daily-notes become archival candidates");
    } else {
      pass("vault-cleanup — allow-list prompt names all protected paths");
    }
  }

  // 4. Coupling #3 (CLAUDE.md): the hardcoded HUD_TZ default in lib/config.ts
  //    must equal the one in runner/runner.js. Compare the SOURCE literals,
  //    not the resolved values — a machine's ~/.claude/.env would mask drift.
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const configDefault = readFileSync(join(root, "lib", "config.ts"), "utf8").match(
    /export const HUD_TZ = homeEnv\("HUD_TZ"\) \?\? "([^"]+)"/
  )?.[1];
  const runnerDefault = readFileSync(join(root, "runner", "runner.js"), "utf8").match(
    /const HUD_TZ = env\("HUD_TZ"\) \|\| "([^"]+)"/
  )?.[1];
  if (!configDefault || !runnerDefault) {
    fail("HUD_TZ default not found in lib/config.ts or runner/runner.js (pattern drifted — update this test)");
  } else if (configDefault !== runnerDefault) {
    fail(`HUD_TZ defaults diverge: lib/config.ts="${configDefault}" vs runner.js="${runnerDefault}" — "today" will split near midnight UTC`);
  } else {
    pass(`HUD_TZ defaults match across lib/config.ts and runner.js (${configDefault})`);
  }

  // 5. Scheduled plists (issue #43): every scripts/com.helm.*.plist that calls
  //    queue-intent.mjs must queue a skill the runner accepts — a typo'd skill
  //    name is a schedule that silently dead-letters every day.
  const { readdirSync } = await import("node:fs");
  const scriptsDir = join(root, "scripts");
  const plists = readdirSync(scriptsDir).filter((f) => f.endsWith(".plist"));
  if (plists.length < 3) fail(`expected the weekly/morning/plan plists in scripts/, found ${plists.length}`);
  for (const f of plists) {
    const xml = readFileSync(join(scriptsDir, f), "utf8");
    if (!xml.includes("queue-intent.mjs")) continue;
    // ProgramArguments: [node, queue-intent.mjs, <skill>, <source>]
    const m = xml.match(/queue-intent\.mjs<\/string>\s*<string>([^<]+)<\/string>/);
    if (!m) {
      fail(`${f} — calls queue-intent.mjs but no skill argument found`);
    } else if (!ALLOWED_SKILLS.has(m[1])) {
      fail(`${f} — queues "${m[1]}", which is not in ALLOWED_SKILLS (dead schedule)`);
    } else {
      pass(`${f} — queues ${m[1]} (allowed)`);
    }
  }

  // 6. Chat dispatch (issue #43): every skill CHAT_SYSTEM offers must be one
  //    the runner accepts — same drift guard as the deck/voice couplings.
  const { CHAT_SKILLS, chatSystem } = await import("../lib/chat");
  const sys = chatSystem(false);
  for (const skill of CHAT_SKILLS) {
    if (!ALLOWED_SKILLS.has(skill)) fail(`chat offers "${skill}" but it is not in ALLOWED_SKILLS`);
    else if (!sys.includes(skill)) fail(`CHAT_SKILLS lists "${skill}" but chatSystem never names it`);
    else pass(`chat can queue ${skill}`);
  }
  if (!sys.includes("DISPATCH")) {
    fail("chatSystem no longer teaches the DISPATCH sentinel");
  } else {
    pass("chatSystem carries the DISPATCH dispatch contract");
  }

  // 7. Machine record (issue #44): .helm-config.json is authoritative by
  //    CLAUDE.md instruction, so its skills array and launchdAgents list must
  //    match ALLOWED_SKILLS and the versioned scripts/*.plist inventory.
  //    The file is gitignored (machine-local) — skip on a fresh clone. It stays
  //    Mac-only by design (issue #45): the record describes THIS machine's
  //    wiring, so there is nothing for CI to compare against.
  const { existsSync } = await import("node:fs");
  const cfgPath = join(root, ".helm-config.json");
  if (!existsSync(cfgPath)) {
    pass(".helm-config.json absent (fresh clone) — machine-record checks skipped");
  } else {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const cfgSkills = new Set<string>(cfg.skills ?? []);
    const missing = [...ALLOWED_SKILLS].filter((s) => !cfgSkills.has(s));
    const extra = [...cfgSkills].filter((s) => !ALLOWED_SKILLS.has(s));
    if (missing.length || extra.length) {
      fail(`.helm-config.json skills drifted — missing: [${missing}] extra: [${extra}]`);
    } else {
      pass(`.helm-config.json skills match ALLOWED_SKILLS (${cfgSkills.size})`);
    }
    const cfgAgents = new Set<string>(cfg.launchdAgents ?? []);
    const plistAgents = new Set(plists.map((f) => f.replace(/\.plist$/, "")));
    const unversioned = [...cfgAgents].filter((a) => !plistAgents.has(a));
    const unrecorded = [...plistAgents].filter((a) => !cfgAgents.has(a));
    if (unversioned.length || unrecorded.length) {
      fail(`launchd inventory drifted — in config but not scripts/: [${unversioned}]; in scripts/ but not config: [${unrecorded}]`);
    } else {
      pass(`launchdAgents match scripts/*.plist (${cfgAgents.size} agents)`);
    }
  }

  // 8b. Model allowlist (issue #26): the same id set lives in runner.js,
  //     lib/chat.ts, and lib/modelOverride.ts. A rename that misses one copy
  //     silently downgrades the model while the spoken ack claims otherwise.
  {
    const { MODEL_ALLOWLIST: runnerModels } = await import("../runner/runner.js");
    const { MODEL_ALLOWLIST: chatModels } = await import("../lib/chat");
    const { MODEL_PHRASES } = await import("../lib/modelOverride");
    const phraseModels = new Set(Object.values(MODEL_PHRASES).map((p) => p.id));
    const show = (s: Set<string>) => [...s].sort().join(", ");
    const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
    if (!sameSet(runnerModels, chatModels)) {
      fail(`model allowlists diverge: runner.js {${show(runnerModels)}} vs lib/chat.ts {${show(chatModels)}}`);
    } else if (!sameSet(runnerModels, phraseModels)) {
      fail(`model allowlists diverge: runner.js {${show(runnerModels)}} vs lib/modelOverride.ts {${show(phraseModels)}}`);
    } else {
      pass(`model allowlist identical across runner.js, lib/chat.ts, lib/modelOverride.ts (${runnerModels.size} ids)`);
    }
  }

  // 8. Version (issue #44): package.json is the one version source. The
  //    heartbeat must read PKG_VERSION (never a hardcoded literal).
  const runnerSrc = readFileSync(join(root, "runner", "runner.js"), "utf8");
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (!runnerSrc.includes("version: PKG_VERSION")) {
    fail("runner heartbeat no longer uses PKG_VERSION — hardcoded version literals drift");
  } else {
    pass(`runner heartbeat reports package.json version (${pkgVersion})`);
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
