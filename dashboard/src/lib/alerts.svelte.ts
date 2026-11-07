// The alerts the badges count and each tab lists at its top (ADR 0039). One poll for the
// whole page, refreshed whenever the visible tab fetches and on focus.

import { fetchJson, type Answer } from "./api";
import { createPoll } from "./poll.svelte";
import type { Tab } from "./route.svelte";

export interface Alert {
  key: string;
  tab: Tab;
  title: string;
  opened: string;
  fingerprint: string;
  pushed: string | null;
  dismissed: string | null;
  closed: string | null;
  // The fix session a failing job started (ADR 0041): a T3 thread's link or id, or the
  // ~-shortened log of a headless run.
  session: string | null;
}

export interface AlertsResponse {
  alerts: Alert[];
  counts: Record<Tab, number>;
  total: number;
}

const NONE: AlertsResponse = {
  alerts: [],
  counts: { projects: 0, ideas: 0, background: 0, devices: 0 },
  total: 0,
};

const poll = createPoll(() => fetchJson<AlertsResponse>("/api/alerts"));

// Keys dismissed here and not yet gone from the server's answer, so a tap hides at once.
let hidden = $state<string[]>([]);

function current(): AlertsResponse {
  const load = poll.load;
  if (load.state !== "ready") return NONE;
  if (hidden.length === 0) return load.data;
  const shown = load.data.alerts.filter((a) => !hidden.includes(a.key));
  const counts = { ...NONE.counts };
  for (const a of shown) counts[a.tab]++;
  return { alerts: shown, counts, total: shown.length };
}

export const alerts = {
  get now(): AlertsResponse {
    return current();
  },
  start: () => poll.start(),
  stop: () => poll.stop(),
  refresh: () => poll.refresh(),
  async dismiss(key: string): Promise<Answer<unknown>> {
    hidden = [...hidden, key];
    const answer = await fetchJson<unknown>(`/api/alerts/${encodeURIComponent(key)}/dismiss`, {});
    await poll.refresh();
    hidden = hidden.filter((k) => k !== key);
    return answer;
  },
};

/** The number on the app icon, where the browser has one. */
export function setIconBadge(total: number): void {
  if (!("setAppBadge" in navigator)) return;
  const done = total > 0 ? navigator.setAppBadge(total) : navigator.clearAppBadge();
  done.catch(() => undefined);
}
