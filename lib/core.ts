// Pure derivation for the HELM centerpiece (GraphCore). Kept free of React and
// three.js so a plain tsx test can exercise it. One snapshot in, two things out:
//
//   • mode  — the steady visual state, by fixed precedence:
//             error > listening > speaking > working > idle
//   • flare — a one-shot pulse the step a discrete event just landed
//             (a run finished, a report landed, the Morphy board moved)
//
// Flares are edge-detected: deriveCore compares the current snapshot to the
// previous one and emits at most one flare per step — the first time a tally
// advances. With no previous snapshot (the first call) nothing flares, so a
// freshly-loaded HUD doesn't replay history as a burst of pulses.

export type CoreMode = "idle" | "working" | "listening" | "speaking" | "error";

/** The discrete events that pulse the core. */
export type CoreEvent = "run" | "report" | "morphy";

export interface CoreSignals {
  // steady inputs → mode
  error: boolean;
  listening: boolean;
  speaking: boolean;
  working: boolean;
  // monotonic event tallies → flare. Each rises by ≥1 the step its event fires;
  // deriveCore flares on the rise, never on the held level.
  runsDone: number;
  reportsIn: number;
  morphyMoves: number;
}

export interface CoreState {
  mode: CoreMode;
  flare: CoreEvent | null;
}

/**
 * Project a signal snapshot onto the core's `{ mode, flare }`.
 *
 * `mode` is a pure function of the current booleans. `flare` needs `prev` to
 * spot the edge; when several tallies advance in the same step the most
 * arrival-like one wins — a finished run, then a landed report, then a board
 * move. A tally that holds or falls never flares.
 */
export function deriveCore(s: CoreSignals, prev?: CoreSignals): CoreState {
  const mode: CoreMode = s.error
    ? "error"
    : s.listening
      ? "listening"
      : s.speaking
        ? "speaking"
        : s.working
          ? "working"
          : "idle";

  let flare: CoreEvent | null = null;
  if (prev) {
    if (s.runsDone > prev.runsDone) flare = "run";
    else if (s.reportsIn > prev.reportsIn) flare = "report";
    else if (s.morphyMoves > prev.morphyMoves) flare = "morphy";
  }

  return { mode, flare };
}
