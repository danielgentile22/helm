"use client";

import dynamic from "next/dynamic";
import { useShell } from "@/components/shell/ShellContext";
import ErrorBoundary from "@/components/ErrorBoundary";

const GraphCore = dynamic(() => import("@/components/GraphCore"), { ssr: false });

// The reactor orb — Today's hero. A fixed background behind the tab content,
// recolored into Halo indigo/cyan (see GraphCore). Desktop only; the shell
// gates the mount so the three.js loop never runs on a phone. The boundary
// keeps a WebGL failure from taking the shell down with it — an orb crash
// degrades to an empty slot, like the phone layout.
export default function Orb() {
  const { mode, flare, bgMode, getLevel } = useShell();
  return (
    <div className="today-orb" aria-hidden="true">
      <ErrorBoundary>
        <GraphCore mode={mode} bgMode={bgMode} getLevel={getLevel} flare={flare} />
      </ErrorBoundary>
      <div className="orb-vignette" />
    </div>
  );
}
