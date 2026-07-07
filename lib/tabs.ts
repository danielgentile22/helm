// Tab registry — the single source of truth for HELM's project tabs and the
// skill↔tab mapping. Client-safe (no fs/skills import — this ships in the
// browser bundle via TabNav). The load-bearing invariant — the union of every
// tab's skills equals ALLOWED_SKILLS — is guarded in scripts/test-tabs.ts,
// which imports lib/skills in Node where fs is fine. Splitting the deck across
// tabs must keep that union intact.

export type TabId = "today" | "morphy" | "jobs" | "chess" | "chat";

export interface Tab {
  id: TabId;
  route: string;
  label: string;
  icon: string; // Lucide icon name (rendered by the tab nav)
  phone: boolean; // visible in the phone bottom tab bar
}

// Ordered — TABS[0] is the default landing tab (Today, at `/`).
export const TABS: Tab[] = [
  { id: "today", route: "/", label: "Today", icon: "layout-dashboard", phone: true },
  { id: "morphy", route: "/morphy", label: "Morphy", icon: "briefcase", phone: true },
  { id: "jobs", route: "/jobs", label: "Job Search", icon: "target", phone: true },
  { id: "chess", route: "/chess", label: "Chess", icon: "crown", phone: true },
  { id: "chat", route: "/chat", label: "Chat", icon: "message-square", phone: true },
];

export const DEFAULT_TAB = TABS[0];

// Every ALLOWED_SKILL maps to exactly one tab. Daily skills → Today; Morphy
// skills → Morphy; Job/Chess start with none (they ship as read-only
// dashboards). voice-ask is ambient (fired by the shell's voice, no button) —
// it lives on Today, the cockpit that hosts the orb.
const SKILL_TAB: Record<string, TabId> = {
  "morning-report": "today",
  "inbox-brief": "today",
  "plan-today": "today",
  "plan-tomorrow": "today",
  "vault-cleanup": "today",
  "weekly-review": "today",
  "atlas-distill": "today",
  "voice-ask": "today",
  "morphy-sync": "morphy",
  "morphy-task-add": "morphy",
};

// The deck buttons, per tab. A subset of ALLOWED_SKILLS: voice-ask has no
// button (it's spoken), so it never appears here. This is the roster the
// runner contract (lib/skills.ts ↔ runner.js) must keep in sync with — the
// tab-registry test guards the union.
export const DECK_SKILLS: { skill: string; label: string }[] = [
  { skill: "morning-report", label: "AM Report" },
  { skill: "inbox-brief", label: "Inbox Brief" },
  { skill: "plan-today", label: "Plan Today" },
  { skill: "plan-tomorrow", label: "Plan Tmrw" },
  { skill: "vault-cleanup", label: "Vault Clean" },
  { skill: "weekly-review", label: "Weekly Rev" },
  { skill: "atlas-distill", label: "Distill" },
  { skill: "morphy-sync", label: "Morphy Sync" },
  // morphy-task-add has no deck button — the TaskAdd panel is its UI (same
  // reasoning as voice-ask above). It stays in SKILL_TAB for the union test.
];

/** The tab a skill belongs to, or null if the skill isn't mapped. */
export function tabForSkill(skill: string): TabId | null {
  return SKILL_TAB[skill] ?? null;
}

/** Every skill mapped to a tab (all ALLOWED_SKILLS mapped there). */
export function skillsForTab(tabId: TabId): string[] {
  return Object.keys(SKILL_TAB).filter((s) => SKILL_TAB[s] === tabId);
}

/** The deck buttons that belong on a tab (skillsForTab ∩ DECK_SKILLS). */
export function deckSkillsForTab(tabId: TabId): { skill: string; label: string }[] {
  return DECK_SKILLS.filter((d) => SKILL_TAB[d.skill] === tabId);
}

export function tabByRoute(route: string): Tab | undefined {
  return TABS.find((t) => t.route === route);
}
