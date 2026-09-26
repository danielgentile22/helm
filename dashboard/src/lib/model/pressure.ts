// How hard a thing pulls on attention right now, and the words that justify it. The map
// reads it as ink (ink.ts: the size a lead is set at, a rail's length, a cell's plane),
// never as area, so this is the one place the ranking lives. A number is never shown
// without its reason (DESIGN.md, the reason rule).

import { phase } from "./phase";
import { fmtDate, fmtTime, lateFor } from "./time";
import type { Department, Model, Ms, Phase, Star, Thing } from "./types";

/** `soon` is due within three days and not yet late: what the summary counts as "due soon"
 *  and the only reason the warm hue is spent on. It is read off the date, before any rank
 *  weight, so a starred directive's far-off todo is not called soon. */
export type Pressure = { value: number; reason: string; late: boolean; soon: boolean };

export function dueSoon(p: Pressure): boolean {
  return p.soon;
}

/** How much a starred directive multiplies the pull of everything filed under it (ADR 0007:
 *  the ranked priorities are stars). Chosen so a late todo on the first directive (3 x 1.6 =
 *  4.8) outranks any late unstarred one (capped at 4.5), and one due today on it (4.16)
 *  outranks a freshly late side-project chore (3). The directive itself never escalates:
 *  the weight only scales what its own todos already pull. */
export const RANK_WEIGHT: Readonly<Record<Star, number>> = { 1: 1.6, 2: 1.35, 3: 1.15 };

export function rankWeight(star: Star | undefined): number {
  return star === undefined ? 1 : RANK_WEIGHT[star];
}

type Urgency = { value: number; reason: string; late: boolean };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Whole local days from now's date to at's date, in tz. Negative is past. */
export function daysUntil(at: Ms, now: Ms, tz: string): number {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const day = (t: Ms): number => Date.parse(f.format(new Date(t)) + "T00:00:00Z");
  return Math.round((day(at) - day(now)) / DAY_MS);
}

function dated(thing: Thing, at: Ms, now: Ms, tz: string, p: Phase): Urgency {
  const days = daysUntil(at, now, tz);
  if (p.state === "late") return { value: 3 + Math.min(1.5, -days * 0.25), reason: lateFor(p.lateMs), late: true };
  const stamp = thing.kind === "event" ? ` ${fmtTime(at, tz)}` : "";
  if (days === 0) return { value: 2.6, reason: `today${stamp}`, late: false };
  if (days === 1) return { value: 2.0, reason: `tomorrow${stamp}`, late: false };
  const when = `${fmtDate(at, tz)}${stamp}`;
  if (days <= 3) return { value: 1.4, reason: when, late: false };
  if (days <= 7) return { value: 0.9, reason: when, late: false };
  return { value: 0.4, reason: when, late: false };
}

/** How hard a thing pulls: its own urgency from its date or kind, times its directive's
 *  rank weight. */
export function pressure(thing: Thing, now: Ms, tz: string): Pressure {
  const own = urgency(thing, now, tz);
  const weight = thing.kind === "job" ? 1 : rankWeight(thing.star);
  return {
    value: Math.round(own.value * weight * 100) / 100,
    reason: own.reason,
    late: own.late,
    soon: !own.late && own.value >= 1.4,
  };
}

function urgency(thing: Thing, now: Ms, tz: string): Urgency {
  const p = phase(thing, now);
  if (thing.kind === "job") {
    if (p.state === "landed") return { value: 0, reason: `ran ${fmtTime(thing.at, tz)}`, late: false };
    return { value: 0.15, reason: `runs ${thing.schedule}`, late: false };
  }
  if (thing.kind === "daily") {
    return thing.doneToday ? { value: 0, reason: "done today", late: false }
                           : { value: 0.7, reason: "daily, not yet", late: false };
  }
  if (thing.kind === "event") {
    const at = thing.at ?? thing.since;
    if (p.state === "landed") return { value: 0, reason: "happened", late: false };
    if (at - now < HOUR_MS * 3) return { value: 2.8, reason: `at ${fmtTime(at, tz)}`, late: false };
    return dated(thing, at, now, tz, p);
  }
  if (thing.at === null) return { value: 0.35, reason: "no date", late: false };
  return dated(thing, thing.at, now, tz, p);
}

export type Placed = { thing: Thing; phase: Phase; pressure: Pressure };

/** A directive under a department, or the department's unfiled things. A starred directive
 *  with nothing filed under it has no things at all: it is drawn as a quiet cell that says
 *  "nothing queued", and pulls nothing (ADR 0007, ADR 0020). */
