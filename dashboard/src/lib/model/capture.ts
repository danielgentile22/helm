// Quick add as data. One typed line becomes the body of POST /api/todos, or the reason it
// cannot be sent yet. The grammar: an optional leading department word, at most one
// #directive anywhere, and the words for when at the end. Whatever is left is the todo.

import { fmtDate, noteDay } from "./time";
import { DEPARTMENTS, ms } from "./types";
import type { When } from "./edit";
import type { Department, Ms, StarredDirective, Thing } from "./types";

/** What POST /api/todos takes. `project: null` files the todo under no directive. */
export type NewTodo = { text: string; dept: Department; project: string | null; when: When };

/** The directive names each department already files todos under. */
export type Known = Readonly<Record<Department, readonly string[]>>;

export type Parsed = { todo: NewTodo } | { problem: string };

const DAY_MS = 86_400_000;

// A Map rather than an object literal, so "constructor" typed first is not a department.
const DEPT_WORDS = new Map<string, Department>([
  ["work", "Work"],
  ["chess", "Chess"],
  ["projects", "Projects"],
  ["project", "Projects"],
  ["life", "Life"],
]);

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// Words that only introduce a day ("by fri", "due 9/30") and mean nothing once it is read.
const DAY_LEADS = new Set(["on", "by", "due"]);

/** Every directive a todo is filed under, plus every starred one, which may have none yet. */
export function knownDirectives(things: readonly Thing[], starred: readonly StarredDirective[] = []): Known {
  const sets: Record<Department, Set<string>> = { Work: new Set(), Chess: new Set(), Projects: new Set(), Life: new Set() };
  for (const thing of things) if (thing.kind !== "job" && thing.project !== null) sets[thing.dept].add(thing.project);
  for (const s of starred) sets[s.dept].add(s.name);
  const sorted = (dept: Department): string[] => [...sets[dept]].sort();
  return { Work: sorted("Work"), Chess: sorted("Chess"), Projects: sorted("Projects"), Life: sorted("Life") };
}

// Calendar arithmetic on "YYYY-MM-DD" is done in UTC, where every day is 24 hours long. The
// zone only matters for which day today is, and noteDay has already answered that.
function civil(year: number, month: number, day: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at.toISOString().slice(0, 10);
}

