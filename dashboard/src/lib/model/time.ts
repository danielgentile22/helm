// Formatting on the model's timezone only. `Intl.DateTimeFormat` is the whole mechanism,
// which is what lets the 35 day window cross a DST boundary without a special case.

import { ms } from "./types";
import type { Ms } from "./types";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TWO_DAYS_MS = 2 * DAY_MS;

type Wall = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, tz: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${tz}`;
  const cached = FORMATS.get(id);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...options });
  FORMATS.set(id, made);
  return made;
}

function fields(format: Intl.DateTimeFormat, at: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(at))) out[part.type] = part.value;
  return out;
}

function wallAt(at: number, tz: string): Wall {
  const f = fields(
    formatter("wall", tz, {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    at,
  );
  const read = (name: string): number => Number(f[name] ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** How far the zone runs ahead of UTC at this instant, in ms. */
function offsetAt(at: number, tz: string): number {
  const w = wallAt(at, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** A local wall time, carried as the same fields read in UTC, back to the real instant.
 *  The second pass is what makes a DST changeover land on the right side. */
function epochOfWall(wallAsUtc: number, tz: string): number {
  const guess = wallAsUtc - offsetAt(wallAsUtc, tz);
  return wallAsUtc - offsetAt(guess, tz);
}

export function midnightsFrom(now: Ms, tz: string, count: number): Ms[] {
  const w = wallAt(now, tz);
  const first = Date.UTC(w.year, w.month - 1, w.day, 0, 0, 0);
  const out: Ms[] = [];
  for (let day = 0; out.length < count && day <= count + 1; day += 1) {
    const at = epochOfWall(first + day * DAY_MS, tz);
    if (at >= now) out.push(ms(at));
  }
  return out;
}

/** "2026-09-24 18:30", the way a department note writes an event's `(at: ...)`. */
export function noteStamp(at: Ms, tz: string): string {
  const w = wallAt(at, tz);
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
}

/** "2026-09-24", the way a department note writes a due date: the calendar day in the zone. */
export function noteDay(at: Ms, tz: string): string {
  return noteStamp(at, tz).slice(0, 10);
}

export function fmtDay(at: Ms, tz: string): string {
  const f = fields(formatter("day", tz, { weekday: "short", day: "numeric" }), at);
  return `${f["weekday"] ?? ""} ${f["day"] ?? ""}`.trim();
}

/** "Thu 17 Sep". The date a row's second line names. */
export function fmtDate(at: Ms, tz: string): string {
  const f = fields(formatter("date", tz, { weekday: "short", day: "numeric", month: "short" }), at);
  return `${f["weekday"] ?? ""} ${f["day"] ?? ""} ${f["month"] ?? ""}`.trim();
}

/** "Mon 21 Sep 20:20". The same date with a 24 hour wall time, for a job. */
export function fmtDateTime(at: Ms, tz: string): string {
  const f = fields(formatter("clock", tz, { hourCycle: "h23", hour: "2-digit", minute: "2-digit" }), at);
  return `${fmtDate(at, tz)} ${f["hour"] ?? ""}:${f["minute"] ?? ""}`.trim();
}

export function fmtTime(at: Ms, tz: string): string {
  const f = fields(formatter("time", tz, { hour: "numeric", minute: "2-digit", hour12: true }), at);
  return `${f["hour"] ?? ""}:${f["minute"] ?? ""} ${f["dayPeriod"] ?? ""}`.trim();
}

export function relative(at: Ms, now: Ms): string {
  const away = at - now;
  if (away <= 0) return "arrived";
  if (away < HOUR_MS) return `${Math.max(1, Math.floor(away / MINUTE_MS))}m`;
  if (away < TWO_DAYS_MS) return `${Math.floor(away / HOUR_MS)}h`;
  return `${Math.floor(away / DAY_MS)}d`;
}

/** An elapsed span, for things whose age is the point: a source's last success, a
 *  repo's last touch. `relative` answers "arrived" for all of them, which says nothing. */
export function duration(span: number): string {
  const since = Math.max(0, span);
  if (since < HOUR_MS) return `${Math.round(since / MINUTE_MS)}m`;
  if (since < TWO_DAYS_MS) return `${Math.round(since / HOUR_MS)}h`;
  return `${Math.round(since / DAY_MS)}d`;
}

/** An undated todo says how long it has been open, never how late it is. */
export function openFor(ageMs: number): string {
  return `open ${duration(ageMs)}`;
}

/** Hours only inside the first day: past it "27h late" makes the reader do the division. */
export function lateFor(lateMs: number): string {
  if (lateMs < DAY_MS) return `${Math.max(1, Math.floor(lateMs / HOUR_MS))}h late`;
  return `${Math.floor(lateMs / DAY_MS)}d late`;
}
