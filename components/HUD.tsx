"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { VaultState, Metric } from "@/lib/vault";
import { voice } from "@/lib/voiceClient";
import { scrubRunSummary, humanizeFailure } from "@/lib/spokenText";
import { ratingProgress } from "@/lib/vitals";
import { levelToBars } from "@/lib/audio";
import { deriveCore, type CoreSignals } from "@/lib/core";
import { deriveDeckState, type DeckPhase } from "@/lib/deck";
import { BG_MODES, type BgMode, type CoreMode, type CoreFlare } from "./GraphCore";
import ReportOverlay from "./ReportOverlay";

const GraphCore = dynamic(() => import("./GraphCore"), { ssr: false });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + "K";
  if (Math.abs(n) >= 1_000) return (n / 1000).toFixed(1) + "K";
  return String(Math.round(n));
}

function fmtFull(n: number): string {
  return n.toLocaleString("en-US");
}

function useVaultState(intervalMs = 5000) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setState(await res.json());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    pull();
    const id = setInterval(pull, intervalMs);
    return () => clearInterval(id);
  }, [pull, intervalMs]);

  return { state, error, refresh: pull };
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function findMetric(metrics: Metric[], source: string, metric: string): Metric | null {
  return metrics.find((m) => m.source === source && m.metric === metric) ?? null;
}

// relative age of an ISO timestamp; stale = older than two missed 6h pulls
function fmtAge(ts: string | null): { label: string; stale: boolean } {
  if (!ts) return { label: "—", stale: true };
  const ms = Date.now() - Date.parse(ts);
  if (Number.isNaN(ms)) return { label: "—", stale: true };
  const stale = ms > 13 * 3600 * 1000;
  const m = Math.floor(ms / 60000);
  if (m < 1) return { label: "now", stale };
  if (m < 60) return { label: `${m}m`, stale };
  const h = Math.floor(m / 60);
  if (h < 48) return { label: `${h}h`, stale };
  return { label: `${Math.floor(h / 24)}d`, stale };
}

