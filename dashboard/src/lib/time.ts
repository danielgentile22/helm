const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function span(ms: number): string {
  if (ms < HOUR) return plural(Math.max(1, Math.round(ms / MINUTE)), "minute");
  if (ms < DAY) return plural(Math.round(ms / HOUR), "hour");
  if (ms < 14 * DAY) return plural(Math.round(ms / DAY), "day");
  if (ms < 60 * DAY) return plural(Math.round(ms / (7 * DAY)), "week");
  if (ms < 730 * DAY) return plural(Math.round(ms / (30 * DAY)), "month");
  return plural(Math.round(ms / (365 * DAY)), "year");
}

/** "3 hours ago" for a past time, "in 20 minutes" for a future one. */
export function ageOf(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "at an unreadable time";
  const diff = now - at;
  if (Math.abs(diff) < MINUTE) return "just now";
  return diff > 0 ? `${span(diff)} ago` : `in ${span(-diff)}`;
}

/** The local calendar date as YYYY-MM-DD, the form the vault writes dates in. */
export function localDate(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** "Nov 15", with the year when it is not this year. */
export function shortDate(date: string, today: string): string {
  const d = parseDate(date);
  if (d === null) return date;
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** YYYY-MM-DD strings compare in date order. */
export function isOverdue(date: string, today: string): boolean {
  return date < today;
}

export function dueLabel(date: string, today: string): string {
  if (isOverdue(date, today)) return "overdue";
  if (date === today) return "due today";
  return `due ${shortDate(date, today)}`;
}

/** "today", "yesterday", "5 days ago" between two calendar dates. */
export function daysAgo(date: string, today: string): string {
  const from = parseDate(date);
  const to = parseDate(today);
  if (from === null || to === null) return date;
  const days = Math.round((to.getTime() - from.getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
