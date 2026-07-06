"use client";

// Today — the daily cockpit. The reactor orb is the hero (desktop); the daily
// deck, schedule, AI Wire, documents trail, activity feed, and the Claude 5h
// token tile live here. On a phone it collapses to a read-only glance (no orb,
// no deck, no voice/audio).
import { useShell } from "@/components/shell/ShellContext";
import { deckSkillsForTab } from "@/lib/tabs";
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
  // real utilization from the OAuth usage endpoint (same source as Claude
  // Code's /usage screen) — NOT an estimate against a personal peak
  const usageTiles = [
    { metric: "pct_5h", label: "Claude 5h Window", foot: "of plan session limit" },
    { metric: "pct_7d", label: "Claude Week", foot: "of weekly all-models limit" },
    { metric: "pct_7d_fable", label: "Claude Week (Fable)", foot: "of weekly Fable limit" },
  ].map((t) => ({ ...t, m: state ? findMetric(state.metrics, "claude_code", t.metric) : null }));

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
        {usageTiles.map(({ metric, label, foot, m }) =>
          m ? (
            <StatTile
              key={metric}
              label={label}
              value={Math.round(m.value)}
              unit="%"
              tone="info"
              spark={m.history.map((h) => h.value)}
              foot={foot}
              stale={fmtAge(m.timestamp).stale}
            />
          ) : null
        )}
        {isPhone === false && <Feed />}
        {isPhone === false && <AudioMeter />}
      </div>
    </div>
  );
}
