"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { voice } from "@/lib/voiceClient";
import { helmKey } from "@/lib/helmKey";
import { scrubRunSummary, humanizeFailure } from "@/lib/spokenText";
import { deriveCore, type CoreSignals, type CoreMode } from "@/lib/core";
import { deriveStatus } from "@/lib/status";
import { deriveCallouts, mergeToasts, runsNeedingFeedLine, type CalloutSnapshot } from "@/lib/callouts";
import { BG_MODES, type BgMode, type CoreFlare } from "@/components/GraphCore";
import ReportOverlay from "@/components/ReportOverlay";
import type { VaultState } from "@/lib/vault";
import { ShellContext, type ShellValue, type FeedLine } from "./ShellContext";
import TabNav from "./TabNav";
import Toasts, { type LiveToast } from "./Toasts";

// ---------------------------------------------------------------------------
// helpers (ported from the old monolithic HUD)
// ---------------------------------------------------------------------------

const PHONE_MQ = "(max-width: 768px)";

// Live check for effects — accurate on first run (effects run after mount), so
// voice.init()/PTT never fire on a phone. The useIsPhone state below is for
// rendering and defaults desktop to match the SSR prerender.
function isPhoneNow() {
  return typeof window !== "undefined" && window.matchMedia(PHONE_MQ).matches;
}

// Tri-state: null until the media query resolves post-hydration. SSR/first
// paint renders the lightweight desktop chrome (matching the prerender), but
// heavy desktop-only subtrees gate on `isPhone === false` so a phone load
// never mounts them — mounting the Orb even for one tick fires the whole
// three.js chunk download.
function useIsPhone(): boolean | null {
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

function useVaultState(intervalMs = 5000) {
  const [state, setState] = useState<VaultState | null>(null);
  const [error, setError] = useState(false);
  // out-of-order guard — a poll that stalls past the next tick must not land
  // late and step state backwards (edge-detected toasts/speech assume
  // monotonic snapshots)
  const seqRef = useRef(0);
  const pull = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as VaultState;
      if (seq !== seqRef.current) return; // a newer poll already resolved
      setState(next);
      setError(false);
    } catch {
      if (seq === seqRef.current) setError(true);
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

function nowHHMMSS(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, "0")).join(":");
}