function utcOf(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function plusDays(day: string, n: number): string {
  return new Date(utcOf(day) + n * DAY_MS).toISOString().slice(0, 10);
}

type DayRead = { day: string } | { problem: string } | null;

/** One word as a calendar day counted from `today`, a reason it names no real day, or null
 *  when it is not a date word at all and belongs to the text. */
function readDay(word: string, today: string): DayRead {
  if (word === "today") return { day: today };
  if (word === "tomorrow" || word === "tmrw") return { day: plusDays(today, 1) };
  // A weekday is the next one strictly ahead: typing "wed" on a Wednesday means next week,
  // because this Wednesday already has a word, "today".
  const weekday = word.length >= 3 ? WEEKDAYS.findIndex((name) => name.startsWith(word)) : -1;
  if (weekday >= 0) {
    const ahead = (weekday - new Date(utcOf(today)).getUTCDay() + 7) % 7 || 7;
    return { day: plusDays(today, ahead) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word);
  if (iso !== null) {
    const day = civil(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return day === null ? { problem: `no such day ${word}` } : { day };
  }
  const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(word);
  if (us !== null) {
    const month = Number(us[1]);
    const date = Number(us[2]);
    const written = us[3];
    const thisYear = Number(today.slice(0, 4));
    const year = written === undefined ? thisYear : written.length === 2 ? 2000 + Number(written) : Number(written);
    const day = civil(year, month, date);
    if (day === null) return { problem: `no such day ${word}` };
    // Without a year, a day already gone this year is the one next year.
    if (written === undefined && day < today) return { day: civil(thisYear + 1, month, date) ?? day };
    return { day };
  }
  return null;
}

/** "7pm", "7:30pm" or "19:00" as the note's "HH:MM", or null when it is not a time. */
function readClock(word: string): string | null {
  const two = (n: number): string => String(n).padStart(2, "0");
  const twelve = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(word);
  if (twelve !== null) {
    const hour = Number(twelve[1]);
    const minute = Number(twelve[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return `${two((hour % 12) + (twelve[3] === "pm" ? 12 : 0))}:${two(minute)}`;
  }
  const day = /^(\d{1,2}):(\d{2})$/.exec(word);
  if (day !== null) {
    const hour = Number(day[1]);
    const minute = Number(day[2]);
    if (hour > 23 || minute > 59) return null;
    return `${two(hour)}:${two(minute)}`;
  }
  return null;
}

type Hit = { dept: Department; name: string };

const fold = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");

/** How well a tag names a directive: 0 is the name itself, 1 the start of it, 2 the start of
 *  some of its words ("#e4" for "1.e4 e5 course"), null not at all. */
function closeness(tag: string, name: string): number | null {
  const want = fold(tag);
  const have = fold(name);
  if (want === have) return 0;
  if (have.startsWith(want)) return 1;
  const words = wordsOf(name);
  return wordsOf(tag).every((part) => words.some((word) => word.startsWith(part))) ? 2 : null;
}

/** Every directive in these departments the tag names at its best closeness. */
function matches(tag: string, known: Known, depts: readonly Department[]): Hit[] {
  let best: number | null = null;
  let hits: Hit[] = [];
  for (const dept of depts) {
    for (const name of known[dept]) {
      const score = closeness(tag, name);
      if (score === null || (best !== null && score > best)) continue;
      if (best === null || score < best) {
        best = score;
        hits = [];
      }
      hits.push({ dept, name });
    }
  }
  return hits;
}

function either(hits: readonly Hit[]): string {
  // Past three, the list is longer than the field, and the fix is the same: type more.
  if (hits.length > 3) return `any of ${hits.length} directives`;
  const oneDept = hits.every((hit) => hit.dept === hits[0]?.dept);
  const names = hits.map((hit) => (oneDept ? hit.name : `${hit.dept.toLowerCase()} ${hit.name}`));
  return names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}

/** Read one typed line. `fallback` is the department already chosen (the + that was clicked,
 *  or the zoomed map), which a typed department word overrides. */
export function parseCapture(line: string, known: Known, fallback: Department | null, now: Ms, tz: string): Parsed {
  let words = line.split(/\s+/).filter((w) => w !== "");
  // "7 pm" is one time. Joined here so the scan below reads one word per thing.
  words = words.reduce<string[]>((out, word) => {
    const before = out.at(-1);
    if (/^(am|pm)$/i.test(word) && before !== undefined && /^\d{1,2}(:\d{2})?$/.test(before)) out[out.length - 1] = before + word;
    else out.push(word);
    return out;
  }, []);

  const typed = DEPT_WORDS.get((words[0] ?? "").toLowerCase().replace(/:$/, "")) ?? null;
  if (typed !== null) words = words.slice(1);

  const tags = words.filter((w) => w.length > 1 && w.startsWith("#")).map((w) => w.slice(1));
  if (tags.length > 1) return { problem: "one #directive at most" };
  words = words.filter((w) => !(w.length > 1 && w.startsWith("#")));
  const tag = tags[0] ?? null;
  if (tag !== null && fold(tag) === "") return { problem: "a #directive needs a name" };

  // When is read from the end backwards, so "at 7pm fri" and "fri at 7pm" are the same.
  const today = noteDay(now, tz);
  let day: string | null = null;
  let clock: string | null = null;
  let daily = false;
  for (;;) {
    const last = (words.at(-1) ?? "").toLowerCase();
    const before = (words.at(-2) ?? "").toLowerCase();
    if (clock === null && readClock(last) !== null && (before === "at" || /[ap]m$/.test(last))) {
      clock = readClock(last);
      words = words.slice(0, before === "at" ? -2 : -1);
      continue;
    }
    if (day === null && !daily) {
      if (last === "daily" || (last === "day" && before === "every")) {
        daily = true;
        words = words.slice(0, last === "daily" ? -1 : -2);
        continue;
      }
      const read = readDay(last, today);
      if (read !== null && "problem" in read) return read;
      if (read !== null) {
        day = read.day;
        words = words.slice(0, DAY_LEADS.has(before) ? -2 : -1);
        continue;
      }
    }
    break;
  }
  if (daily && clock !== null) return { problem: "a daily has no time of day" };
  const when: When =
    daily ? { kind: "daily" }
    : clock !== null ? { kind: "event", at: `${day ?? today} ${clock}` }
    : { kind: "todo", due: day };

  const text = words.join(" ");
  if (text === "") return { problem: "a todo needs some words" };

  let dept = typed;
  let project: string | null = null;
  if (tag !== null) {
    // A typed department is final. Otherwise the chosen department is asked first, and the
    // whole board only when it has nothing by that name, so #lisbon finds Life from anywhere.
    let hits = typed !== null ? matches(tag, known, [typed]) : fallback !== null ? matches(tag, known, [fallback]) : [];
    if (hits.length === 0 && typed === null) hits = matches(tag, known, DEPARTMENTS);
    const hit = hits[0];
    if (hits.length > 1) return { problem: `#${tag} could be ${either(hits)}` };
    if (hit !== undefined) {
      dept = hit.dept;
      project = hit.name;
    } else {
      // A heading has spaces and a tag cannot, so #home-office starts "home office".
      project = tag.replace(/[-_]+/g, " ").trim();
    }
  }
  dept ??= fallback;
  if (dept === null) return { problem: "start with work, chess, projects or life" };
  return { todo: { text, dept, project, when } };
}

function dayName(day: string, today: string): string {
  if (day === today) return "today";
  if (day === plusDays(today, 1)) return "tomorrow";
  // Noon UTC is the same calendar day in every zone fmtDate could be asked about.
  return fmtDate(ms(utcOf(day) + DAY_MS / 2), "UTC");
}

/** How a parsed line will land, in the system voice: "“book the lesson” · chess · Coaching ·
 *  due Fri 25 Sep". */
export function describe(todo: NewTodo, known: Known, now: Ms, tz: string): string {
  const today = noteDay(now, tz);
  // The title first, quoted, so what the parser kept is read before where and when it files.
  const parts: string[] = [`“${todo.text}”`, todo.dept.toLowerCase()];
  if (todo.project !== null) {
    parts.push(known[todo.dept].includes(todo.project) ? todo.project : `new directive ${todo.project}`);
  }
  const when = todo.when;
  if (when.kind === "daily") parts.push("every day");
  else if (when.kind === "event") parts.push(`${dayName(when.at.slice(0, 10), today)} ${when.at.slice(11)}`);
  else parts.push(when.due === null ? "no date" : `due ${dayName(when.due, today)}`);
  return parts.join(" · ");
}
