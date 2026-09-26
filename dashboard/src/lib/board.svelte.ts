// What the map and the phone carousel both draw: the four department views, the thing the
// drawer is open on, and the row the keyboard is on. Derived once here so the two chromes
// cannot disagree.

import { clock } from "./clock.svelte";
import { resolve, rowOrder } from "./model/cursor";
import { week } from "./model/ink";
import { deptView, first, tally } from "./model/pressure";
import { fmtDate } from "./model/time";
import { DEPARTMENTS } from "./model/types";
import { snapshot } from "./snapshot.svelte";
import { ui } from "./ui.svelte";
import type { Week } from "./model/ink";
import type { DeptView, Placed, Tally } from "./model/pressure";
import type { ThingId } from "./model/types";

/** The header's reading of the day: its date and its counts, from the same instant as the map. */
export type Today = { date: string; tally: Tally };

// One read of the clock per render, shared by the map and the header's counts so the two
// cannot straddle midnight. clock.minute is the tick everything re-reads on.
const frame = $derived.by((): { views: DeptView[]; today: Today | null; week: Week | null } => {
  void clock.minute;
  const now = clock.now();
  const model = snapshot.model;
  if (model === null) return { views: [], today: null, week: null };
  const views = DEPARTMENTS.map((dept) => deptView(model, dept, now));
  return {
    views,
    today: { date: fmtDate(now, model.tz), tally: tally(views, now, model.tz) },
    week: week(views, now, model.tz),
  };
});

const views = $derived(frame.views);
const start = $derived(first(views));

const placed = $derived(
  new Map(views.flatMap((view) => view.directives.flatMap((d) => d.things.map((p) => [p.thing.id, p] as const)))),
);

const opened = $derived(ui.opened === null ? null : placed.get(ui.opened) ?? null);

// The phone has no zoom, so its cursor walks all four pages.
const order = $derived(rowOrder(views, ui.phone ? null : ui.zoom));
const cursor = $derived(resolve(order, ui.cursor, ui.cursorAt));

export const board = {
  get views(): DeptView[] {
    return views;
  },
  get opened(): Placed | null {
    return opened;
  },
  /** Every drawn row in the order j walks them. */
  get order(): ThingId[] {
    return order;
  },
  /** The row the keyboard is on, or null when it has not been used or was sent away. */
  get cursor(): ThingId | null {
    return cursor;
  },
  find(id: ThingId): Placed | null {
    return placed.get(id) ?? null;
  },
  /** The one thing to start with across the whole board, or null when nothing pulls. */
  get start(): Placed | null {
    return start;
  },
  /** The week band's reading of the same instant: late, then the next seven days. */
  get week(): Week | null {
    return frame.week;
  },
  /** Null until the first snapshot lands, so the header never counts an empty board as calm. */
  get today(): Today | null {
    return frame.today;
  },
};
