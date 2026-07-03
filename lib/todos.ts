import fs from "fs";
import path from "path";
import { VAULT_ROOT } from "./config";
import { atomicWriteFileSync } from "./atomicWrite";

// ---------------------------------------------------------------------------
// Job-search TODO list — one markdown file, <vault>/jobs/todos.md, is the
// database. `- [ ]` / `- [x]` lines are the items; `##` headings group them.
// Obsidian edits and HUD edits act on the same file (seeded 2026-07-03 from
// Atlas/Projects/Interview Readiness.md — see CONTEXT.md "Seed").
// Pure functions here, unit-tested in scripts/test-todos.ts; the /api/todos
// route adds auth + IO glue.
// ---------------------------------------------------------------------------

export interface TodoItem {
  /** ordinal among checkbox lines — the toggle handle */
  index: number;
  /** display text — wikilink/bold markers stripped */
  text: string;
  done: boolean;
  /** nearest `##` heading above, "" if none */
  section: string;
}

export const TODOS_REL = "jobs/todos.md";
const TODOS_ABS = path.join(VAULT_ROOT, "jobs", "todos.md");
const CHECKBOX = /^- \[( |x|X)\] (.*)$/;

export function parseTodos(md: string): TodoItem[] {
  const items: TodoItem[] = [];
  let section = "";
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const m = line.match(CHECKBOX);
    if (!m) continue;
    items.push({
      index: items.length,
      done: m[1] !== " ",
      text: m[2].replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\*\*/g, "").trim(),
      section,
    });
  }
  return items;
}

/** Set checkbox #index to `done`. Returns null when index/text no longer
 *  match the file — a concurrent Obsidian edit moved the lines; the route
 *  answers 409 and the HUD refetches instead of toggling the wrong item. */
export function toggleTodo(md: string, index: number, text: string, done: boolean): string | null {
  const items = parseTodos(md);
  if (!items[index] || items[index].text !== text) return null;
  const lines = md.split(/\r?\n/);
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX);
    if (m && ++n === index) {
      lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
      return lines.join("\n");
    }
  }
  return null;
}

/** Append a new open item at the end of the file (the seed keeps a trailing
 *  `## Inbox` section, so manual adds land there). */
export function addTodo(md: string, text: string): string {
  return md.replace(/\s*$/, "") + `\n- [ ] ${text}\n`;
}

/** Sanitize user text at the trust boundary: newlines would inject fake
 *  checkbox lines or headings into the file. "" = reject. */
export function cleanTodoText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function readTodosFile(): string | null {
  try {
    return fs.readFileSync(TODOS_ABS, "utf-8");
  } catch {
    return null;
  }
}

export function writeTodosFile(md: string): void {
  fs.mkdirSync(path.dirname(TODOS_ABS), { recursive: true });
  atomicWriteFileSync(TODOS_ABS, md);
}
