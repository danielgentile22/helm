"use client";

// Today — the daily cockpit. The reactor orb is the hero (desktop); the daily
// deck, schedule, AI Wire, documents trail, activity feed, and the Claude 5h
// token tile live here. On a phone it collapses to a read-only glance (no orb,
// no deck, no voice/audio).
import { useShell } from "@/components/shell/ShellContext";
import { deckSkillsForTab } from "@/lib/tabs";
import { fmtMetric } from "@/lib/vitals";
import type { Metric } from "@/lib/vault";
import StatTile from "@/components/StatTile";
import Orb from "@/components/panels/Orb";
import Deck from "@/components/panels/Deck";
import Schedule from "@/components/panels/Schedule";
import Wire from "@/components/panels/Wire";
import Documents from "@/components/panels/Documents";
import Feed from "@/components/panels/Feed";
import AudioMeter from "@/components/panels/AudioMeter";
import { fmtAge } from "@/components/panels/util";

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

export default function TodayPage() {
  const { state, isPhone } = useShell();
  const tokens = state ? findMetric(state.metrics, "claude_code", "tokens_5h") : null;
  // auto-calibrating cap: 100% = the biggest 5h window ever recorded
  const tokenPeak = tokens ? Math.max(...tokens.history.map((h) => h.value), tokens.value) : null;

  // isPhone === false (not !isPhone): during the pre-hydration null tick a
  // phone must not mount the heavy desktop subtree — the Orb alone pulls the
  // whole three.js chunk the moment it mounts
  return (
    <div className="tab-page today">
      {isPhone === false && <Orb />}

      <div className="today-hero">
        <div className="tab-head">
          <h1 className="tab-title">Today</h1>
          <p className="tab-sub">{isPhone ? "your day at a glance" : "hold Space to talk · the cockpit"}</p>
        </div>
      </div>

      {isPhone === false && <Deck skills={deckSkillsForTab("today")} title="Daily Deck" />}

      <div className="tab-grid grid-3">
        <Schedule />
        <Wire />
        <Documents />
        {tokens && tokenPeak !== null && tokenPeak > 0 && (
          <StatTile
            label="Claude 5h Window"
            value={Math.round((tokens.value / tokenPeak) * 100)}
            unit="%"
            tone="info"
            spark={tokens.history.map((h) => h.value)}
            foot={`${fmtMetric(tokens.value)} of ${fmtMetric(tokenPeak)} peak`}
            stale={fmtAge(tokens.timestamp).stale}
          />
        )}
        {isPhone === false && <Feed />}
        {isPhone === false && <AudioMeter />}
      </div>
    </div>
  );
}
