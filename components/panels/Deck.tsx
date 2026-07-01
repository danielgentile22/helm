"use client";

import { useEffect, useMemo, useState } from "react";
import { deriveDeckState, type DeckPhase } from "@/lib/deck";
import { useShell } from "@/components/shell/ShellContext";
import { fmtClock, SectionTitle } from "./util";

// how long an optimistic "queued" mark survives before the polled state must
// vouch for it — covers the gap until the next 5s poll reflects the write
const OPTIMISTIC_MS = 8000;

// Command deck — buttons drop REAL intents into system/queue via the shell's
// queueSkill. The roster is passed in (deckSkillsForTab), so each tab shows
// only its own skills while the union stays whole.
export default function Deck({
  skills,
  title = "Command Deck",
}: {
  skills: { skill: string; label: string }[];
  title?: string;
}) {
  const { state, queueSkill } = useShell();
  const [firedAt, setFiredAt] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);

  const runs = state?.runs ?? [];
  const queue = state?.queue ?? [];
  const derived = useMemo(
    () => deriveDeckState(skills.map((d) => d.skill), runs, queue),
    [skills, runs, queue]
  );

  const nowMs = Date.now();
  const phaseFor = (skill: string): DeckPhase => {
    const d = derived[skill];
    if (d?.phase === "running") return "running";
    if (d?.phase === "queued") return "queued";
    const f = firedAt[skill];
    if (f != null && nowMs - f < OPTIMISTIC_MS) return "queued";
    return "idle";
  };

  const anyLive = skills.some((d) => phaseFor(d.skill) !== "idle");
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const fire = async (skill: string) => {
    if (phaseFor(skill) !== "idle") return;
    setFiredAt((f) => ({ ...f, [skill]: Date.now() }));
    const ok = await queueSkill(skill);
    if (!ok) setFiredAt((f) => ({ ...f, [skill]: 0 }));
  };

  const r = state?.runner;
  return (
    <section className="panel">
      <SectionTitle
        title={title}
        tick={
          r
            ? `${r.busy ? "ENGAGED" : "IDLE"} · ${r.active}/${r.max_concurrent} · ${r.pending} Q`
            : "RUNNER OFFLINE"
        }
      />
      {queue.length > 0 && (
        <div className="queue-list">
          {queue.slice(0, 3).map((q) => (
            <span key={q.id}>▸ {q.label ?? q.skill}</span>
          ))}
          {queue.length > 3 && <span className="dim">+{queue.length - 3} more</span>}
        </div>
      )}
      <div className="deck">
        {skills.map((d) => {
          const phase = phaseFor(d.skill);
          const running = phase === "running";
          const queued = phase === "queued";
          const startedAt = derived[d.skill]?.startedAt;
          const elapsed =
            running && startedAt ? Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000)) : 0;
          return (
            <button
              key={d.skill}
              className={`deck-btn ${running ? "running" : queued ? "queued" : ""}`}
              onClick={() => fire(d.skill)}
              disabled={running || queued}
            >
              {running ? <span className="deck-spinner" aria-hidden="true" /> : <span className="deck-dot" />}
              <span className="deck-label">{queued ? "QUEUED" : d.label}</span>
              {running ? <span className="deck-elapsed">{fmtClock(elapsed)}</span> : <span className="deck-arrow">→</span>}
            </button>
          );
        })}
      </div>
      <div className="deck-hint">intents write to system/queue — runner executes</div>
    </section>
  );
}