function fmtDur(s: number): string {
  if (s < 100) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// task callouts speak stopwatch ("0:42") — fmtDur is for completed-run feed lines
function fmtClock(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function noteAgeDays(date: string): number {
  const ms = Date.now() - Date.parse(`${date}T12:00:00`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

// animated count-up
function CountUp({ value, full = false, raw = false }: { value: number; full?: boolean; raw?: boolean }) {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const dur = 1400;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min((t - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (value - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  // raw = exact integer, no abbreviation and no thousands separator (e.g. a
  // chess rating shows "1545", never "1.5K" or "1,545").
  return <>{raw ? String(Math.round(display)) : full ? fmtFull(Math.round(display)) : fmt(display)}</>;
}

// inline sparkline from metric history — real data, no fake bars
function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="spark spark-flat" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const W = 100;
  const H = 16;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - 2 - ((v - min) / range) * (H - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const lastY = H - 2 - ((last - min) / range) * (H - 4);
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={lastY} r="1.8" fill="currentColor" />
    </svg>
  );
}

// section heading — typographic, no box
function SectionTitle({ title, tick, href }: { title: string; tick?: string; href?: string }) {
  return (
    <div className="sec-title">
      {href ? (
        <a className="sec-link" href={href} target="_blank" rel="noreferrer">
          {title} ↗
        </a>
      ) : (
        <span>{title}</span>
      )}
      {tick && <span className="tick">{tick}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// feed lines (voice transcript + run events — shown in the AudioIO mini feed)
// ---------------------------------------------------------------------------

interface FeedLine {
  ts: string;
  cls: string;
  text: string;
}

function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

// spoken line for a finished run — short, no markdown, summary clamped.
// Summaries pass through scrubRunSummary so prompt-contract violations
// ("(headless)", SAVED-path tails) never reach the speakers.
function runAnnouncement(skill: string, status: string, summary: string, label?: string | null): string {
  const name = label ? `${label} ask` : skill.replace(/-/g, " ");
  if (status !== "ok") {
    const why = summary ? humanizeFailure(summary) : "";
    return `${name} hit a snag${why ? ` — ${why.slice(0, 120)}` : "."}`;
  }
  const clean = scrubRunSummary(summary);
  // voice-ask runs put the spoken answer in line 1 of output (= summary) —
  // speak it directly instead of "voice ask complete"
  if (skill === "voice-ask" && clean) {
    return clean.slice(0, 220);
  }
  // "plan today is done. Done." — a summary that only says done adds nothing
  const redundant = /^(done|complete|completed|finished|all done|ok)[.!]?$/i.test(clean);
  return `${name} is done.${clean && !redundant ? ` ${clean.slice(0, 160)}` : ""}`;
}

// ---------------------------------------------------------------------------
// panels (memoized — only re-render when their slice of state changes)
// ---------------------------------------------------------------------------

// goal/floor opt a tile into a progress-to-goal bar (the floor→goal band the
// value is measured within — see ratingProgress). Tiles without a goal render
// no bar.
const VITAL_DEFS: {
  source: string;
  metric: string;
  label: string;
  raw?: boolean;
  goal?: number;
  floor?: number;
}[] = [
  { source: "uscf", metric: "rating", label: "USCF Rating", raw: true, goal: 1600, floor: 1200 },
];

function VitalLabel({ m, label }: { m: Metric; label: string }) {
  const age = fmtAge(m.timestamp);
  return (
    <span className="label">
      <i className={`status-dot ${m.status !== "ok" ? m.status : ""}`} />
      {label}
      {m.status === "mock" && <span className="sim-tag">SIM</span>}
      <span className={`age ${age.stale ? "stale" : ""}`}>{age.label}</span>
    </span>
  );
}

const Vitals = memo(function Vitals({ state, hot }: { state: VaultState; hot?: boolean }) {
  const metrics = state.metrics;
  const tokens = findMetric(metrics, "claude_code", "tokens_5h");
  const jobApps = findMetric(metrics, "jobs", "applications");
  const jobWeek = findMetric(metrics, "jobs", "applied_7d");
  const ghCommits = findMetric(metrics, "github", "commits_7d");
  const ghPrs = findMetric(metrics, "github", "open_prs");
  const ghIssues = findMetric(metrics, "github", "open_issues");
  const mp = state.morphy;

  // auto-calibrating cap: 100% = the biggest 5h window ever recorded —
  // no plan constant to maintain, tightens itself as heavy days land
  const tokenPeak = tokens
    ? Math.max(...tokens.history.map((h) => h.value), tokens.value)
    : null;

  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.1s" }}>
      <SectionTitle title="System Vitals" tick="VITALS.LINK" />
      {jobApps && (
        <div className={`vital ${fmtAge(jobApps.timestamp).stale ? "is-stale" : ""}`}>
          <VitalLabel m={jobApps} label="Job Applications" />
          <span className="value">
            <CountUp value={jobApps.value} raw />
          </span>
          <span className={`delta ${(jobWeek?.value ?? 0) > 0 ? "" : "zero"}`}>
            {(jobWeek?.value ?? 0) > 0 ? `▲ ${jobWeek!.value} this week` : "none this week"}
          </span>
          <div className="spark-row">
            <Sparkline points={jobApps.history.map((h) => h.value)} />
          </div>
        </div>
      )}
      {mp && mp.ok !== false && (
        <div className="vital">
          <span className="label">
            <i className="status-dot" />
            Morphy TODOs
            <span className={`age ${fmtAge(mp.last_sync_ts).stale ? "stale" : ""}`}>
              {fmtAge(mp.last_sync_ts).label}
            </span>
          </span>
          <span className="value">
            <CountUp value={mp.open_total ?? 0} raw />
          </span>
          <span className="delta">{mp.ideas_awaiting ?? 0} ideas</span>
        </div>
      )}
      {ghCommits && (
        <div className={`vital ${fmtAge(ghCommits.timestamp).stale ? "is-stale" : ""}`}>
          <VitalLabel m={ghCommits} label="Morphy Commits" />
          <span className="value">
            <CountUp value={ghCommits.value} raw />
            <span className="unit-pct"> /7d</span>
          </span>
          <span className={`delta ${(ghPrs?.value ?? 0) + (ghIssues?.value ?? 0) > 0 ? "" : "zero"}`}>
            {`${ghPrs?.value ?? 0} open PR${(ghPrs?.value ?? 0) === 1 ? "" : "s"} · ${ghIssues?.value ?? 0} issue${(ghIssues?.value ?? 0) === 1 ? "" : "s"}`}
          </span>
          <div className="spark-row">
            <Sparkline points={ghCommits.history.map((h) => h.value)} />
          </div>
        </div>
      )}
      {VITAL_DEFS.map((def) => {
        const m = findMetric(metrics, def.source, def.metric);
        if (!m) return null;
        const dw = m.deltaWeek;
        const deltaCls = !dw ? "zero" : dw < 0 ? "neg" : "";
        const age = fmtAge(m.timestamp);
        return (
          <div className={`vital ${age.stale ? "is-stale" : ""}`} key={`${def.source}:${def.metric}`}>
            <VitalLabel m={m} label={def.label} />
            <span className="value">
              <CountUp value={m.value} raw={def.raw} />
            </span>
            <span className={`delta ${deltaCls}`}>
              {dw === null ? "—" : dw === 0 ? "steady /wk" : `${dw > 0 ? "▲" : "▼"} ${fmt(Math.abs(dw))} /wk`}
            </span>
            {def.goal != null && (
              <div className="progress" title={`${m.value} → ${def.goal}`}>
                <div className="bar">
                  <i style={{ width: `${ratingProgress(m.value, def.goal, def.floor)}%` }} />
                </div>
                <span className="goal-tag">{def.goal}</span>
              </div>
            )}
            <div className="spark-row">
              <Sparkline points={m.history.map((h) => h.value)} />
            </div>
          </div>
        );
      })}

      {tokens && tokenPeak !== null && tokenPeak > 0 && (
        <div className={`vital ${fmtAge(tokens.timestamp).stale ? "is-stale" : ""}`}>
          <VitalLabel m={tokens} label="Claude 5h Window" />
          <span className="value">
            <CountUp value={(tokens.value / tokenPeak) * 100} full />
            <span className="unit-pct">%</span>
          </span>
          <span className="delta">
            {fmt(tokens.value)} of {fmt(tokenPeak)} peak
          </span>
          <div className="spark-row">
            <Sparkline points={tokens.history.map((h) => h.value)} />
          </div>
        </div>
      )}
    </section>
  );
});

// command deck — buttons drop REAL intents into system/queue/. Full roster:
// every skill the runner contract (lib/skills.ts ↔ runner.js) supports.
const DECK_SKILLS: { skill: string; label: string }[] = [
  { skill: "morning-report", label: "AM Report" },
  { skill: "inbox-brief", label: "Inbox Brief" },
  { skill: "plan-today", label: "Plan Today" },
  { skill: "plan-tomorrow", label: "Plan Tmrw" },
  { skill: "vault-cleanup", label: "Vault Clean" },
  { skill: "weekly-review", label: "Weekly Rev" },
  { skill: "morphy-sync", label: "Morphy Sync" },
];

// how long an optimistic "queued" mark survives before the real state must
// vouch for it — covers the gap until the next 5s poll reflects the queue write
const DECK_OPTIMISTIC_MS = 8000;

function CommandDeck({
  state,
  hot,
  onQueued,
}: {
  state: VaultState | null;
  hot?: boolean;
  onQueued: (skill: string, ok: boolean) => void;
}) {
  // ts a button was clicked — optimistic bridge until the polled state shows the
  // intent queued/running. Real derived state always wins over this.
  const [firedAt, setFiredAt] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);

  const runs = state?.runs ?? [];
  const queue = state?.queue ?? [];
  // live per-skill state from the runner's in-flight runs + pending queue. Reads
  // the SAME runs[] (status "running") the core's task callouts key on, so the
  // deck's RUNNING indicator and the orbiting task cards always agree.
  const derived = useMemo(
    () => deriveDeckState(DECK_SKILLS.map((d) => d.skill), runs, queue),
    [runs, queue]
  );

  const nowMs = Date.now();
  const phaseFor = (skill: string): DeckPhase => {
    const d = derived[skill];
    if (d?.phase === "running") return "running";
    if (d?.phase === "queued") return "queued";
    const f = firedAt[skill];
    if (f != null && nowMs - f < DECK_OPTIMISTIC_MS) return "queued"; // optimistic
    return "idle";
  };

  // a 1s heartbeat while anything is live, so the elapsed clock ticks and the
  // optimistic mark can age out between the 5s state polls
  const anyLive = DECK_SKILLS.some((d) => phaseFor(d.skill) !== "idle");
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyLive]);

  const fire = async (skill: string) => {
    if (phaseFor(skill) !== "idle") return; // already queued or running
    setFiredAt((f) => ({ ...f, [skill]: Date.now() }));
    try {
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill }),
      });
      onQueued(skill, res.ok);
      if (!res.ok) setFiredAt((f) => ({ ...f, [skill]: 0 })); // write failed → drop mark
    } catch {
      onQueued(skill, false);
      setFiredAt((f) => ({ ...f, [skill]: 0 }));
    }
  };

  const r = state?.runner;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle
        title="Command Deck"
        tick={r ? `${r.busy ? "ENGAGED" : "IDLE"} · ${r.active}/${r.max_concurrent} ACTIVE · ${r.pending} QUEUED` : "RUNNER OFFLINE"}
      />
      {state && state.queue.length > 0 && (
        <div className="queue-list">
          {state.queue.slice(0, 3).map((q) => (
            <span key={q.id}>▸ {q.label ?? q.skill}</span>
          ))}
          {state.queue.length > 3 && <span className="dim">+{state.queue.length - 3} more</span>}
        </div>
      )}
      <div className="deck">
        {DECK_SKILLS.map((d) => {
          const phase = phaseFor(d.skill);
          const running = phase === "running";
          const queued = phase === "queued";
          const startedAt = derived[d.skill]?.startedAt;
          const elapsed =
            running && startedAt
              ? Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000))
              : 0;
          return (
            <button
              key={d.skill}
              className={`deck-btn ${running ? "running" : queued ? "queued" : ""}`}
              onClick={() => fire(d.skill)}
              disabled={running || queued}
            >
              {running ? (
                <span className="deck-spinner" aria-hidden="true" />
              ) : (
                <span className="deck-dot" />
              )}
              <span className="deck-label">{queued ? "QUEUED" : d.label}</span>
              {running ? (
                <span className="deck-elapsed">{fmtClock(elapsed)}</span>
              ) : (
                <span className="deck-arrow">→</span>
              )}
            </button>
          );
        })}
      </div>
      <div className="deck-hint">intents write to system/queue — runner executes</div>
    </section>
  );
}

