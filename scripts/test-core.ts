// Core derivation sweep — deriveCore(signals, prev?) projects a signal snapshot
// onto { mode, flare }. Mode is fixed-precedence (error > listening > speaking >
// working > idle); flare is a one-shot edge on a tally advancing. Pure, no DOM.
// Run: npx -y tsx scripts/test-core.ts
import { deriveCore, type CoreSignals } from "../lib/core";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));

// a calm baseline: nothing active, all tallies at rest
const REST: CoreSignals = {
  error: false,
  listening: false,
  speaking: false,
  working: false,
  runsDone: 0,
  reportsIn: 0,
  morphyMoves: 0,
};
const sig = (o: Partial<CoreSignals>): CoreSignals => ({ ...REST, ...o });
const mode = (o: Partial<CoreSignals>) => deriveCore(sig(o)).mode;

// --- mode: each state in isolation -----------------------------------------
check(mode({}) === "idle", "nothing active → idle");
check(mode({ working: true }) === "working", "runner busy → working");
check(mode({ speaking: true }) === "speaking", "voice playing → speaking");
check(mode({ listening: true }) === "listening", "mic open → listening");
check(mode({ error: true }) === "error", "fetch error → error");

// --- mode: precedence (error > listening > speaking > working > idle) -------
check(
  mode({ error: true, listening: true, speaking: true, working: true }) === "error",
  "error outranks everything"
);
check(
  mode({ listening: true, speaking: true, working: true }) === "listening",
  "listening outranks speaking + working"
);
check(mode({ speaking: true, working: true }) === "speaking", "speaking outranks working");
check(mode({ working: true }) === "working", "working outranks idle");

// --- flare: priming (no prev) ----------------------------------------------
check(deriveCore(sig({ runsDone: 3 })).flare === null, "no prev snapshot → no flare (priming)");

// --- flare: one-shot on each channel ---------------------------------------
check(deriveCore(sig({ runsDone: 1 }), REST).flare === "run", "runsDone advances → run flare");
check(deriveCore(sig({ reportsIn: 1 }), REST).flare === "report", "reportsIn advances → report flare");
check(deriveCore(sig({ morphyMoves: 1 }), REST).flare === "morphy", "morphyMoves advances → morphy flare");

// --- flare: it's a ONE-shot — the held level doesn't keep firing ------------
const after = sig({ runsDone: 1 });
check(deriveCore(after, after).flare === null, "same snapshot twice → flare settles (one-shot)");
check(deriveCore(sig({ runsDone: 5 }), sig({ runsDone: 5 })).flare === null, "tally held high → no flare");

// --- flare: only a RISE flares; a flat or falling tally stays quiet ---------
check(deriveCore(sig({ runsDone: 2 }), sig({ runsDone: 4 })).flare === null, "tally falling → no flare");

// --- flare: precedence when several advance in one step --------------------
check(
  deriveCore(sig({ runsDone: 1, reportsIn: 1, morphyMoves: 1 }), REST).flare === "run",
  "run wins over report + morphy"
);
check(
  deriveCore(sig({ reportsIn: 1, morphyMoves: 1 }), REST).flare === "report",
  "report wins over morphy"
);

// --- flare is independent of mode — a mode flip alone never flares ----------
check(
  deriveCore(sig({ error: true }), REST).flare === null,
  "mode change with tallies flat → no flare"
);

// --- summary ----------------------------------------------------------------
console.log(failed === 0 ? `\nAll core checks pass.` : `\n${failed} core check(s) failed.`);
process.exit(failed ? 1 : 0);