export type Directive = {
  name: string | null;
  things: Placed[];
  value: number;
  late: number;
  /** The one thing that would be worked on first in this directive. */
  lead: Placed | null;
  /** The directive's rank when it is starred, read off its todos. */
  star: Star | null;
};

export type DeptView = {
  dept: Department;
  value: number;
  late: number;
  /** Things pulling with a value above zero, so "quiet" is a count and not a colour. */
  open: number;
  summary: string;
  directives: Directive[];
};

function byPull(a: Placed, b: Placed): number {
  return b.pressure.value - a.pressure.value || a.thing.label.localeCompare(b.thing.label);
}

/** Everything the map draws for one department: its directives, largest first, each
 *  with its things, strongest first. Routines are background and never drawn. */
export function deptView(model: Model, dept: Department, now: Ms): DeptView {
  const groups = new Map<string | null, Placed[]>();
  for (const thing of model.things) {
    if (thing.dept !== dept || thing.kind === "job") continue;
    const placed = { thing, phase: phase(thing, now), pressure: pressure(thing, now, model.tz) };
    const list = groups.get(thing.project);
    if (list) list.push(placed);
    else groups.set(thing.project, [placed]);
  }
  const directives: Directive[] = [];
  for (const [name, things] of groups) {
    things.sort(byPull);
    const value = things.reduce((s, p) => s + p.pressure.value, 0);
    const late = things.filter((p) => p.pressure.late).length;
    const lead = things[0] !== undefined && things[0].pressure.value > 0 ? things[0] : null;
    directives.push({ name, things, value, late, lead, star: starOf(things) });
  }
  directives.sort((a, b) => b.value - a.value || (a.name ?? "").localeCompare(b.name ?? ""));
  // A starred directive with nothing under it still has a place, after every directive that
  // holds something, so it is never louder than a real todo.
  const empty = model.directives
    .filter((s) => s.dept === dept && !groups.has(s.name))
    .sort((a, b) => a.star - b.star || a.name.localeCompare(b.name));
  for (const s of empty) directives.push({ name: s.name, things: [], value: 0, late: 0, lead: null, star: s.star });
  const value = directives.reduce((s, d) => s + d.value, 0);
  const late = directives.reduce((s, d) => s + d.late, 0);
  const all = directives.flatMap((d) => d.things);
  const open = all.filter((p) => p.pressure.value > 0).length;
  return { dept, value, late, open, summary: summarize(all), directives };
}

/** The highest rank among a directive's things. A directive is starred as a whole, so in
 *  practice they all agree; the lowest number wins if a hand edit left them disagreeing. */
function starOf(things: readonly Placed[]): Star | null {
  let best: Star | null = null;
  for (const { thing } of things) {
    if (thing.kind !== "job" && thing.star !== undefined && (best === null || thing.star < best)) best = thing.star;
  }
  return best;
}

/** What a set of things pulls with, in words: "1 late, 2 due soon", "3 open", or "nothing
 *  pulling". The department summary and a directive's rail both say it this way. */
export function summarize(things: readonly Placed[]): string {
  const late = things.filter((p) => p.pressure.late).length;
  const soon = things.filter((p) => p.pressure.soon).length;
  const open = things.filter((p) => p.pressure.value > 0).length;
  const parts: string[] = [];
  if (late > 0) parts.push(`${late} late`);
  if (soon > 0) parts.push(`${soon} due soon`);
  if (parts.length === 0) parts.push(open > 0 ? `${open} open` : "nothing pulling");
  return parts.join(", ");
}

/** The one thing to work on across the whole board, and why. Null when nothing pulls. */
export function first(views: readonly DeptView[]): Placed | null {
  let best: Placed | null = null;
  for (const view of views) {
    for (const d of view.directives) {
      for (const p of d.things) {
        if (p.pressure.value > 0 && (best === null || byPull(p, best) < 0)) best = p;
      }
    }
  }
  return best;
}

/** How many things are late and how many land today, for the header's one line of counts. */
export type Tally = { late: number; today: number };

/** A daily is not counted as landing today. It lands every day, so counting it would keep
 *  "today" from ever reaching zero and the words "nothing due today" would never show. An
 *  event that has already happened pulls at zero and drops out with the done things. */
export function tally(views: readonly DeptView[], now: Ms, tz: string): Tally {
  let late = 0;
  let today = 0;
  for (const view of views) {
    for (const d of view.directives) {
      for (const { thing, pressure: p } of d.things) {
        if (p.late) late += 1;
        else if (p.value > 0 && (thing.kind === "todo" || thing.kind === "event") && thing.at !== null
                 && daysUntil(thing.at, now, tz) === 0) today += 1;
      }
    }
  }
  return { late, today };
}
