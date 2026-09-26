// The drawer's edit form as data. A draft is what the fields hold, in the shapes the inputs
// want; patchOf turns the difference between two drafts into the PATCH body, naming only what
// moved, so saving an untouched form writes nothing and a reworded todo keeps its date.

import { noteStamp } from "./time";
import type { Thing } from "./types";

/** When a todo lands, in the note's own terms: a due date or none, every day, or a moment
 *  written the way the note writes it ("YYYY-MM-DD HH:MM"). */
export type When = { kind: "todo"; due: string | null } | { kind: "daily" } | { kind: "event"; at: string };

/** Only the named fields are rewritten. `project: null` files the todo under no directive. */
export type TodoPatch = { text?: string; when?: When; project?: string | null };

export type WhenKind = "undated" | "due" | "daily" | "event";

/** `due` is an `<input type=date>` value and `at` a `datetime-local` one. Both are kept while
 *  the other kinds are picked, so flipping the select back and forth loses nothing. */
export type Draft = { text: string; when: WhenKind; due: string; at: string; project: string };

/** A thing that is a box on a department note, of any of the three kinds. */
export type TodoThing = Extract<Thing, { todoId: unknown }>;

export function draftOf(thing: TodoThing, tz: string): Draft {
  const at = thing.kind === "event" && thing.at !== null ? noteStamp(thing.at, tz).replace(" ", "T") : "";
  const when: WhenKind =
    thing.kind === "daily" ? "daily" : thing.kind === "event" ? "event" : thing.due !== null ? "due" : "undated";
  return { text: thing.label, when, due: thing.due ?? "", at, project: thing.project ?? "" };
}

const words = (text: string): string => text.split(/\s+/).filter((w) => w !== "").join(" ");

function whenOf(draft: Draft): When | string {
  switch (draft.when) {
    case "undated":
      return { kind: "todo", due: null };
    case "due":
      return draft.due === "" ? "pick a due date" : { kind: "todo", due: draft.due };
    case "daily":
      return { kind: "daily" };
    case "event":
      return draft.at === "" ? "pick a day and time" : { kind: "event", at: draft.at.replace("T", " ") };
  }
}

/** The body to send, or the reason the form cannot be saved as it stands. */
export function patchOf(was: Draft, now: Draft): { patch: TodoPatch } | { problem: string } {
  const text = words(now.text);
  if (text === "") return { problem: "a todo needs some words" };
  const when = whenOf(now);
  if (typeof when === "string") return { problem: when };
  const patch: TodoPatch = {};
  if (text !== words(was.text)) patch.text = text;
  if (JSON.stringify(when) !== JSON.stringify(whenOf(was))) patch.when = when;
  const project = words(now.project);
  if (project !== words(was.project)) patch.project = project === "" ? null : project;
  return { patch };
}

export function isEmpty(patch: TodoPatch): boolean {
  return Object.keys(patch).length === 0;
}
