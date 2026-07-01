"use client";

import { useEffect, useRef } from "react";
import { voice } from "@/lib/voiceClient";
import { levelToBars } from "@/lib/audio";
import { useShell } from "@/components/shell/ShellContext";
import { SectionTitle } from "./util";

const METER_BARS = 37; // odd → a true center column for the VU peak

// VU meter driven by real amplitude — TTS playback while speaking, mic while
// holding to talk; rests at a flat idle floor otherwise.
export default function AudioMeter() {
  const { mode } = useShell();
  const live = mode === "speaking" || mode === "listening";
  const barsRef = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const raw = mode === "speaking" ? voice.getLevel() : mode === "listening" ? voice.getMicLevel() : null;
      const target = raw ?? 0;
      smooth += (target - smooth) * (target > smooth ? 0.6 : 0.15);
      const heights = levelToBars(smooth, barsRef.current.length || METER_BARS);
      for (let i = 0; i < heights.length; i++) barsRef.current[i]?.style.setProperty("--h", heights[i].toFixed(3));
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  const tick = mode === "speaking" ? "TTS.LIVE" : mode === "listening" ? "MIC.LIVE" : "TTS.STANDBY";
  return (
    <section className="panel">
      <SectionTitle title="Audio I/O" tick={tick} />
      <div className={`wave metered ${live ? "live" : "idle"} ${mode === "listening" ? "cobalt" : ""}`}>
        {Array.from({ length: METER_BARS }, (_, i) => (
          <i
            key={i}
            ref={(el) => {
              barsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      <div className="audio-meta">
        <span>voice link · {live ? mode : "standby"}</span>
        <span>hold SPACE · ESC to stop</span>
      </div>
    </section>
  );
}
