// The only reader of wall time in the app, so the server skew correction cannot be
// bypassed. scripts/check-loops.mjs fails the build if Date.now() appears anywhere else,
// and holds the same line for the animation frame and the polls: the minute tick below,
// the snapshot poll, and the beat here, which runs only while a countdown holds it.

import { ms } from "./model/types";
import type { Ms } from "./model/types";

const TICK_MS = 30_000;
// Four beats a second keeps a countdown's whole seconds on time without a timer per tick.
const BEAT_MS = 250;

let minute = $state(0);
let skewMs = $state(0);
let beat = $state(0);
let holders = 0;
let beating: ReturnType<typeof setInterval> | null = null;

export function now(): Ms {
  return ms(Date.now() + skewMs);
}

export const clock = {
  get minute(): number {
    return minute;
  },
  get skewMs(): number {
    return skewMs;
  },
  /** A quarter-second tick, advancing only while something holds it. */
  get beat(): number {
    return beat;
  },
  now,
  noteServerDate(serverDate: Ms): void {
    skewMs = serverDate - Date.now();
  },
  /** Start the beat, or keep it going, until the returned release is called. The page idles
   *  on the minute tick alone once every holder has let go. */
  hold(): () => void {
    holders += 1;
    beating ??= setInterval(() => {
      beat += 1;
    }, BEAT_MS);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      holders -= 1;
      if (holders === 0 && beating !== null) {
        clearInterval(beating);
        beating = null;
      }
    };
  },
  start(): () => void {
    const timer = setInterval(() => {
      minute += 1;
    }, TICK_MS);
    // A hidden tab is throttled, so the tick on return is what stops the panels showing
    // a duration minutes out of date.
    const wake = (): void => {
      if (!document.hidden) minute += 1;
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  },
};
