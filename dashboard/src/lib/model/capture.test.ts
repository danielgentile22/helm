import assert from "node:assert/strict";
import test from "node:test";

import { describe, knownDirectives, parseCapture } from "./capture";
import { ms, thingId, todoId } from "./types";
import type { Known, NewTodo, Parsed } from "./capture";
import type { Department, Thing } from "./types";

const TZ = "America/New_York";
// A Wednesday morning.
const NOW = ms(Date.parse("2026-09-23T10:00:00-04:00"));

const KNOWN: Known = {
  Work: ["Consulting", "Launch"],
  Chess: ["1.e4 e5 course", "Camps", "Coaching"],
  Projects: ["Compiler", "orbit"],
  Life: ["Cars", "Health", "Home office", "Lisbon trip"],
};

function parse(line: string, fallback: Department | null = null, known: Known = KNOWN): Parsed {
  return parseCapture(line, known, fallback, NOW, TZ);
}

function todo(line: string, fallback: Department | null = null): NewTodo {
  const out = parse(line, fallback);
  if ("problem" in out) throw new Error(`${line}: ${out.problem}`);
  return out.todo;
}

const due = (line: string): string | null => {
  const when = todo(line).when;
  return when.kind === "todo" ? when.due : `not a todo: ${when.kind}`;
};

test("a leading department word files it, and the rest is the text", () => {
  assert.deepEqual(todo("work send the   deck"), {
    text: "send the deck", dept: "Work", project: null, when: { kind: "todo", due: null },
  });
  assert.equal(todo("CHESS book the camp").dept, "Chess");
  assert.equal(todo("project fix the build").dept, "Projects");
  assert.equal(todo("projects: fix the build").dept, "Projects");
  assert.equal(todo("Life buy milk").dept, "Life");
});

test("a department word anywhere but first is just a word", () => {
  assert.equal(todo("finish work email", "Life").text, "finish work email");
  assert.equal(todo("finish work email", "Life").dept, "Life");
});

test("the chosen department stands until a typed one overrides it", () => {
  assert.equal(todo("buy milk", "Chess").dept, "Chess");
  assert.equal(todo("life buy milk", "Chess").dept, "Life");
});

test("no department anywhere is a problem that says how to give one", () => {
  assert.deepEqual(parse("buy milk"), { problem: "start with work, chess, projects or life" });
  assert.deepEqual(parse("constructor buy milk"), { problem: "start with work, chess, projects or life" });
});

test("a todo needs words once the department, directive and date are taken out", () => {
  assert.deepEqual(parse(""), { problem: "a todo needs some words" });
  assert.deepEqual(parse("chess"), { problem: "a todo needs some words" });
  assert.deepEqual(parse("chess #coaching tomorrow at 7pm"), { problem: "a todo needs some words" });
});

test("a tag names a directive by its start or by its words, whatever the case", () => {
  assert.equal(todo("#lisbon book the hotel").project, "Lisbon trip");
  assert.equal(todo("#Coaching analyse the games").project, "Coaching");
  assert.equal(todo("#e4 record the intro").project, "1.e4 e5 course");
  assert.equal(todo("#1e4 record the intro").project, "1.e4 e5 course");
  assert.equal(todo("#office buy the chair").project, "Home office");
  assert.equal(todo("#home-office order the desk").project, "Home office");
});

test("a tag without a department word takes the department of the one directive it names", () => {
  assert.equal(todo("#lisbon book the hotel").dept, "Life");
  assert.equal(todo("#lisbon book the hotel", "Chess").dept, "Life");
});

test("the tag can sit anywhere in the line", () => {
  const out = todo("book the #lisbon hotel fri");
  assert.equal(out.text, "book the hotel");
  assert.equal(out.project, "Lisbon trip");
  assert.deepEqual(out.when, { kind: "todo", due: "2026-09-25" });
});

