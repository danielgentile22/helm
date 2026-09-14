/**
 * Svelte actions for the two gestures every transcript block shares: a long
 * press (or a right click) that opens a block's actions sheet, and an in-app
 * link that the router takes over on a plain left click only, so a modifier
 * or middle click still opens a new tab.
 */

import { router } from "./route.svelte";

const HOLD_MS = 500;
const DRIFT_PX = 10;

/** Call `open` after a still half-second press, or on a context menu. A press on a link or button is a tap, not a hold. */
export function hold(node: HTMLElement, open: () => void): { destroy(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    origin = null;
  };
  const down = (e: PointerEvent): void => {
    if ((e.target as HTMLElement | null)?.closest("a, button")) return;
    origin = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      open();
    }, HOLD_MS);
  };
  const move = (e: PointerEvent): void => {
    if (origin && (Math.abs(e.clientX - origin.x) > DRIFT_PX || Math.abs(e.clientY - origin.y) > DRIFT_PX)) cancel();
  };
  const menu = (e: Event): void => {
    e.preventDefault();
    cancel();
    open();
  };

  node.addEventListener("pointerdown", down);
  node.addEventListener("pointermove", move);
  node.addEventListener("pointerup", cancel);
  node.addEventListener("pointercancel", cancel);
  node.addEventListener("contextmenu", menu);
  return {
    destroy() {
      cancel();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", cancel);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("contextmenu", menu);
    },
  };
}

/** Route the anchor's href through the in-app router on a plain left click. */
export function internalLink(node: HTMLAnchorElement): { destroy(): void } {
  const click = (e: MouseEvent): void => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.navigate(node.getAttribute("href") ?? "/");
  };
  node.addEventListener("click", click);
  return { destroy: () => node.removeEventListener("click", click) };
}