const METER_BARS = 37; // odd → a true center column for the VU peak

const AudioIO = memo(function AudioIO({ mode }: { mode: CoreMode }) {
  const live = mode === "speaking" || mode === "listening";
  const barsRef = useRef<(HTMLElement | null)[]>([]);

  // drive the bars from real amplitude: TTS playback level while speaking, mic
  // level while holding to talk; with neither live the level decays to 0 and the
  // meter rests at a flat idle floor. One rAF loop writes each bar's --h.
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const raw =
        mode === "speaking"
          ? voice.getLevel()
          : mode === "listening"
            ? voice.getMicLevel()
            : null;
      const target = raw ?? 0;
      // fast attack, soft release — punchy without strobing frame-to-frame
      smooth += (target - smooth) * (target > smooth ? 0.6 : 0.15);
      const heights = levelToBars(smooth, barsRef.current.length || METER_BARS);
      for (let i = 0; i < heights.length; i++) {
        barsRef.current[i]?.style.setProperty("--h", heights[i].toFixed(3));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const tick = mode === "speaking" ? "TTS.LIVE" : mode === "listening" ? "MIC.LIVE" : "TTS.STANDBY";
  return (
    <section className="block boot-stagger" style={{ animationDelay: "0.42s" }}>
      <SectionTitle title="Audio I/O" tick={tick} />
      <div className={`wave metered ${live ? "live" : "idle"} ${mode === "listening" ? "cobalt" : ""}`}>
        {Array.from({ length: METER_BARS }, (_, i) => (
          <i
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
            style={{ "--i": i } as React.CSSProperties}
          />
        ))}
      </div>
      <div className="audio-meta">
        <span>voice link · {live ? mode : "standby"}</span>
        <span>hold SPACE to talk · ESC to stop</span>
      </div>
    </section>
  );
});

const Priorities = memo(function Priorities({
  state,
  hot,
  onToggle,
}: {
  state: VaultState;
  hot?: boolean;
  onToggle: (index: number, done: boolean) => void;
}) {
  const d = state.daily;
  const ageDays = d && !d.isToday ? noteAgeDays(d.date) : 0;
  const veryStale = ageDays > 2;
  return (
    <section
      className={`block boot-stagger ${!d || d.isToday ? "" : "note-stale"} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.18s" }}
    >
      <SectionTitle title="Directives" tick="TOP.3" />
      {d ? (
        <>
          {!d.isToday && (
            <div className={`stale-banner ${veryStale ? "err" : ""}`}>
              ⚠ note is {ageDays}d old — run /today
            </div>
          )}
          {d.top3.map((p, i) => (
            <div
              className={`prio ${p.done ? "done" : ""} ${d.isToday ? "clickable" : ""}`}
              key={i}
              role={d.isToday ? "button" : undefined}
              title={d.isToday ? (p.done ? "mark open" : "mark done") : undefined}
              onClick={d.isToday ? () => onToggle(i, !p.done) : undefined}
            >
              <span className="box">{p.done ? "■" : "□"}</span>
              <span>{p.text}</span>
            </div>
          ))}
          <div className="prio-date">{d.isToday ? "today" : `carried · ${d.date}`}</div>
        </>
      ) : (
        <div className="prio dim">no daily note found</div>
      )}
    </section>
  );
});

// recent deliverables — every run that produced a document, newest first.
// The reveal chip is one-shot; this is the persistent trail.
const Documents = memo(function Documents({
  state,
  hot,
  onOpen,
}: {
  state: VaultState;
  hot?: boolean;
  onOpen: (path: string) => void;
}) {
  const docs: { path: string; skill: string; ts: string | null }[] = [];
  for (const r of state.runs) {
    if (r.status !== "ok" || !r.deliverable_path) continue;
    if (docs.some((d) => d.path === r.deliverable_path)) continue;
    docs.push({ path: r.deliverable_path, skill: r.label ?? r.skill, ts: r.ts_completed });
    if (docs.length >= 5) break;
  }
  if (docs.length === 0) return null;
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.26s" }}>
      <SectionTitle title="Documents" tick="INBOX.TRAIL" />
      {docs.map((doc) => (
        <div className="doc-row" key={doc.path} role="button" onClick={() => onOpen(doc.path)}>
          <span className="doc-skill">{doc.skill.replace(/-/g, " ")}</span>
          <span className="doc-age">{fmtAge(doc.ts).label}</span>
        </div>
      ))}
    </section>
  );
});

// Morphy — read-only glance at the shared Notion board (synced by the runner).
// Editing happens in Notion / by voice; this is the at-a-glance status only.
const Morphy = memo(function Morphy({ state, hot }: { state: VaultState; hot?: boolean }) {
  const mp = state.morphy;
  if (!mp) return null; // never synced — stay hidden until the first sync lands
  if (mp.ok === false) {
    return (
      <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.32s" }}>
        <SectionTitle title="Morphy" tick="BOARD · OFFLINE" />
        <div className="morphy-offline">board not syncing — {mp.reason ?? "no connection"}</div>
      </section>
    );
  }
  const ba = mp.open_by_assignee ?? {};
  const rows = (["Daniel", "Michael", "Both", "Unassigned"] as const).filter(
    (k) => k === "Daniel" || k === "Michael" || (ba[k] ?? 0) > 0
  );
  const added = mp.delta?.added?.length ?? 0;
  const closed = mp.delta?.closed?.length ?? 0;
  const lastAdded = mp.delta?.added?.[0];
  return (
    <section className={`block boot-stagger ${hot ? "voice-hot" : ""}`} style={{ animationDelay: "0.32s" }}>
      <SectionTitle title="Morphy" tick={`BOARD · ${fmtAge(mp.last_sync_ts).label} AGO`} />
      <div className="morphy-stats">
        <div className="morphy-stat">
          <span className="morphy-n">{mp.open_total ?? 0}</span>
          <span className="morphy-k">open</span>
        </div>
        <div className="morphy-stat">
          <span className="morphy-n">{mp.ideas_awaiting ?? 0}</span>
          <span className="morphy-k">ideas</span>
        </div>
      </div>
      <div className="morphy-rows">
        {rows.map((k) => (
          <div className="morphy-row" key={k}>
            <span>{k}</span>
            <span className="morphy-rn">{ba[k] ?? 0}</span>
          </div>
        ))}
      </div>
      {(added > 0 || closed > 0) && (
        <div className="morphy-delta">
          {added > 0 && <span className="morphy-up">+{added}</span>}
          {closed > 0 && <span className="morphy-down">−{closed}</span>}
          <span className="dim">
            {lastAdded ? `last: ${lastAdded.name.slice(0, 28)}` : "since last sync"}
          </span>
        </div>
      )}
    </section>
  );
});

// The headline campaign at the bottom center: the Morphy board. The big number
// is the open TODO count; the bar fills as cards close (done / total — an empty
// board is the win); the sub line splits ideas and who owns the open work.
// Reads the runner's cache only (state.morphy) — the HUD never calls Notion.
const MorphyObjective = memo(function MorphyObjective({
  state,
  hot,
}: {
  state: VaultState;
  hot?: boolean;
}) {
  const mp = state.morphy;
  const ok = !!mp && mp.ok !== false;
  const open = ok ? mp!.open_total ?? 0 : 0;
  const ideas = ok ? mp!.ideas_awaiting ?? 0 : 0;
  const total = ok ? mp!.total ?? 0 : 0;
  const done = ok ? mp!.counts?.done ?? 0 : 0;
  const tasks = ok ? mp!.tasks ?? [] : [];
  // per-assignee OPEN counts, computed with the SAME "open" definition as the
  // big number (todo + in progress + blocked) so the sub never exceeds it.
  // (mp.open_by_assignee counts non-done, which would fold the Ideas in.)
  const openFor = (who: string) =>
    tasks.filter(
      (t) =>
        ["todo", "in progress", "blocked"].includes((t.status || "").toLowerCase()) &&
        t.assignee === who
    ).length;
  const danielOpen = openFor("Daniel");
  const michaelOpen = openFor("Michael");
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <section
      className={`objective boot-stagger ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.58s" }}
    >
      <div className="obj-label">Morphy Board · Open TODOs</div>
      <div className="big">
        {ok ? <CountUp value={open} raw /> : "—"}
        <span className="unit">OPEN</span>
      </div>
      <div className="progress">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sub">
        <span>
          ideas <b>{ideas}</b>
        </span>
        <span>
          daniel <b>{danielOpen}</b>
        </span>
        <span>
          michael <b>{michaelOpen}</b>
        </span>
      </div>
    </section>
  );
});

// AI Wire — today's morning-report headlines, click → full report overlay
const Wire = memo(function Wire({
  state,
  onOpen,
}: {
  state: VaultState;
  onOpen: (path: string) => void;
}) {
  const m = state.morning;
  if (!m || m.heads.length === 0) return null;
  return (
    <section className="block boot-stagger" style={{ animationDelay: "0.5s" }}>
      <SectionTitle title="AI Wire" tick="MORNING.INTEL" />
      {/* top 3 only — the panel sits at the viewport's edge and more cuts off */}
      {m.heads.slice(0, 3).map((h, i) => (
        <div className="wire-row" key={i} role="button" onClick={() => onOpen(m.rel)}>
          <span className="wire-bullet">▸</span>
          <span>{h}</span>
        </div>
      ))}
    </section>
  );
});

function parseHHMM(t: string): number {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : -1;
}

const Schedule = memo(function Schedule({ state, hot }: { state: VaultState; hot?: boolean }) {
  const d = state.daily;
  const a = state.agenda;
  const now = useClock();
  // The agenda cache is "today's" only when its date matches the local day (the
  // same browser-local clock the highlight below uses). A stale or ok:false
  // cache is ignored, and we fall back to the daily-note ## Schedule.
  const todayLocal = now ? new Intl.DateTimeFormat("en-CA").format(now) : null;
  const useAgenda = !!(a && a.ok && a.events.length > 0 && todayLocal && a.date === todayLocal);

  const items0: { time: string; item: string }[] = useAgenda
    ? a!.events.map((e) => ({ time: e.time, item: e.item }))
    : d?.schedule ?? [];
  if (items0.length === 0) return null;

  const live = useAgenda || (d?.isToday ?? false);
  const nowMin = now && live ? now.getHours() * 60 + now.getMinutes() : -1;
  const items = items0.map((s) => ({ ...s, min: parseHHMM(s.time) }));
  // current block = latest item that has started
  let currentIdx = -1;
  if (nowMin >= 0) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].min >= 0 && items[i].min <= nowMin) currentIdx = i;
    }
  }
  const stale = !live;
  const ageDays = live ? 0 : d ? noteAgeDays(d.date) : 0;
  const tick = useAgenda ? "TODAY · CAL" : d?.isToday ? "TODAY" : `${ageDays}D OLD`;
  return (
    <section
      className={`block boot-stagger ${stale ? "note-stale" : ""} ${hot ? "voice-hot" : ""}`}
      style={{ animationDelay: "0.34s" }}
    >
      <SectionTitle
        title="Schedule"
        tick={tick}
        href="https://calendar.google.com/calendar/u/0/r/day"
      />
      <div className="sched">
        {items.map((s, i) => (
          <div
            key={`${s.time}-${i}`}
            className={`sched-row ${i === currentIdx ? "now" : ""} ${
              currentIdx >= 0 && i < currentIdx ? "past" : ""
            }`}
          >
            <span className="t">{s.time}</span>
            <span className="i">{s.item}</span>
            {i === currentIdx && <span className="now-tag">NOW</span>}
          </div>
        ))}
      </div>
      {d?.focus && <div className="focus-line">focus · {d.focus}</div>}
    </section>
  );
});