test("the chosen department is asked first, then the whole board", () => {
  assert.equal(todo("#c fix the importer", "Projects").project, "Compiler");
  assert.equal(todo("#ca pay the deposit", "Chess").project, "Camps");
});

test("a tag that names more than one directive says which ones", () => {
  assert.deepEqual(parse("#c pay", "Chess"), { problem: "#c could be Camps or Coaching" });
  assert.deepEqual(parse("#ca pay"), { problem: "#ca could be chess Camps or life Cars" });
  assert.deepEqual(parse("#o pay", null, { ...KNOWN, Life: ["Ottoman", "Orchard"] }), {
    problem: "#o could be projects orbit, life Ottoman or life Orchard",
  });
  assert.deepEqual(parse("#c pay"), { problem: "#c could be any of 5 directives" });
});

test("the name itself beats a name it starts", () => {
  const known: Known = { ...KNOWN, Life: ["Car", "Cars"] };
  const out = parse("#car wash it", "Life", known);
  assert.ok("todo" in out);
  assert.equal(out.todo.project, "Car");
});

test("a typed department is final, so a tag it does not have starts a new directive there", () => {
  const out = todo("work #lisbon plan the offsite");
  assert.equal(out.dept, "Work");
  assert.equal(out.project, "lisbon");
});

test("an unknown tag starts a directive named as typed, dashes read as spaces", () => {
  assert.equal(todo("life #visa-renewal file the forms").project, "visa renewal");
  assert.equal(todo("life #Visa file the forms").project, "Visa");
});

test("one directive at most, and it needs a name", () => {
  assert.deepEqual(parse("life #cars #daniel wash"), { problem: "one #directive at most" });
  assert.deepEqual(parse("life #-- wash"), { problem: "a #directive needs a name" });
  assert.equal(todo("life pay # 3 invoice").text, "pay # 3 invoice");
});

test("day words at the end set the due date, counted from today in the model's zone", () => {
  assert.equal(due("life call today"), "2026-09-23");
  assert.equal(due("life call tomorrow"), "2026-09-24");
  assert.equal(due("life call Tomorrow"), "2026-09-24");
  assert.equal(due("life call fri"), "2026-09-25");
  assert.equal(due("life call friday"), "2026-09-25");
  assert.equal(due("life call mon"), "2026-09-28");
  assert.equal(due("life call thurs"), "2026-09-24");
  assert.equal(due("life call 2026-10-02"), "2026-10-02");
  assert.equal(due("life call 9/30"), "2026-09-30");
  assert.equal(due("life call 12/1/27"), "2027-12-01");
});

test("a weekday is the next one ahead, and today only counts as the word today", () => {
  assert.equal(due("life call wed"), "2026-09-30");
});

test("a month and day already gone this year is next year's", () => {
  assert.equal(due("life renew 1/5"), "2027-01-05");
  assert.equal(due("life renew 9/23"), "2026-09-23");
});

test("a day that does not exist is a problem, not text", () => {
  assert.deepEqual(parse("life renew 2/30"), { problem: "no such day 2/30" });
  assert.deepEqual(parse("life renew 2026-13-01"), { problem: "no such day 2026-13-01" });
});

test("on, by and due before the day are part of the date", () => {
  assert.equal(todo("life call the bank by fri").text, "call the bank");
  assert.equal(todo("work report due 9/30").text, "report");
  assert.equal(todo("work lunch on mon").text, "lunch");
});

test("a day word in the middle of the line stays in the text", () => {
  const out = todo("life call sunday school back");
  assert.equal(out.text, "call sunday school back");
  assert.deepEqual(out.when, { kind: "todo", due: null });
});

test("today is the zone's today, not the host's", () => {
  const lateEvening = ms(Date.parse("2026-09-24T02:00:00Z"));
  const out = parseCapture("life call tomorrow", KNOWN, null, lateEvening, TZ);
  assert.ok("todo" in out);
  assert.deepEqual(out.todo.when, { kind: "todo", due: "2026-09-24" });
});

