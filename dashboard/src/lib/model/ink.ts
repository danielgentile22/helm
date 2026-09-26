// Sizing the ink, not the plane. Pure. The map no longer turns pull into area: a department
// and a directive are as tall as what they hold, and pull is carried by three things read
// here. How large a directive's lead is set (its tier), a rail whose length is the pull,
// segment by segment, with the words beside it, and the lightness of a hot cell's surface.
// Between the two rows sits the week: what lands on each of the next seven days across the
// board, as tall as its busiest day, with the room nobody needs left at the page's foot.

import { daysUntil } from "./pressure";
import { fmtDay, midnightsFrom } from "./time";
import { ms } from "./types";
import type { DeptView, Placed, Pressure } from "./pressure";
import type { Department, Ms, ThingId } from "./types";

/** 1 is the loudest lead on the board, 4 is no lead at all: the cell is its rows. */
export type Tier = 1 | 2 | 3 | 4;

/** The pull a lead needs for each tier. Late work starts at 3, so anything late reaches
 *  tier 1; due tomorrow on an unstarred directive is 2, on the first starred one 3.2; this
 *  week is 0.9 to 1.4. A daily is 0.7 and leads nothing on its own, but under the first or
 *  second starred directive (1.12, 0.95) it reaches tier 3. Undated is 0.35 and never
 *  leads, even starred (0.56). */
export const TIER_AT: readonly [number, number, number] = [3, 2, 0.9];

export function leadTier(p: Pressure | null): Tier {
  if (p === null) return 4;
  if (p.value >= TIER_AT[0]) return 1;
  if (p.value >= TIER_AT[1]) return 2;
  if (p.value >= TIER_AT[2]) return 3;
  return 4;
}

/** What a rail segment says without its colour: the words beside the rail repeat it. Late
 *  is the alarm hue, soon the warm one, an event the cool one, and the rest are bone. */
export type Tone = "late" | "soon" | "event" | "calm";
export type Segment = { pull: number; tone: Tone };

function toneOf(p: Placed): Tone {
  return p.pressure.late ? "late" : p.pressure.soon ? "soon" : p.thing.kind === "event" ? "event" : "calm";
}

/** One segment per loud open thing (late, soon, an event) in the order given, strongest
 *  first, then the calm ones pooled into one tail at the end. A calm thing is undated, a
 *  daily or far off, and alone it pulls so little its segment was a dot; two of them read
 *  as a glitch rather than as "2 open". Pooled, the tail is one short neutral bar and the
 *  words beside it give the count. Done things pull nothing and add no segment. */
export function segments(things: readonly Placed[]): Segment[] {
  const open = things.filter((p) => p.pressure.value > 0);
  const loud: Segment[] = open.flatMap((p) => {
    const tone = toneOf(p);
    return tone === "calm" ? [] : [{ pull: p.pressure.value, tone }];
  });
  const quiet = open.filter((p) => toneOf(p) === "calm").reduce((s, p) => s + p.pressure.value, 0);
  return quiet > 0 ? [...loud, { pull: Math.round(quiet * 100) / 100, tone: "calm" }] : loud;
}

/** Pixels per unit of pull. One scale for the whole board, so a rail means the same length
 *  in every cell: at most `perPull`, and less when the loudest department would run past
 *  `max` pixels. */
export const PX_PER_PULL = 14;
export const RAIL_MAX = 170;

export function railScale(deptValues: readonly number[], max: number = RAIL_MAX, perPull: number = PX_PER_PULL): number {
  const loudest = Math.max(0, ...deptValues);
  return loudest === 0 ? perPull : Math.min(perPull, max / loudest);
}

/** One day of the week band: its label, whether it is today, and what lands on it. */
export type Day = { offset: number; label: string; today: boolean; items: Placed[] };

/** The week band: what is late, then the next seven days from today, each with the dated
 *  things (todos with a date, events) that land on it and still pull, soonest first. The
 *  dailies are counted, not listed, because they land every day. */
export type Week = { late: Placed[]; days: Day[]; dailies: { done: number; total: number }; undated: number };

export const WEEK_DAYS = 7;

