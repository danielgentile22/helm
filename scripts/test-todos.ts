// Job-TODO logic (lib/todos.ts) — parse/toggle/add/sanitize pure functions.
// Run: npx -y tsx scripts/test-todos.ts
import { addTodo, cleanTodoText, parseTodos, toggleTodo } from "../lib/todos";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const eq = (got: unknown, want: unknown, msg: string) =>
  got === want ? pass(msg) : fail(`${msg}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

const MD = `---
title: Job TODOs
---
# Job TODOs

## 1. Honesty gates
- [ ] Build the **Morphy** feature
- [x] Deploy [[Chess Database Platform]] to Render

Some prose that is not a todo.
- a plain bullet, also not a todo

## Inbox
- [ ] email recruiter
`;

// --- parse -------------------------------------------------------------------
{
  const items = parseTodos(MD);
  eq(items.length, 3, "parse: finds exactly the checkbox lines (prose/bullets/frontmatter ignored)");
  eq(items[0].text, "Build the Morphy feature", "parse: strips ** markers");
  eq(items[0].done, false, "parse: '[ ]' → open");
  eq(items[1].text, "Deploy Chess Database Platform to Render", "parse: strips [[wikilink]] brackets");
  eq(items[1].done, true, "parse: '[x]' → done");
  eq(items[0].section, "1. Honesty gates", "parse: item gets nearest ## heading");
  eq(items[2].section, "Inbox", "parse: section resets at each heading");
  eq(items[2].index, 2, "parse: index is checkbox ordinal");
}
check(parseTodos("- [X] shouty").length === 1 && parseTodos("- [X] shouty")[0].done, "parse: capital X counts as done");

// --- toggle ------------------------------------------------------------------
{
  const items = parseTodos(MD);
  const next = toggleTodo(MD, 0, items[0].text, true);
  check(next !== null && next.includes("- [x] Build the **Morphy** feature"), "toggle: checks the raw line, markers intact");
  check(next !== null && next.includes("- [ ] email recruiter"), "toggle: other items untouched");
  const back = toggleTodo(next!, 1, items[1].text, false);
  check(back !== null && back.includes("- [ ] Deploy [[Chess Database Platform]] to Render"), "toggle: unchecking works");
}
eq(toggleTodo(MD, 0, "stale text from before an edit", true), null, "toggle: text mismatch → null (409, not wrong item)");
eq(toggleTodo(MD, 99, "email recruiter", true), null, "toggle: out-of-range index → null");

// --- add ---------------------------------------------------------------------
{
  const next = addTodo(MD, "follow up with recruiter X");
  check(next.endsWith("- [ ] follow up with recruiter X\n"), "add: appends open item at end (lands under ## Inbox)");
  eq(parseTodos(next).length, 4, "add: round-trips through parse");
  check(addTodo("# Job TODOs\n", "first").includes("- [ ] first"), "add: works on a fresh file");
}

// --- sanitize (trust boundary: newlines inject fake lines/headings) -----------
eq(cleanTodoText("  hi\nthere\r\n## fake heading  "), "hi there ## fake heading", "clean: newlines collapsed to spaces");
eq(cleanTodoText(42), "", "clean: non-string → rejected");
eq(cleanTodoText("   "), "", "clean: whitespace-only → rejected");
eq(cleanTodoText("x".repeat(400)).length, 300, "clean: capped at 300 chars");

if (failed) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nall todo tests passed");
