// The keyboard's row cursor as data. The rows are walked in the order the map draws them,
// so j lands on the row a reader's eye would go to next, and a cursor whose row has left
// the board (ticked, or zoomed away from) lands on the row that took its place.

import { DEPARTMENTS } from "./types";
import type { Department, ThingId } from "./types";
import type { DeptView } from "./pressure";

/** Every drawn row, top to bottom: departments in corner reading order, directives in board
 *  order, and within a directive its things strongest first. That last list is exactly what
 *  Directive.svelte renders, lead or not: the lead is the first thing when it pulls, and the
 *  done ones sort last because nothing pulls less than zero. */
export function rowOrder(views: readonly DeptView[], zoom: Department | null): ThingId[] {
  const rank = (view: DeptView): number => DEPARTMENTS.indexOf(view.dept);
  return [...views]
    .filter((view) => zoom === null || view.dept === zoom)
    .sort((a, b) => rank(a) - rank(b))
    .flatMap((view) => view.directives.flatMap((d) => d.things.map((p) => p.thing.id)));
}

/** Where the cursor stands, from where it was put and the index it was put at. A row that
 *  is gone hands the cursor to whatever now sits at its index, clamped to the last row. */
export function resolve(order: readonly ThingId[], cursor: ThingId | null, at: number): ThingId | null {
  if (cursor === null || order.includes(cursor)) return cursor;
  return order[Math.min(at, order.length - 1)] ?? null;
}

/** One press of j (+1) or k (-1). A first press starts at the top, and the ends hold
 *  rather than wrap, so holding j parks on the last row instead of cycling. */
export function step(order: readonly ThingId[], cursor: ThingId | null, delta: 1 | -1): { id: ThingId; at: number } | null {
  if (order.length === 0) return null;
  const from = cursor === null ? -1 : order.indexOf(cursor);
  const at = from === -1 ? 0 : Math.max(0, Math.min(order.length - 1, from + delta));
  const id = order[at];
  return id === undefined ? null : { id, at };
}
