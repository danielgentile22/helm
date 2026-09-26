// The pointing state the map and the drawer share. Nothing derived and nothing fetched.

import { DEPARTMENTS } from "./model/types";
import type { Department, ThingId } from "./model/types";

const PAGE_KEY = "helm.page";

/** A page of the phone's carousel: a department, or the week across the board after them. */
export type Page = Department | "Week";
export const PAGES: readonly Page[] = [...DEPARTMENTS, "Week"];

function watch(query: string): { get value(): boolean } {
  const list = window.matchMedia(query);
  let on = $state(list.matches);
  list.addEventListener("change", (event) => {
    on = event.matches;
  });
  return {
    get value(): boolean {
      return on;
    },
  };
}

const narrow = watch("(max-width: 700px)");
const still = watch("(prefers-reduced-motion: reduce)");

function storedPage(): Page {
  try {
    const saved = window.localStorage.getItem(PAGE_KEY);
    return PAGES.find((p) => p === saved) ?? "Work";
  } catch {
    return "Work";
  }
}

let page = $state<Page>(storedPage());
let zoom = $state<Department | null>(null);
let opened = $state<ThingId | null>(null);
let hovered = $state<ThingId | null>(null);
let editing = $state(false);
// The keyboard's row, and the index it was put at, so a row that leaves the board hands the
// cursor to its neighbour (model/cursor.ts resolve). Hover never moves it.
let cursor = $state<ThingId | null>(null);
let cursorAt = $state(0);
// The quick add field, open or not, and the department and directive it starts in. A fresh
// object on every open, so asking for it while it is already open still moves focus back to it.
export type Adding = { dept: Department | null; directive: string | null };
let adding = $state<Adding | null>(null);
// The legend of glyphs and keys, shown in the drawer in place of a thing.
let legend = $state(false);

export const ui = {
  /** The department filling the map, or null for all four. */
  get zoom(): Department | null {
    return zoom;
  },
  /** The thing whose detail is open in the drawer. */
  get opened(): ThingId | null {
    return opened;
  },
  get hovered(): ThingId | null {
    return hovered;
  },
  /** Whether the drawer shows its edit form rather than the thing. */
  get editing(): boolean {
    return editing;
  },
  /** The row the keyboard is on, as last put. board.cursor is where it resolves to now. */
  get cursor(): ThingId | null {
    return cursor;
  },
  get cursorAt(): number {
    return cursorAt;
  },
  point(id: ThingId, at: number): void {
    cursor = id;
    cursorAt = at;
  },
  /** True on a phone-sized viewport, where the map becomes a swipeable carousel. */
  get phone(): boolean {
    return narrow.value;
  },
  get reduced(): boolean {
    return still.value;
  },
  /** The page the phone carousel is on. Ignored on the desktop map. */
  get page(): Page {
    return page;
  },
  /** The department the phone is on, or null on the week's page. */
  get pageDept(): Department | null {
    return page === "Week" ? null : page;
  },
  setPage(next: Page): void {
    page = next;
    try {
      window.localStorage.setItem(PAGE_KEY, next);
    } catch {
      // A private window may refuse storage; the page still turns, it just is not remembered.
    }
  },
  setZoom(dept: Department | null): void {
    zoom = zoom === dept ? null : dept;
    // A cursor left outside the new view restarts at its top rather than at an index
    // that meant something on the old one.
    cursorAt = 0;
  },
  open(id: ThingId | null): void {
    opened = opened === id ? null : id;
    editing = false;
    legend = false;
  },
  /** Open this thing whatever is open now. An edit that rewords a todo gives it a new id,
   *  and the drawer and the cursor follow it here rather than through open(), which would toggle. */
  show(id: ThingId): void {
    if (cursor !== null && cursor === opened) cursor = id;
    opened = id;
    legend = false;
  },
  /** Open this thing straight into its edit form. */
  edit(id: ThingId): void {
    opened = id;
    editing = true;
    legend = false;
  },
  /** Whether the drawer shows the legend of glyphs and keys. */
  get legend(): boolean {
    return legend;
  },
  /** ? opens the legend in the drawer, over whatever it showed, and ? again closes it. */
  toggleLegend(): void {
    legend = !legend;
    if (legend) {
      opened = null;
      editing = false;
    }
  },
  stopEditing(): void {
    editing = false;
  },
  hover(id: ThingId | null): void {
    hovered = id;
  },
  /** The quick add field, or null when it is closed. */
  get adding(): Adding | null {
    return adding;
  },
  /** Open the quick add field in this department, or in none so the line has to name one,
   *  and optionally under one of its directives. */
  add(dept: Department | null, directive: string | null = null): void {
    adding = { dept, directive: dept === null ? null : directive };
  },
  stopAdding(): void {
    adding = null;
  },
  /** Escape: the legend or the drawer first, then the zoom, then the cursor. */
  clear(): void {
    if (legend) legend = false;
    else if (opened !== null) {
      opened = null;
      editing = false;
    } else if (zoom !== null) zoom = null;
    else cursor = null;
  },
};
