"use client";

// ---------------------------------------------------------------------------
// PROTOTYPE — throwaway. Question: which centerpiece graphic should the HUD
// use? (#4). Shows EVERY graphic already implemented in the repo, switchable
// from a floating bottom bar. Delete when the decision is made — see
// app/proto-cores/NOTES.md.
//
//   PRODUCTION — GraphCore / DitherCore / EmberCore side by side, all live
//                (keys 1–5 drive all three through their modes)
//   CORE LAB   — the 10 three.js candidates (reuses /lab)
//   ORB LAB    — the 10 dither behaviors (reuses /orb)
//
// Only one board mounts at a time, so WebGL contexts stay well under the
// browser cap (3 separate renderers on PRODUCTION; 1 shared canvas per lab).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { CoreMode } from "@/components/GraphCore";
import ErrorBoundary from "@/components/ErrorBoundary";

const GraphCore = dynamic(() => import("@/components/GraphCore"), { ssr: false });
const DitherCore = dynamic(() => import("@/components/DitherCore"), { ssr: false });
const EmberCore = dynamic(() => import("@/components/EmberCore"), { ssr: false });
const CoreLab = dynamic(() => import("@/components/CoreLab"), { ssr: false });
const OrbLab = dynamic(() => import("@/components/OrbLab"), { ssr: false });

const BOARDS = ["production", "corelab", "orblab"] as const;
type Board = (typeof BOARDS)[number];

const BOARD_LABEL: Record<Board, string> = {
  production: "PRODUCTION CORES · GraphCore · DitherCore · EmberCore",
  corelab: "CORE LAB · 10 three.js candidates",
  orblab: "ORB LAB · 10 dither behaviors",
};

const MODES: CoreMode[] = ["idle", "working", "listening", "speaking", "error"];