test("daily and every day make a daily", () => {
  assert.deepEqual(todo("chess twenty minutes of tactics daily").when, { kind: "daily" });
  assert.deepEqual(todo("chess twenty minutes of tactics every day").when, { kind: "daily" });
  assert.equal(todo("chess twenty minutes of tactics every day").text, "twenty minutes of tactics");
});

test("a time makes an event, on the day given or today", () => {
  assert.deepEqual(todo("chess coaching session fri at 7pm").when, { kind: "event", at: "2026-09-25 19:00" });
  assert.deepEqual(todo("chess coaching session at 7pm fri").when, { kind: "event", at: "2026-09-25 19:00" });
  assert.deepEqual(todo("chess coaching session at 19:00 tomorrow").when, { kind: "event", at: "2026-09-24 19:00" });
  assert.deepEqual(todo("life dentist at 7:30 pm").when, { kind: "event", at: "2026-09-23 19:30" });
  assert.deepEqual(todo("life call mom 6pm").when, { kind: "event", at: "2026-09-23 18:00" });
  assert.deepEqual(todo("life breakfast at 12am").when, { kind: "event", at: "2026-09-23 00:00" });
  assert.deepEqual(todo("life lunch at 12pm").when, { kind: "event", at: "2026-09-23 12:00" });
  assert.equal(todo("chess coaching session fri at 7pm").text, "coaching session");
});

test("a bare number or an impossible time is not a time", () => {
  const out = todo("life meet at 7");
  assert.equal(out.text, "meet at 7");
  assert.deepEqual(out.when, { kind: "todo", due: null });
  assert.equal(todo("life meet at 25:00").text, "meet at 25:00");
  assert.equal(todo("life read 19:00").text, "read 19:00");
});

test("a daily has no time of day", () => {
  assert.deepEqual(parse("chess tactics daily at 7pm"), { problem: "a daily has no time of day" });
});

test("the preview echoes the title, then names the department, the directive and when", () => {
  const view = (line: string, fallback: Department | null = null): string => describe(todo(line, fallback), KNOWN, NOW, TZ);
  assert.equal(view("#coaching book the lesson fri"), "“book the lesson” · chess · Coaching · due Fri 25 Sep");
  assert.equal(view("life buy milk"), "“buy milk” · life · no date");
  assert.equal(view("life buy milk today"), "“buy milk” · life · due today");
  assert.equal(view("life #visa file the forms tomorrow"), "“file the forms” · life · new directive visa · due tomorrow");
  assert.equal(view("chess tactics daily"), "“tactics” · chess · every day");
  assert.equal(view("chess coaching at 7pm tomorrow"), "“coaching” · chess · tomorrow 19:00");
  assert.equal(view("chess coaching at 7pm 10/2"), "“coaching” · chess · Fri 2 Oct 19:00");
});

test("the known directives are each department's filed names, once each, sorted", () => {
  const base = {
    kind: "todo" as const, todoId: todoId("0123456789ab"), label: "x", at: null, due: null, since: ms(0),
    doneToday: false, notes: "", subs: [], path: "p", line: 1, doneWhen: null,
  };
  const things: Thing[] = [
    { ...base, id: thingId("todo:a"), dept: "Life", project: "Lisbon trip" },
    { ...base, id: thingId("todo:b"), dept: "Life", project: "Cars" },
    { ...base, id: thingId("todo:c"), dept: "Life", project: "Cars" },
    { ...base, id: thingId("todo:d"), dept: "Chess", project: null },
    { kind: "job", id: thingId("routine:x"), dept: "Work", label: "x", at: ms(0), schedule: "", path: "" },
  ];
  assert.deepEqual(knownDirectives(things), { Work: [], Chess: [], Projects: [], Life: ["Cars", "Lisbon trip"] });
});
