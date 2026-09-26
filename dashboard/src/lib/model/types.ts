// The one model the whole page reads. Timestamps only, never a
// duration and never a phase: `now` is an input to every reader (ADR 0013, ADR 0014).

export type Department = "Work" | "Chess" | "Projects" | "Life";
export const DEPARTMENTS: readonly Department[] = ["Work", "Chess", "Projects", "Life"];

/** Epoch milliseconds. Branded so a raw number cannot stand in for a time. */
export type Ms = number & { readonly __ms: unique symbol };
/** "todo:<content id>" | "routine:<name>", as the producers write them. */
export type ThingId = string & { readonly __thing: unique symbol };
/** The 12-hex content id todo_edit.py accepts. The address of the one write. */
export type TodoId = string & { readonly __todo: unique symbol };

export type DoneWhen = { predicate: string; ok: boolean | null; checked: Ms | null; detail: string };
export type Sub = { text: string; done: boolean };

/** The three kinds of box on a department note (runner/producers/sources/todos.py). A
 *  todo is due at 17:00 on its day or undated, a daily is done by date and never ticked,
 *  an event happens at a moment. */
export type TodoKind = "todo" | "daily" | "event";

/** A starred directive's rank, 1 the highest (ADR 0007). The three starred directives are
 *  the ranked priorities in CLAUDE.md; every todo filed under one carries its rank. */
export type Star = 1 | 2 | 3;

/** A starred directive heading as capture reports it, whether or not any todo sits under
 *  it (agenda.json's `directives`, ADR 0020). Only an empty one is drawn on its own: one
 *  with todos is already its cell. */
export type StarredDirective = { dept: Department; name: string; star: Star };

/** One thing on the board. `at` is when it lands, `since` when it was opened. Facts from the file. */
export type Thing =
  | { kind: "job"; id: ThingId; dept: Department; label: string; at: Ms; schedule: string; path: string }
  | { kind: TodoKind; id: ThingId; todoId: TodoId; dept: Department; project: string | null; label: string;
      at: Ms | null; due: string | null; since: Ms; doneToday: boolean; notes: string; subs: readonly Sub[];
      path: string; line: number; doneWhen: DoneWhen | null; star?: Star };

/** Where a thing stands at a given `now`. Computed by phase(), never stored. */
export type Phase =
  | { state: "arriving"; inMs: number }
  | { state: "landed"; agoMs: number }
  /** A todo with no date. Not late, not arriving: waiting, with an age. */
  | { state: "open"; ageMs: number }
  | { state: "late"; lateMs: number; heat: number }
  /** A daily: done today or still to do today. */
  | { state: "daily"; done: boolean };

export type Repo = {
  kind: "repo" | "workspace";
  name: string;
  path: string;
  touched: Ms | null;
  branch: string | null;
  unmerged: number | null;
  unpushed: number | null;
  dirty: number | null;
  tracker: { kind: string; openIssues: number; openPrs: number; ref: string } | null;
  lastSession: { at: Ms; note: string } | null;
};

export type SourceName = "todos" | "routines" | "repos" | "trackers";
export type Source = {
  name: SourceName;
  file: "agenda" | "projects";
  produced: Ms | null;
  attempted: Ms | null;
  ok: boolean;
  reason: string | null;
  count: number;
  cadenceMs: number;
};

/** Mirrors runner/checks/check_freshness.py: failing, never produced, or older than twice the cadence. */
export type Freshness =
  | { state: "fresh" }
  | { state: "stale"; ageMs: number }
  | { state: "failed"; reason: string; rowsFrom: Ms | null }
  | { state: "never" };

export type Model = {
  tz: string;
  produced: { agenda: Ms | null; projects: Ms | null };
  things: readonly Thing[];
  /** Every starred directive, empty or not. */
  directives: readonly StarredDirective[];
  repos: readonly Repo[];
  sources: readonly Source[];
  /** Rows that failed their contract in decode(). Shown, never thrown on. */
  dropped: number;
};

/** The brand constructors live beside the brands: this is the only place a raw value
 *  is allowed to become one, which is what keeps the assertion honest. */
export const ms = (n: number): Ms => n as Ms;
export const thingId = (s: string): ThingId => s as ThingId;
export const todoId = (s: string): TodoId => s as TodoId;

/** ISO with offset, as every producer writes it. Anything else is null, never a throw. */
export function parseIso(text: unknown): Ms | null {
  if (typeof text !== "string" || text === "") return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : ms(at);
}