function fmtDur(s: number): string {
  if (s < 100) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

// spoken line for a finished run — short, no markdown, summary clamped
function runAnnouncement(skill: string, status: string, summary: string, label?: string | null): string {
  const name = label ? `${label} ask` : skill.replace(/-/g, " ");
  if (status !== "ok") {
    const why = summary ? humanizeFailure(summary) : "";
    return `${name} hit a snag${why ? ` — ${why.slice(0, 120)}` : "."}`;
  }
  const clean = scrubRunSummary(summary);
  if (skill === "voice-ask" && clean) return clean.slice(0, 220);
  const redundant = /^(done|complete|completed|finished|all done|ok)[.!]?$/i.test(clean);
  return `${name} is done.${clean && !redundant ? ` ${clean.slice(0, 160)}` : ""}`;
}

// ---------------------------------------------------------------------------
// shell chrome pieces
// ---------------------------------------------------------------------------

const MODE_LABEL: Record<CoreMode, string> = {
  idle: "idle",
  working: "working",
  listening: "listening",
  speaking: "speaking",
  error: "error",
};

function VoiceChip({ mode }: { mode: CoreMode }) {
  return (
    <span className={`voice-chip mode-${mode}`} title="hold Space to talk">
      <i className="voice-chip-dot" />
      voice · {MODE_LABEL[mode]}
    </span>
  );
}

function HealthDot({ healthy, needMe, runner }: { healthy: boolean; needMe: number; runner: string }) {
  const tone = !healthy ? "danger" : needMe > 0 ? "warning" : "success";
  const title = !healthy
    ? `system needs attention · runner ${runner}`
    : needMe > 0
      ? `${needMe} thing${needMe === 1 ? "" : "s"} need you`
      : "all systems nominal";
  return (
    <span className={`health-dot tone-${tone}`} title={title} aria-label={title}>
      <i />
      {needMe > 0 && <span className="health-count">{needMe}</span>}
    </span>
  );
}

function Clock() {
  const now = useClock();
  return (
    <div className="shell-clock" suppressHydrationWarning>
      <span className="clock-time">
        {now ? `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` : "--:--"}
      </span>
      <span className="clock-date">
        {now
          ? `${["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][now.getDay()]} ${
              ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][now.getMonth()]
            } ${now.getDate()}`
          : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell — the persistent client shell. Rendered once inside the root layout;
// App Router layouts don't remount on navigation, so the vault poll + voice
// init exactly once and every tab reads shared state from context.
// ---------------------------------------------------------------------------

export default function Shell({ children }: { children: React.ReactNode }) {
  const { state, error, refresh } = useVaultState(5000);
  const isPhone = useIsPhone();
  const status = deriveStatus(
    state ?? { generated_at: "", vault_root: "", tz: "", metrics: [], runner: null, daily: null, runs: [], queue: [], morning: null, morphy: null, agenda: null, etas: {} }
  );

  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  // "depth" = a calm radial glow behind the orb (no perspective floor grid),
  // the quietest of the orb backgrounds — closest to Halo's still substrate.
  const [bgMode] = useState<BgMode>(BG_MODES.includes("depth") ? "depth" : BG_MODES[0]);
  const [events, setEvents] = useState({ runsDone: 0, reportsIn: 0, morphyMoves: 0 });
  const [flare, setFlare] = useState<CoreFlare | null>(null);
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  const [toasts, setToasts] = useState<LiveToast[]>([]);

  const reportOpenRef = useRef(false);
  reportOpenRef.current = report !== null;
  const flareSeqRef = useRef(0);
  const prevSignalsRef = useRef<CoreSignals | null>(null);
  const lastReportRef = useRef<string | null>(null);
  const lastMorphyRef = useRef<string | null>(null);
  const spokenRunsRef = useRef<Set<string>>(new Set());
  const runsPrimedRef = useRef(false);
  const prevSnapRef = useRef<CalloutSnapshot | null>(null);

  const pushLine = useCallback((cls: string, text: string) => {
    setFeed((f) => [...f.slice(-30), { ts: nowHHMMSS(), cls, text }]);
  }, []);

  const openReport = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(`/api/report?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(String(res.status));
        setReport((await res.json()) as { path: string; content: string });
      } catch {
        pushLine("err", `couldn't open ${path}`);
      }
    },
    [pushLine]
  );

  const openTranscript = useCallback(async () => {
    try {
      const res = await fetch("/api/transcript", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setReport((await res.json()) as { path: string; content: string });
    } catch {
      pushLine("err", "couldn't load transcript");
    }
  }, [pushLine]);

  const queueSkill = useCallback(
    async (skill: string, args: Record<string, unknown> = {}) => {
      try {
        const res = await fetch("/api/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-HELM-KEY": await helmKey() },
          body: JSON.stringify({ skill, args }),
        });
        pushLine(res.ok ? "sys" : "err", res.ok ? `intent queued → ${skill}` : `queue write FAILED → ${skill}`);
        return res.ok;
      } catch {
        pushLine("err", `queue write FAILED → ${skill}`);
        return false;
      }
    },
    [pushLine]
  );

  // voice link — desktop only (no voice server / mic / PTT on phone)
  useEffect(() => {
    if (isPhoneNow()) return;
    voice.init();
    voice.onLog(pushLine);
    voice.onOpenDoc((path) => void openReport(path));
    voice.onListening(setWakeListening);
    return voice.onSpeaking(setVoiceSpeaking);
  }, [pushLine, openReport]);

  // push-to-talk — hold Space (desktop only)
  useEffect(() => {
    if (isPhoneNow()) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      // typing or activating a control, not talking — Space must keep its
      // native meaning on every focusable form control, not just text fields
      if (t && (t.closest("input,textarea,select,button") || t.isContentEditable)) return;
      e.preventDefault();
      void voice.startCapture().then((ok) => ok && setPtt(true));
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setPtt(false);
      void voice.finishCapture();
    };
    // a keyup lost to Cmd+Tab/Spotlight/a dialog must not leave the mic hot
    const cancel = () => {
      setPtt(false);
      voice.cancelCapture();
    };
    const onVis = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // Escape — close an open overlay, else stop voice
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (reportOpenRef.current) {
        setReport(null);
        return;
      }
      if (voice.stop()) pushLine("sys", "voice — stopped");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pushLine]);

  // real runs flow into the feed — first sight ("running") AND the terminal
  // transition, so outcomes/failures land in the persistent log, not just the
  // 7s toast
  const seenRunsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!state) return;
    const fresh = runsNeedingFeedLine(seenRunsRef.current, state.runs);
    if (fresh.length === 0) return;
    [...fresh].reverse().forEach((r) => {
      seenRunsRef.current.set(r.id, r.status);
      const cls = r.status === "ok" ? "ok" : r.status === "running" ? "sys" : "err";
      const dur = r.duration_s !== null ? ` · ${fmtDur(r.duration_s)}` : "";
      const text = `run/${r.label ?? r.skill} — ${r.summary || r.status}${dur}`;
      const ts = r.ts_completed ? new Date(r.ts_completed).toTimeString().slice(0, 8) : nowHHMMSS();
      setFeed((f) => [...f.slice(-30), { ts, cls, text }]);
    });
  }, [state]);

  // speak completions + flare on newly-terminal runs (primed silently on first poll)
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
    });
    if (done.length) setEvents((e) => ({ ...e, runsDone: e.runsDone + done.length }));
  }, [state]);

  // cross-tab toasts — derived from run/queue/report deltas each poll
  useEffect(() => {
    if (!state) return;
    const cur: CalloutSnapshot = {
      runs: state.runs.map((r) => ({
        id: r.id,
        skill: r.skill,
        label: r.label,
        status: r.status,
        deliverable_path: r.deliverable_path,
        link: r.link,
      })),
      reportRel: state.morning?.rel ?? null,
    };
    const fresh = deriveCallouts(prevSnapRef.current, cur);
    prevSnapRef.current = cur;
    if (fresh.length === 0) return;
    setToasts((cur) => mergeToasts(cur, fresh.map((t) => ({ ...t, exp: Date.now() + 7000 }))));
  }, [state]);

  // prune expired toasts
  useEffect(() => {
    if (toasts.length === 0) return;
    const id = setInterval(() => setToasts((t) => t.filter((x) => x.exp > Date.now())), 1000);
    return () => clearInterval(id);
  }, [toasts.length]);

  // report-landing flare
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

  // Morphy-move flare
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

  // advanced tally → one-shot flare (deriveCore edge-detects)
  useEffect(() => {
    const snap: CoreSignals = { error: false, listening: false, speaking: false, working: false, ...events };
    const { flare: f } = deriveCore(snap, prevSignalsRef.current ?? undefined);
    prevSignalsRef.current = snap;
    if (f) setFlare({ kind: f, seq: ++flareSeqRef.current });
  }, [events]);

  const mode = deriveCore({
    error,
    listening: ptt || wakeListening,
    speaking: voiceSpeaking,
    working: !!state?.runner?.busy,
    runsDone: events.runsDone,
    reportsIn: events.reportsIn,
    morphyMoves: events.morphyMoves,
  }).mode;

  const value: ShellValue = {
    state,
    error,
    refresh,
    status,
    isPhone,
    mode,
    flare,
    bgMode,
    voiceSpeaking,
    getLevel: voice.getLevel,
    feed,
    openReport,
    openTranscript,
    queueSkill,
  };

  return (
    <ShellContext.Provider value={value}>
      <div className={`shell ${voiceSpeaking ? "voice-hot" : ""}`}>
        <header className="shell-top">
          <Link className="shell-brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">H.E.L.M.</span>
          </Link>
          {!isPhone && <TabNav variant="pill" />}
          <div className="shell-status">
            {!isPhone && <VoiceChip mode={mode} />}
            <HealthDot healthy={status.healthy} needMe={status.needMeCount} runner={status.runner} />
            <Clock />
          </div>
        </header>

        <main className="shell-main">{children}</main>

        {isPhone && <TabNav variant="bottom" />}

        <Toasts
          toasts={toasts}
          onOpen={(t) =>
            t.target
              ? t.target.startsWith("http")
                ? window.open(t.target, "_blank", "noopener")
                : void openReport(t.target)
              : undefined
          }
          onDismiss={(id) => setToasts((cur) => cur.filter((x) => x.id !== id))}
        />
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
                    void helmKey()
                      .then((k) => fetch("/api/transcript", { method: "DELETE", headers: { "X-HELM-KEY": k } }))
                      .then((res) => {
                        if (!res.ok) throw new Error(String(res.status));
                        setReport(null);
                        pushLine("sys", "voice transcript cleared");
                      })
                      .catch(() => pushLine("err", "transcript reset FAILED"));
                  },
                }
              : undefined
          }
        />
      )}
    </ShellContext.Provider>
  );
}
