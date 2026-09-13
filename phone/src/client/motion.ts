/**
 * The duration tokens, read once, for the motion CSS cannot express: Svelte
 * transitions and the FLIP animation. Reduced motion resolves to 0 rather than
 * the 1ms the tokens collapse to, so a transition ends on its first frame.
 */
import { cubicOut } from "svelte/easing";
import type { FlyParams, TransitionConfig } from "svelte/transition";

export interface Motion {
  readonly reduced: boolean;
  readonly swift: number;
  readonly base: number;
  readonly enter: number;
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function token(name: string, fallback: number): number {
  if (reduced) return 0;
  const ms = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

export const motion: Motion = {
  reduced,
  swift: token("--d-swift", 110),
  base: token("--d-base", 200),
  enter: token("--d-enter", 320),
};

/** In only: two screens stacked during an outro would push the layout and jump the scroll. */
export const screenIn: FlyParams = { y: 8, opacity: 0, duration: motion.enter, easing: cubicOut };

const slideUp = (duration: number) => (): TransitionConfig => ({
  duration,
  easing: cubicOut,
  css: (t) => `transform: translateY(${(1 - t) * 100}%)`,
});

export const sheetIn = slideUp(motion.enter);
export const sheetOut = slideUp(motion.base);
