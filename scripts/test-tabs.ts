// Tab-registry sweep — guards the load-bearing invariant that splitting the
// skill deck across project tabs never drops a skill from the
// ALLOWED_SKILLS ↔ runner ↔ deck contract. Pure: imports lib/tabs only.
// Run: npx -y tsx scripts/test-tabs.ts
import {
  TABS,
  DEFAULT_TAB,
  DECK_SKILLS,
  tabForSkill,
  skillsForTab,
  deckSkillsForTab,
  tabByRoute,
} from "../lib/tabs";
import { ALLOWED_SKILLS } from "../lib/skills";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// --- registry is well-formed -----------------------------------------------
check(new Set(TABS.map((t) => t.id)).size === TABS.length, "tab ids are unique");
check(new Set(TABS.map((t) => t.route)).size === TABS.length, "tab routes are unique");
check(DEFAULT_TAB.id === "today" && DEFAULT_TAB.route === "/", "Today is the default tab at /");
check(TABS[0] === DEFAULT_TAB, "the default tab is the first in the ordered list");
check(
  TABS.every((t) => t.label && t.icon && typeof t.phone === "boolean"),
  "every tab has a label, an icon, and a phone flag"
);

// --- the union invariant: every ALLOWED_SKILL is mapped to exactly one tab --
const mapped = TABS.flatMap((t) => skillsForTab(t.id));
check(new Set(mapped).size === mapped.length, "no skill is mapped to two tabs");
check(
  new Set(mapped).size === ALLOWED_SKILLS.size &&
    [...ALLOWED_SKILLS].every((s) => mapped.includes(s)),
  `the union of tab skills equals ALLOWED_SKILLS (${ALLOWED_SKILLS.size})`
);

// --- tabForSkill / skillsForTab are mutually consistent --------------------
for (const skill of ALLOWED_SKILLS) {
  const tab = tabForSkill(skill);
  check(tab !== null, `tabForSkill("${skill}") resolves`);
  if (tab) check(skillsForTab(tab).includes(skill), `${skill} ∈ skillsForTab("${tab}")`);
}
check(tabForSkill("does-not-exist") === null, "an unknown skill maps to no tab");

// --- deck buttons are a subset of allowed skills, each on exactly one tab ---
for (const d of DECK_SKILLS) {
  check(ALLOWED_SKILLS.has(d.skill), `deck skill "${d.skill}" is an allowed skill`);
  check(tabForSkill(d.skill) !== null, `deck skill "${d.skill}" maps to a tab`);
}
const deckUnion = TABS.flatMap((t) => deckSkillsForTab(t.id).map((d) => d.skill));
check(deckUnion.length === DECK_SKILLS.length, "every deck skill lands on exactly one tab");
check(
  deckSkillsForTab("today").some((d) => d.skill === "morning-report"),
  "Today owns the daily deck (morning-report)"
);
check(
  deckSkillsForTab("morphy").map((d) => d.skill).sort().join(",") === "morphy-sync,morphy-task-add",
  "Morphy owns Sync + Task Add"
);
check(deckSkillsForTab("jobs").length === 0, "Job Search ships with no deck skills");
check(deckSkillsForTab("chess").length === 0, "Chess ships with no deck skills");
// voice-ask is allowed + mapped, but has no button
check(!DECK_SKILLS.some((d) => d.skill === "voice-ask"), "voice-ask has no deck button");
check(tabForSkill("voice-ask") === "today", "voice-ask (ambient) lives on Today");

// --- route lookup ----------------------------------------------------------
check(tabByRoute("/morphy")?.id === "morphy", "tabByRoute finds the Morphy tab");
check(tabByRoute("/nope") === undefined, "tabByRoute misses on an unknown route");

console.log(failed === 0 ? `\nAll tab-registry checks pass.` : `\n${failed} tab check(s) failed.`);
process.exit(failed ? 1 : 0);
