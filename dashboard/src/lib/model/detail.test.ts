import assert from "node:assert/strict";
import test from "node:test";

import { FLOW_NOTE_LINES, NO_DETAIL, flowDetail, predLine, progress, whenLine } from "./detail";
import { ms } from "./types";
import type { LeadContent } from "./detail";

const bare: LeadContent = { notes: "", subs: [], doneWhen: null };
const full: LeadContent = {
  notes: "Module 1 of the onboarding track. The certificate uploads to the HR portal.",
  subs: [{ text: "Watch sections 5 to 7", done: true }, { text: "Take the quiz", done: false }, { text: "Upload the certificate", done: false }],
  doneWhen: { predicate: "lab verdict written", ok: true, checked: null, detail: "verdict.md exists" },
};

test("the phone gets a short look: clamped notes and the progress, never the list", () => {
  assert.deepEqual(flowDetail(full), { noteLines: FLOW_NOTE_LINES, subs: "count", doneWhen: false });
  assert.deepEqual(flowDetail({ ...bare, doneWhen: full.doneWhen }), NO_DETAIL);
});

test("progress counts ticked subtasks, and nothing when there are none", () => {
  assert.equal(progress([]), null);
  assert.deepEqual(progress(full.subs), { done: 1, total: 3 });
});

test("the done-when line reads the same as the drawer's", () => {
  assert.equal(predLine({ predicate: "lab verdict written", ok: true, checked: null, detail: "verdict.md exists" }), "done when lab verdict written: verdict.md exists");
});

test("the drawer's full date is left off when the reason already names the day", () => {
  const TZ = "America/New_York";
  const fri = ms(Date.parse("2026-09-25T17:00:00-04:00"));
  assert.equal(whenLine("Fri 25 Sep", fri, TZ), "");
  assert.equal(whenLine("Fri 25 Sep 7:00 PM", fri, TZ), "");
  assert.equal(whenLine("tomorrow", fri, TZ), "Fri 25 Sep 17:00");
  assert.equal(whenLine("2d late", fri, TZ), "Fri 25 Sep 17:00");
  assert.equal(whenLine("no date", null, TZ), "");
});
