"use client";

import { useEffect } from "react";

// Route-segment error boundary — a crash inside a tab page degrades to this
// panel instead of Next's bare "Application error" white screen. The shell
// chrome (voice loop, vault poll, clock) lives in the root layout above this
// boundary and keeps running. Auto-retries once after 8s for the
// unattended-display case; a persistent fault just shows the panel again.
export default function TabError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error("tab crashed", error);
    const id = setTimeout(reset, 8000);
    return () => clearTimeout(id);
  }, [error, reset]);

  return (
    <div className="core-fault" role="alert">
      <p className="core-fault-title">core fault</p>
      <p className="core-fault-detail">{error.message || "something threw during render"}</p>
      <button className="btn btn-secondary" onClick={reset}>
        reset
      </button>
    </div>
  );
}
