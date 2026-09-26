// Focus the page moves on its own: to the drawer's heading when it opens, back to the row's
// title when it closes. The keys treat a button someone tabbed to as keeping its keys, and
// Chrome marks a programmatic focus after a key press as :focus-visible, so App asks here
// and files a moved focus with the clicked ones rather than the tabbed ones. Otherwise
// closing the drawer with Escape would land on a title that then swallowed j and k.

let moving = false;

export function moveFocus(el: HTMLElement | null | undefined): void {
  if (el === null || el === undefined) return;
  moving = true;
  try {
    // The desk map does not scroll; on it a scroll would move a clipped cell's insides.
    el.focus({ preventScroll: true });
  } finally {
    moving = false;
  }
}

/** True only while moveFocus is focusing, which is when its focusin event fires. */
export function focusIsMoving(): boolean {
  return moving;
}
