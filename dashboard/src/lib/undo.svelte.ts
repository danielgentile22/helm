// The tick path. Ticking a todo commits to the vault's git history, so a tick waits out an
// undo window in the header before it is written, and a wrong checkbox is one key to take
// back instead of a hand edit of the note. Every way of ticking (the row's box, x, the
// drawer's done verb, the lead's inline done) comes through here; the timing rules are
// model/undo.ts. Stamps are performance.now(), the page's monotonic clock rather than wall
// time, because only the gap between two of them matters and a server skew correction
// landing mid-window must not move the countdown.

import { clock } from "./clock.svelte";
import { UNDO_MS, banner, settle } from "./model/undo";
import { snapshot } from "./snapshot.svelte";
import type { TodoThing } from "./model/edit";
import type { Banner, Tick } from "./model/undo";
import type { TodoId } from "./model/types";

let ticks = $state<Tick[]>([]);
// The clock's beat is held while a tick waits, so the countdown reads whole seconds on
// time, and released as soon as none does.
let release: (() => void) | null = null;

function keep(next: Tick[]): void {
  ticks = next;
  if (next.length > 0) release ??= clock.hold();
  else if (release !== null) {
    release();
    release = null;
  }
}

// Each held tick gets one timeout for the end of its window. A tick taken back before then
// is simply not there when the timeout looks, so nothing needs cancelling.
function settleDue(): void {
  const { due, waiting } = settle(ticks, performance.now());
  if (due.length === 0) return;
  keep(waiting);
  for (const tick of due) void snapshot.toggleTodo(tick.todo, true);
}

function hold(thing: TodoThing): void {
  keep([...ticks, { todo: thing.todoId, label: thing.label, at: performance.now() }]);
  setTimeout(settleDue, UNDO_MS);
}

function cancel(id: TodoId): void {
  keep(ticks.filter((tick) => tick.todo !== id));
}

function waiting(id: TodoId): boolean {
  return ticks.some((tick) => tick.todo === id);
}

function checked(thing: TodoThing): boolean {
  return waiting(thing.todoId) || snapshot.pendingDone(thing.todoId) || (thing.kind === "daily" && thing.doneToday);
}

// A page going away writes what it holds rather than dropping it, so a tick is never lost
// silently. Hidden counts as going away: a phone suspends a background tab without ever
// firing pagehide, and its timers with it. keepalive lets the request outlive the page.
function flush(): void {
  const held = ticks;
  keep([]);
  for (const tick of held) void snapshot.toggleTodo(tick.todo, true, true);
}
window.addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flush();
});

// Read again on every beat and on every change to the ticks, so the line is right the
// instant a tick lands rather than a beat later.
const shown = $derived.by(() => {
  void clock.beat;
  return banner(ticks, performance.now());
});

export const undo = {
  /** The header's line: the newest waiting tick and its countdown, or null. */
  get banner(): Banner | null {
    return shown;
  },
  /** Whether this todo's box reads ticked: waiting out its window, in flight, or a daily
   *  already done today. */
  checked,
  /** Whether this todo is ticked but not yet written, so its row can say so. */
  waiting,
  /** The box's two directions. Ticking waits out the window. Unticking one that is still
   *  waiting takes it back and writes nothing; unticking a done daily writes at once. */
  set(thing: TodoThing, done: boolean): void {
    if (done === checked(thing)) return;
    if (done) hold(thing);
    else if (waiting(thing.todoId)) cancel(thing.todoId);
    else void snapshot.toggleTodo(thing.todoId, false);
  },
  /** u: take back the newest waiting tick. */
  undoLast(): void {
    const newest = ticks.at(-1);
    if (newest !== undefined) cancel(newest.todo);
  },
};