export function week(views: readonly DeptView[], now: Ms, tz: string): Week {
  const starts = [now, ...midnightsFrom(now, tz, WEEK_DAYS - 1)];
  const days: Day[] = starts.map((at, offset) => ({ offset, label: fmtDay(ms(at), tz), today: offset === 0, items: [] }));
  const late: Placed[] = [];
  const dailies = { done: 0, total: 0 };
  let undated = 0;
  for (const view of views) {
    for (const d of view.directives) {
      for (const p of d.things) {
        const { thing } = p;
        if (thing.kind === "job") continue;
        if (thing.kind === "daily") {
          dailies.total += 1;
          if (thing.doneToday) dailies.done += 1;
          continue;
        }
        if (p.pressure.value === 0) continue;
        if (p.pressure.late) { late.push(p); continue; }
        if (thing.at === null) { undated += 1; continue; }
        const day = days[daysUntil(thing.at, now, tz)];
        if (day !== undefined) day.items.push(p);
      }
    }
  }
  const when = (p: Placed): number => (p.thing.kind === "job" ? p.thing.at : p.thing.at ?? 0);
  for (const day of days) day.items.sort((a, b) => when(a) - when(b) || b.pressure.value - a.pressure.value);
  late.sort((a, b) => b.pressure.value - a.pressure.value);
  return { late, days, dailies, undated };
}

/** The best day: nothing late and nothing landing today. The band says so in words and
 *  names the next thing that does land, rather than showing an empty column. */
export function calm(w: Week): boolean {
  return w.late.length === 0 && (w.days[0]?.items.length ?? 0) === 0;
}

/** The first dated thing after today inside the week, or null. */
export function nextUp(w: Week): { day: Day; item: Placed } | null {
  for (const day of w.days) {
    const item = day.items[0];
    if (!day.today && item !== undefined) return { day, item };
  }
  return null;
}

/** Late things already drawn on the map, counted by the department they sit in: "1 late ·
 *  Projects". The band points at them rather than repeating them. `items` is strongest first,
 *  so a click opens the first. */
export type LateCount = { dept: Department; items: Placed[] };

/** One column of the week band, as drawn. The late column counts what the map already shows
 *  and lists only what it does not; a day lists what lands on it; a span is a run of two or
 *  more empty days folded into one column that names its first and last day. */
export type Column =
  | { kind: "late"; key: string; total: number; counts: LateCount[]; items: Placed[] }
  | { kind: "day"; key: string; label: string; today: boolean; items: Placed[] }
  | { kind: "span"; key: string; from: string; to: string };

/** The band's columns. `drawn` says whether a thing is visible on the map, as a lead or a
 *  row: a late thing that is gets counted under its department, and one that is not (behind
 *  a "+N more") is still listed by name, so nothing late is ever only a number. Today is
 *  always its own column, even when clear. Two or more empty days in a row fold into a span;
 *  a single empty day stays its own column. */
export function columns(w: Week, drawn: (id: ThingId) => boolean): Column[] {
  const out: Column[] = [];
  if (w.late.length > 0) {
    const counts: LateCount[] = [];
    const items: Placed[] = [];
    for (const p of w.late) {
      if (!drawn(p.thing.id)) {
        items.push(p);
        continue;
      }
      const hit = counts.find((c) => c.dept === p.thing.dept);
      if (hit) hit.items.push(p);
      else counts.push({ dept: p.thing.dept, items: [p] });
    }
    out.push({ kind: "late", key: "late", total: w.late.length, counts, items });
  }
  let run: Day[] = [];
  const flush = (): void => {
    const [head] = run;
    const last = run.at(-1);
    if (run.length >= 2 && head !== undefined && last !== undefined) {
      out.push({ kind: "span", key: `s${head.offset}`, from: head.label, to: last.label });
    } else {
      for (const d of run) out.push(dayColumn(d));
    }
    run = [];
  };
  for (const d of w.days) {
    if (!d.today && d.items.length === 0) {
      run.push(d);
      continue;
    }
    flush();
    out.push(dayColumn(d));
  }
  flush();
  return out;
}

function dayColumn(d: Day): Column {
  return { kind: "day", key: `d${d.offset}`, label: d.today ? "today" : d.label, today: d.today, items: d.items };
}

/** How many lines a column needs to show everything: one per late count, one per item, and
 *  one for an empty column's "clear". The band is as tall as its busiest column. */
export function linesOf(col: Column): number {
  if (col.kind === "span") return 1;
  const n = col.kind === "late" ? col.counts.length + col.items.length : col.items.length;
  return Math.max(1, n);
}