function ProductionBoard({ mode, setMode }: { mode: CoreMode; setMode: (m: CoreMode) => void }) {
  return (
    <div className="pg-prod">
      <div className="pg-prod-head">
        <h1>PRODUCTION CORES</h1>
        <p>the three real centerpiece candidates · all live · this is the #4 decision</p>
        <div className="pg-modes">
          {MODES.map((m) => (
            <button key={m} className={m === mode ? "on" : ""} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="pg-grid">
        <div className="pg-tile">
          <ErrorBoundary>
            <GraphCore mode={mode} bgMode="depth" />
          </ErrorBoundary>
          <div className="pg-tile-label">
            <b>GRAPHCORE</b>
            <span>node cloud · on the HUD now</span>
          </div>
        </div>
        <div className="pg-tile">
          <ErrorBoundary>
            <DitherCore mode={mode} />
          </ErrorBoundary>
          <div className="pg-tile-label">
            <b>DITHERCORE</b>
            <span>dither sphere · currently orphaned</span>
          </div>
        </div>
        <div className="pg-tile">
          <ErrorBoundary>
            <EmberCore mode={mode} />
          </ErrorBoundary>
          <div className="pg-tile-label">
            <b>EMBERCORE</b>
            <span>4-layer reactor · currently orphaned</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function CoreGalleryPrototype() {
  const [board, setBoard] = useState<Board>("production");
  const [mode, setMode] = useState<CoreMode>("idle");

  // hydrate board from ?board= so it's reload-stable and shareable
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("board");
    if (p && (BOARDS as readonly string[]).includes(p)) setBoard(p as Board);
  }, []);

  const go = useCallback((b: Board) => {
    setBoard(b);
    const u = new URL(window.location.href);
    u.searchParams.set("board", b);
    window.history.replaceState(null, "", u);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const i = BOARDS.indexOf(board);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(BOARDS[(i + 1) % BOARDS.length]);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(BOARDS[(i + BOARDS.length - 1) % BOARDS.length]);
      } else if (board === "production" && /^[1-5]$/.test(e.key)) {
        setMode(MODES[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board, go]);

  const idx = BOARDS.indexOf(board);

  return (
    <main className="pg-root">
      <style>{PG_CSS}</style>

      {board === "production" && <ProductionBoard mode={mode} setMode={setMode} />}
      {board === "corelab" && (
        <ErrorBoundary>
          <CoreLab />
        </ErrorBoundary>
      )}
      {board === "orblab" && (
        <ErrorBoundary>
          <OrbLab />
        </ErrorBoundary>
      )}

      {/* switcher is dev-only — a stray prototype merge can't ship the bar */}
      {process.env.NODE_ENV !== "production" && (
        <>
          <div className="pg-hint">
            ← → switch boards
            {board === "production"
              ? " · keys 1–5 set mode"
              : " · click a tile to isolate · esc to return"}
          </div>
          <div className="pg-bar">
            <button
              aria-label="previous board"
              onClick={() => go(BOARDS[(idx + BOARDS.length - 1) % BOARDS.length])}
            >
              ◄
            </button>
            <span className="pg-bar-label">
              <span className="pg-bar-idx">{idx + 1}/3</span> · {BOARD_LABEL[board]}
            </span>
            <button
              aria-label="next board"
              onClick={() => go(BOARDS[(idx + 1) % BOARDS.length])}
            >
              ►
            </button>
          </div>
        </>
      )}
    </main>
  );
}

const PG_CSS = `
.pg-root {
  position: fixed;
  inset: 0;
  background: #0b0807;
  color: #e8e2da;
  font-family: var(--font-mono, ui-monospace, monospace);
  overflow: hidden;
}
.pg-prod { position: absolute; inset: 0; display: flex; flex-direction: column; }
.pg-prod-head { padding: 14px 22px 6px; z-index: 5; }
.pg-prod-head h1 {
  font-family: var(--font-display, sans-serif);
  font-size: 20px; letter-spacing: 0.28em; font-weight: 600;
  color: #ffe3bd; margin: 0;
}
.pg-prod-head p {
  font-size: 9px; letter-spacing: 0.2em; text-transform: uppercase;
  color: #9a8f84; margin: 5px 0 0;
}
.pg-modes { display: flex; gap: 6px; margin-top: 10px; }
.pg-modes button {
  font: inherit; font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
  padding: 5px 11px; background: transparent; border: 1px solid #3a332c;
  color: #9a8f84; cursor: pointer; transition: border-color 0.15s, color 0.15s;
}
.pg-modes button:hover { border-color: #6f655c; color: #cfc6bb; }
.pg-modes button.on { border-color: #d97757; color: #ffe3bd; }
.pg-grid {
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
  padding: 6px 16px 64px;
}
.pg-tile {
  position: relative; overflow: hidden;
  border: 1px solid #2a2520; background: #0a0909;
}
/* DitherCore is normally sized to the viewport + centered; pin it square
   inside the tile so the orb isn't stretched in this comparison view */
.pg-tile .dither-core {
  position: absolute !important;
  top: 50% !important; left: 50% !important;
  transform: translate(-50%, -50%) !important;
  height: 86% !important; width: auto !important; aspect-ratio: 1 !important;
}
.pg-tile-label {
  position: absolute; left: 12px; bottom: 10px; z-index: 6; pointer-events: none;
  display: flex; flex-direction: column; gap: 2px; text-shadow: 0 1px 8px #000;
}
.pg-tile-label b {
  font-family: var(--font-display, sans-serif);
  font-size: 13px; letter-spacing: 0.18em; color: #ffe3bd;
}
.pg-tile-label span {
  font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase; color: #b7ada2;
}
.pg-bar {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 50;
  display: flex; align-items: center; gap: 14px; padding: 8px 14px;
  background: #15110d; border: 1px solid #d97757; border-radius: 999px;
  box-shadow: 0 6px 26px rgba(0, 0, 0, 0.65);
}
.pg-bar button {
  font: inherit; background: transparent; border: none; color: #ffe3bd;
  font-size: 15px; line-height: 1; cursor: pointer; padding: 2px 8px;
}
.pg-bar button:hover { color: #d97757; }
.pg-bar-label { font-size: 10px; letter-spacing: 0.14em; color: #e8e2da; white-space: nowrap; }
.pg-bar-idx { color: #d97757; font-weight: 600; }
.pg-hint {
  position: fixed; left: 50%; bottom: 54px; transform: translateX(-50%); z-index: 50;
  font-size: 8px; letter-spacing: 0.16em; text-transform: uppercase;
  color: #6f655c; white-space: nowrap; pointer-events: none;
}
`;