function TopBar({
  state,
  online,
  mode,
}: {
  state: VaultState | null;
  online: boolean;
  mode: CoreMode;
}) {
  const now = useClock();
  const r = state?.runner;
  return (
    <header className="topbar hud-top boot-stagger" style={{ animationDelay: "0.05s" }}>
      <div className="wordmark">
        <span className="name">H.E.L.M.</span>
        <span className="expansion">Heads-up Executive Logic Module</span>
      </div>
      <div className="status-line">
        <span className={`mode-chip mode-${mode}`}>
          <i className="status-dot" /> core · {mode}
        </span>
        <span className={`chip ${online ? "on" : "dead"}`}>
          {online ? "link · online" : "link · LOST"}
        </span>
        <span className={`chip ${r?.alive ? "on" : "dead"}`}>
          runner · {r?.alive ? "alive" : "down"}
        </span>
      </div>
      <div className="clock-wrap">
        <div className="clock" suppressHydrationWarning>
          {now
            ? `${String(now.getHours()).padStart(2, "0")}:${String(
                now.getMinutes()
              ).padStart(2, "0")}`
            : "--:--"}
          <span className="sec" suppressHydrationWarning>
            {now ? `:${String(now.getSeconds()).padStart(2, "0")}` : ""}
          </span>
        </div>
        <div className="clock-date" suppressHydrationWarning>
          {now
            ? `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()]} · ${
                ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][
                  now.getMonth()
                ]
              } ${now.getDate()}`
            : ""}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

const MODE_KEYS: Record<string, CoreMode> = {
  "1": "idle",
  "2": "working",
  "3": "listening",
  "4": "speaking",
  "5": "error",
};

export default function HUD() {
  const { state, error, refresh } = useVaultState(5000);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [modeOverride, setModeOverride] = useState<CoreMode | null>(null);
  const [bgMode, setBgMode] = useState<BgMode>("grid");
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [hotPanels, setHotPanels] = useState<string[]>([]);
  // monotonic tallies of the discrete events that flare the core — a run
  // finishing, a report landing, the Morphy board moving. deriveCore turns a
  // tally advancing into a one-shot pulse (see the flare effect below).
  const [events, setEvents] = useState({ runsDone: 0, reportsIn: 0, morphyMoves: 0 });
  const [flare, setFlare] = useState<CoreFlare | null>(null);
  // report reveal: callouts = cards branching off the core (max 4 anchor
  // slots around the orb — same hairline language). kind "doc" opens the
  // overlay, kind "link" opens the source in a new tab, kind "task" is a
  // live run (elapsed / ~eta progress) that morphs into its doc card on
  // completion — target stays `run:<id>` until the morph swaps it.
  const [callouts, setCallouts] = useState<
    {
      id: number;
      kind: "doc" | "link" | "task";
      target: string;
      label: string;
      slot: number;
      startedAt?: number;
      etaS?: number | null;
      phase?: "working" | "done" | "failed";
    }[]
  >([]);
  const calloutSeq = useRef(0);
  const addCallout = useCallback(
    (target: string, label: string, kind: "doc" | "link" = "doc") => {
      setCallouts((cur) => {
        if (cur.some((c) => c.target === target)) return cur; // already on screen
        const used = new Set(cur.map((c) => c.slot));
        const free = [0, 1, 2, 3].find((s) => !used.has(s));
        const entry = { id: ++calloutSeq.current, kind, target, label };
        // all four slots taken → oldest card yields its slot, but never a
        // live task (its run is still going — evicting it hides real work)
        if (free === undefined) {
          const victim = cur.find((c) => !(c.kind === "task" && c.phase === "working")) ?? cur[0];
          return [...cur.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
        }
        return [...cur, { ...entry, slot: free }];
      });
    },
    []
  );
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  const reportOpenRef = useRef(false);
  reportOpenRef.current = report !== null;
  const seenRunsRef = useRef<Set<string>>(new Set());
  const spokenRunsRef = useRef<Set<string>>(new Set());
  // flare bookkeeping: a per-event seq the renderer keys on, the previous signal
  // snapshot deriveCore diffs against, and the last-seen marks the report/Morphy
  // detectors prime from so a pre-existing report/delta doesn't flare on load.
  const flareSeqRef = useRef(0);
  const prevSignalsRef = useRef<CoreSignals | null>(null);
  const lastReportRef = useRef<string | null>(null);
  const lastMorphyRef = useRef<string | null>(null);

  const pushLine = useCallback((cls: string, text: string) => {
    setFeed((f) => [...f.slice(-30), { ts: nowHHMMSS(), cls, text }]);
  }, []);

  const openReport = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/report?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { path: string; content: string };
        setReport(j);
      } catch {
        pushLine("err", `couldn't open ${path}`);
      }
    },
    [pushLine]
  );

  // bottom-left TRANSCRIPT button — the voice conversation so far, rendered
  // in the same overlay as reports (memory.jsonl survives reloads, so this
  // shows exchanges from before the page opened too)
  const openTranscript = useCallback(async () => {
    try {
      const res = await fetch("/api/transcript", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setReport((await res.json()) as { path: string; content: string });
    } catch {
      pushLine("err", "couldn't load transcript");
    }
  }, [pushLine]);

  const toggleDirective = useCallback(
    async (index: number, done: boolean) => {
      try {
        const res = await fetch("/api/daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index, done }),
        });
        if (!res.ok) throw new Error(String(res.status));
        await refresh();
      } catch {
        pushLine("err", "directive update failed");
      }
    },
    [refresh, pushLine]
  );

  // ?demo=callouts — seed the doc callouts on demand (filming + layout checks)
  useEffect(() => {
    if (!window.location.search.includes("demo=callouts")) return;
    const seeds: [string, string][] = [
      ["inbox/reports/morning/demo-morning.md", "morning report"],
      ["inbox/voice/demo-voice-ask.md", "voice ask"],
      ["inbox/reports/trend-scan/demo-scan.md", "trend scan"],
      ["inbox/reports/inbox-briefs/demo-inbox.md", "inbox brief"],
    ];
    const timers = seeds.map(([p, l], i) => setTimeout(() => addCallout(p, l), 800 + i * 1400));
    return () => timers.forEach(clearTimeout);
  }, [addCallout]);

  // ?demo=taskwork — full task-callout lifecycle without queueing real runs:
  // two tasks spawn (one with eta, one indeterminate). First fills toward its
  // 10s median, runs OVERDUE at 10s (bar degrades to sweep), completes at 16s
  // and morphs into its doc card; the second fails at 22s
  useEffect(() => {
    if (!window.location.search.includes("demo=taskwork")) return;
    const seed = (label: string, etaS: number | null, slot: number) => ({
      id: ++calloutSeq.current,
      kind: "task" as const,
      target: `run:demo-${slot}`,
      label,
      startedAt: Date.now(),
      etaS,
      phase: "working" as const,
      slot,
    });
    const timers = [
      setTimeout(() => setCallouts((c) => [...c, seed("ai trend scan", 10, 0)]), 800),
      setTimeout(() => setCallouts((c) => [...c, seed("inbox brief", null, 1)]), 2600),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-0"
                ? {
                    ...c,
                    kind: "doc" as const,
                    target: "inbox/reports/trend-scan/demo-scan.md",
                    phase: undefined,
                  }
                : c
            )
          ),
        16000
      ),
      setTimeout(
        () =>
          setCallouts((cur) =>
            cur.map((c) =>
              c.target === "run:demo-1" ? { ...c, phase: "failed" as const } : c
            )
          ),
        22000
      ),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // voice link — P1: HELM speaks, no mic
  useEffect(() => {
    voice.init();
    voice.onLog(pushLine);
    voice.onPanels(setHotPanels);
    voice.onDeliverable((path, label) => addCallout(path, label));
    voice.onReveal((r) => addCallout(r.target, r.label, r.kind)); // sequenced to speech
    voice.onOpenDoc((path) => void openReport(path)); // "bring up the html" → overlay now
    voice.onListening(setWakeListening); // P4: hands-free wake window
    return voice.onSpeaking(setVoiceSpeaking);
  }, [pushLine, openReport, addCallout]);

  // P3 choreography — highlights arrive with the reply and live for the
  // duration of speech; the grace window covers the response→playback gap
  // (and ends the glow if TTS never starts)
  useEffect(() => {
    if (voiceSpeaking || hotPanels.length === 0) return;
    const id = setTimeout(() => setHotPanels([]), 2000);
    return () => clearTimeout(id);
  }, [voiceSpeaking, hotPanels]);

  // P2 — push-to-talk: hold Space to record, release to send
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      e.preventDefault();
      void voice.startCapture().then((ok) => {
        if (ok) setPtt(true);
      });
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      setPtt(false);
      void voice.finishCapture();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // demo mode keys: 1 idle / 2 working / 3 listening / 4 speaking / 5 error, 0|Esc auto
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key in MODE_KEYS) {
        setModeOverride(MODE_KEYS[e.key]);
        pushLine("sys", `core mode override → ${MODE_KEYS[e.key].toUpperCase()}`);
      } else if (e.key === "Escape") {
        // overlay open → Esc closes it and does nothing else
        if (reportOpenRef.current) {
          setReport(null);
          return;
        }
        if (voice.stop()) pushLine("sys", "voice — stopped");
        setModeOverride(null);
      } else if (e.key === "0") {
        setModeOverride(null);
        pushLine("sys", "core mode → AUTO");
      } else if (e.key === "b" || e.key === "B") {
        setBgMode((cur) => {
          const next = BG_MODES[(BG_MODES.indexOf(cur) + 1) % BG_MODES.length];
          pushLine("sys", `background → ${next.toUpperCase()}`);
          return next;
        });
      } else if (e.key === "f" || e.key === "F") {
        // fire a test flare (cycles run → report → morphy) for layout/filming
        const kind = (["run", "report", "morphy"] as const)[flareSeqRef.current % 3];
        setFlare({ kind, seq: ++flareSeqRef.current });
        pushLine("sys", `core flare → ${kind.toUpperCase()}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushLine]);

  // real runs flow into the feed
  useEffect(() => {
    if (!state) return;
    const fresh = state.runs.filter((r) => !seenRunsRef.current.has(r.id));
    if (fresh.length === 0) return;
    [...fresh].reverse().forEach((r) => {
      seenRunsRef.current.add(r.id);
      const cls = r.status === "ok" ? "ok" : r.status === "running" ? "sys" : "err";
      const dur = r.duration_s !== null ? ` · ${fmtDur(r.duration_s)}` : "";
      const text = `run/${r.label ?? r.skill} — ${r.summary || r.status}${dur}`;
      const ts = r.ts_completed
        ? new Date(r.ts_completed).toTimeString().slice(0, 8)
        : nowHHMMSS();
      setFeed((f) => [...f.slice(-30), { ts, cls, text }]);
    });
  }, [state]);

  // task callouts — active runs branch off the core like doc reveals: skill
  // name + elapsed / ~eta bar while the runner works. On completion the card
  // morphs IN PLACE into the deliverable card (same slot, no jump) — this
  // effect must stay ABOVE the speak-completions effect so the morph happens
  // before addCallout's target dedupe sees the deliverable path.
  useEffect(() => {
    if (!state) return;
    setCallouts((cur) => {
      let next = cur;
      for (const r of state.runs) {
        const existing = next.find((c) => c.kind === "task" && c.target === `run:${r.id}`);
        if (r.status === "running" && !existing) {
          const used = new Set(next.map((c) => c.slot));
          const free = [0, 1, 2, 3].find((s) => !used.has(s));
          const entry = {
            id: ++calloutSeq.current,
            kind: "task" as const,
            target: `run:${r.id}`,
            label: r.label ?? r.skill.replace(/-/g, " "),
            startedAt: r.ts_started ? Date.parse(r.ts_started) : Date.now(),
            etaS: state.etas[r.skill] ?? null,
            phase: "working" as const,
            slot: 0,
          };
          if (free === undefined) {
            // same eviction rule as addCallout: oldest non-working card yields
            const victim =
              next.find((c) => !(c.kind === "task" && c.phase === "working")) ?? next[0];
            next = [...next.filter((c) => c !== victim), { ...entry, slot: victim.slot }];
          } else {
            next = [...next, { ...entry, slot: free }];
          }
        } else if (existing && existing.phase === "working" && r.status !== "running") {
          next =
            r.status === "ok" && r.deliverable_path
              ? next.map((c) =>
                  c === existing
                    ? {
                        ...c,
                        kind: (r.link ? "link" : "doc") as "link" | "doc",
                        target: r.link ?? r.deliverable_path!,
                        phase: undefined,
                      }
                    : c
                )
              : next.map((c) =>
                  c === existing
                    ? { ...c, phase: r.status === "ok" ? ("done" as const) : ("failed" as const) }
                    : c
                );
        }
      }
      return next;
    });
  }, [state]);

  // ok-but-no-deliverable tasks flash COMPLETE, then clear themselves
  useEffect(() => {
    if (!callouts.some((c) => c.phase === "done")) return;
    const id = setTimeout(
      () => setCallouts((cur) => cur.filter((c) => c.phase !== "done")),
      6000
    );
    return () => clearTimeout(id);
  }, [callouts]);

  // 1s re-render while a task works — elapsed + bar width derive from Date.now()
  const taskWorking = callouts.some((c) => c.kind === "task" && c.phase === "working");
  const [, setTaskTick] = useState(0);
  useEffect(() => {
    if (!taskWorking) return;
    const id = setInterval(() => setTaskTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [taskWorking]);

  // speak completions — separate from the feed diff: a run can first appear
  // as "running" (id lands in seenRunsRef), so completion is tracked by id
  // here, only once it reaches a terminal status. First snapshot seeds
  // silently — no replaying history out loud on page load.
  const runsPrimedRef = useRef(false);
  useEffect(() => {
    if (!state) return;
    const done = state.runs.filter(
      (r) => (r.status === "ok" || r.status === "error") && !spokenRunsRef.current.has(r.id)
    );
    if (!runsPrimedRef.current) {
      runsPrimedRef.current = true;
      done.forEach((r) => spokenRunsRef.current.add(r.id));
      return;
    }
    done.forEach((r) => {
      spokenRunsRef.current.add(r.id);
      voice.speak(runAnnouncement(r.skill, r.status, r.summary ?? "", r.label));
      // finished run left a document → offer it via the reveal chip. When
      // the run's REAL output lives at a URL (Gmail draft, video), the
      // callout sends you THERE — the md stays in the Documents trail.
      if (r.status === "ok" && r.deliverable_path) {
        addCallout(
          r.link ?? r.deliverable_path,
          r.label ?? r.skill.replace(/-/g, " "),
          r.link ? "link" : "doc"
        );
      }
    });
    // each newly-terminal run flares the core (post-priming only)
    if (done.length) setEvents((e) => ({ ...e, runsDone: e.runsDone + done.length }));
  }, [state]);

  const onQueued = useCallback(
    (skill: string, ok: boolean) => {
      pushLine(ok ? "sys" : "err", ok ? `intent queued → ${skill}` : `queue write FAILED → ${skill}`);
    },
    [pushLine]
  );

  // report-landing: the morning report's path changes when a fresh one lands.
  // Prime on first sight (page may open with a report already present).
  useEffect(() => {
    const rel = state?.morning?.rel ?? "";
    if (lastReportRef.current === null) {
      lastReportRef.current = rel;
      return;
    }
    if (rel && rel !== lastReportRef.current) {
      lastReportRef.current = rel;
      setEvents((e) => ({ ...e, reportsIn: e.reportsIn + 1 }));
    }
  }, [state?.morning?.rel]);

  // Morphy delta: a sync that actually moved the board (added/closed > 0) gets a
  // fingerprint; an empty sync leaves the last real mark in place so it doesn't
  // false-fire when the delta clears.
  useEffect(() => {
    const d = state?.morphy?.delta;
    const moved = (d?.added?.length ?? 0) + (d?.closed?.length ?? 0);
    const mark = moved > 0 ? `${state?.morphy?.last_sync_ts ?? ""}:${moved}` : "";
    if (lastMorphyRef.current === null) {
      lastMorphyRef.current = mark;
      return;
    }
    if (mark && mark !== lastMorphyRef.current) {
      lastMorphyRef.current = mark;
      setEvents((e) => ({ ...e, morphyMoves: e.morphyMoves + 1 }));
    }
  }, [state?.morphy?.last_sync_ts]);

  // turn an advanced tally into a one-shot flare. deriveCore diffs this snapshot
  // against the previous one; mode booleans are irrelevant to the flare, so they
  // ride neutral here (mode itself is derived live below).
  useEffect(() => {
    const snap: CoreSignals = {
      error: false,
      listening: false,
      speaking: false,
      working: false,
      ...events,
    };
    const { flare: f } = deriveCore(snap, prevSignalsRef.current ?? undefined);
    prevSignalsRef.current = snap;
    if (f) setFlare({ kind: f, seq: ++flareSeqRef.current });
  }, [events]);

  // auto mode: fetch error → error; PTT held or wake window open → listening;
  // voice playing → speaking (orb mouths it, even mid-work); runner busy →
  // working; else idle. deriveCore owns the precedence (same order as before).
  const autoMode = deriveCore({
    error,
    listening: ptt || wakeListening,
    speaking: voiceSpeaking,
    working: !!state?.runner?.busy,
    runsDone: events.runsDone,
    reportsIn: events.reportsIn,
    morphyMoves: events.morphyMoves,
  }).mode;
  const mode = modeOverride ?? autoMode;

  return (
    <main className="stage">
      <GraphCore mode={mode} bgMode={bgMode} getLevel={voice.getLevel} flare={flare} />

      <div className="scrim scrim-l" aria-hidden="true" />
      <div className="scrim scrim-r" aria-hidden="true" />
      <div className="scrim scrim-b" aria-hidden="true" />
      <div className="scrim scrim-t" aria-hidden="true" />

      <div className="hud">
        <TopBar state={state} online={!error} mode={mode} />

        <div className="hud-left">
          {state && <Vitals state={state} hot={hotPanels.includes("vitals")} />}
          {state && (
            <Priorities
              state={state}
              hot={hotPanels.includes("priorities")}
              onToggle={toggleDirective}
            />
          )}
          {state && (
            <Documents state={state} hot={hotPanels.includes("documents")} onOpen={openReport} />
          )}
          {state && <Morphy state={state} hot={hotPanels.includes("morphy")} />}
        </div>

        <div className="hud-center">
          {callouts.map((c) => {
            const isTask = c.kind === "task";
            const elapsed =
              isTask && c.startedAt ? Math.max(0, Math.floor((Date.now() - c.startedAt) / 1000)) : 0;
            // ETA is silent: bar fills toward the median (capped at 95 — never
            // claim done before the run lands), and once elapsed passes it the
            // bar degrades to the indeterminate sweep instead of parking at a
            // number it promised. Text never states the estimate.
            const overdue = c.etaS != null && elapsed >= c.etaS;
            const pct = isTask && c.etaS && !overdue ? Math.min(95, (elapsed / c.etaS) * 100) : null;
            return (
              <div key={c.id} className={`callout slot-${c.slot}`}>
                <i className="br br-a" aria-hidden="true" />
                <i className="br br-b" aria-hidden="true" />
                <div
                  className={`callout-box${isTask ? ` task ${c.phase ?? ""}` : ""}`}
                  {...(!isTask && {
                    role: "button",
                    tabIndex: 0,
                    onClick: () =>
                      c.kind === "link"
                        ? window.open(c.target, "_blank", "noopener")
                        : void openReport(c.target),
                  })}
                >
                  <span className="callout-dot" />
                  <span className="callout-text">
                    <span className="callout-label">{c.label}</span>
                    {isTask ? (
                      <span className="task-meta">
                        <span className={`task-bar${pct === null && c.phase === "working" ? " indet" : ""}`}>
                          <i
                            style={
                              c.phase !== "working"
                                ? { width: "100%" }
                                : pct !== null
                                  ? { width: `${pct}%` }
                                  : undefined
                            }
                          />
                        </span>
                        <span className="task-time">
                          {c.phase === "working"
                            ? `${fmtClock(elapsed)} · working`
                            : c.phase === "failed"
                              ? `failed · ${fmtClock(elapsed)}`
                              : `complete · ${fmtClock(elapsed)}`}
                        </span>
                      </span>
                    ) : (
                      <span className="callout-file">
                        {c.kind === "link"
                          ? c.target.replace(/^https?:\/\/(www\.)?/, "").split("/")[0] + " ↗"
                          : c.target.split("/").pop()}
                      </span>
                    )}
                  </span>
                  <button
                    className="callout-x"
                    aria-label="dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCallouts((cur) => cur.filter((x) => x.id !== c.id));
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
          {callouts.length > 1 && (
            <button className="callout-clear" onClick={() => setCallouts([])}>
              clear all ×{callouts.length}
            </button>
          )}
        </div>

        <div className="hud-right">
          <CommandDeck
            state={state}
            hot={hotPanels.includes("pipeline") || hotPanels.includes("diagnostics")}
            onQueued={onQueued}
          />
          {state && <Schedule state={state} hot={hotPanels.includes("schedule")} />}
          <AudioIO mode={mode} />
          {state && <Wire state={state} onOpen={openReport} />}
        </div>

        <div className="hud-bottom">
          {state && (
            <MorphyObjective
              state={state}
              hot={hotPanels.includes("morphy") || hotPanels.includes("objective")}
            />
          )}
        </div>

        <button className="transcript-btn" onClick={() => void openTranscript()}>
          Transcript
        </button>
      </div>

      {report && (
        <ReportOverlay
          report={report}
          onClose={() => setReport(null)}
          action={
            report.path === "system/voice/transcript"
              ? {
                  label: "reset transcript ×",
                  onClick: () => {
                    void fetch("/api/transcript", { method: "DELETE" }).then(() => {
                      setReport(null);
                      pushLine("sys", "voice transcript cleared");
                    });
                  },
                }
              : undefined
          }
        />
      )}

      <div className="grain" aria-hidden="true" />
    </main>
  );
}
