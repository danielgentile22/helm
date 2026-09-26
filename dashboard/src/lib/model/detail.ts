// What a lead shows under its title, pure. The map sizes cells to their content now, so a
// lead no longer grows detail to fill a box: the loudest tier shows the short look below,
// the same one the phone uses, and the drawer has the rest.

import { fmtDate, fmtDateTime } from "./time";
import type { DoneWhen, Ms, Sub } from "./types";

/** The parts of a lead the detail block reads. A lead with none of them shows nothing. */
export type LeadContent = { notes: string; subs: readonly Sub[]; doneWhen: DoneWhen | null };

export type LeadDetail = {
  /** How many lines of notes to show before the ellipsis. 0 hides them. */
  noteLines: number;
  /** The subtasks as a list under their progress, as the progress alone, or not at all. */
  subs: "list" | "count" | null;
  doneWhen: boolean;
};

export const NO_DETAIL: LeadDetail = { noteLines: 0, subs: null, doneWhen: false };

/** A lead gets a short look and never the list. */
export const FLOW_NOTE_LINES = 2;

export type Progress = { done: number; total: number };

/** Subtasks ticked out of all of them, or null when there are none to count. */
export function progress(subs: readonly Sub[]): Progress | null {
  if (subs.length === 0) return null;
  return { done: subs.filter((s) => s.done).length, total: subs.length };
}

/** The done-when line, worded once for the map and the drawer alike. */
export function predLine(dw: DoneWhen): string {
  return `done when ${dw.predicate}: ${dw.detail}`;
}

function empty(lead: LeadContent): boolean {
  return lead.notes.trim() === "" && lead.subs.length === 0 && lead.doneWhen === null;
}

/** The short look: two lines of notes and the subtask progress, never everything the
 *  drawer has. */
export function flowDetail(lead: LeadContent): LeadDetail {
  if (empty(lead)) return NO_DETAIL;
  return { ...NO_DETAIL, noteLines: lead.notes.trim() === "" ? 0 : FLOW_NOTE_LINES, subs: lead.subs.length > 0 ? "count" : null };
}

/** The drawer's full date beside the reason, or nothing when the reason already names the
 *  day: "Fri 25 Sep" is not followed by "Fri 25 Sep 17:00". "tomorrow" or "5h late" still
 *  get the date they stand for. */
export function whenLine(reason: string, at: Ms | null, tz: string): string {
  if (at === null || reason.includes(fmtDate(at, tz))) return "";
  return fmtDateTime(at, tz);
}
