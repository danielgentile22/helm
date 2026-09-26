import assert from "node:assert/strict";
import test from "node:test";

import { fmtDate, fmtDateTime, lateFor, midnightsFrom, noteDay, openFor } from "./time";
import { ms } from "./types";

const TZ = "America/New_York";
const HOUR_MS = 3_600_000;

test("the midnights ahead are local midnights, not now plus a day", () => {
  const now = ms(Date.parse("2026-09-17T12:00:00-04:00"));
  assert.deepEqual(midnightsFrom(now, TZ, 2),
                   [Date.parse("2026-09-18T00:00:00-04:00"), Date.parse("2026-09-19T00:00:00-04:00")]);
});

test("midnight itself counts as ahead", () => {
  const now = ms(Date.parse("2026-09-18T00:00:00-04:00"));
  assert.equal(midnightsFrom(now, TZ, 1)[0], now);
});

test("the day the clocks go back is 25 hours long and still has one midnight", () => {
  const now = ms(Date.parse("2026-10-31T12:00:00-04:00"));
  const out = midnightsFrom(now, TZ, 3);
  assert.deepEqual(out, [
    Date.parse("2026-11-01T00:00:00-04:00"),
    Date.parse("2026-11-02T00:00:00-05:00"),
    Date.parse("2026-11-03T00:00:00-05:00"),
  ]);
  assert.equal((out[1] ?? 0) - (out[0] ?? 0), 25 * HOUR_MS);
  assert.equal((out[2] ?? 0) - (out[1] ?? 0), 24 * HOUR_MS);
});

test("a date reads weekday, day, month, on the model's timezone", () => {
  assert.equal(fmtDate(ms(Date.parse("2026-09-17T12:00:00-04:00")), TZ), "Thu 17 Sep");
  assert.equal(fmtDate(ms(Date.parse("2026-09-01T09:00:00-04:00")), TZ), "Tue 1 Sep");
});

test("a date is read in the model's timezone, not the host's", () => {
  assert.equal(fmtDate(ms(Date.parse("2026-09-18T03:00:00Z")), TZ), "Thu 17 Sep");
});

test("a job's time runs on a 24 hour clock, with the hour padded", () => {
  assert.equal(fmtDateTime(ms(Date.parse("2026-09-21T20:20:00-04:00")), TZ), "Mon 21 Sep 20:20");
  assert.equal(fmtDateTime(ms(Date.parse("2026-09-21T08:05:00-04:00")), TZ), "Mon 21 Sep 08:05");
  assert.equal(fmtDateTime(ms(Date.parse("2026-09-21T00:00:00-04:00")), TZ), "Mon 21 Sep 00:00");
});

test("an open todo says how long it has been open, never how late it is", () => {
  assert.equal(openFor(3 * 86_400_000), "open 3d");
  assert.equal(openFor(5 * 60_000), "open 5m");
  assert.equal(openFor(0), "open 0m");
  assert.notEqual(openFor(3 * 86_400_000), lateFor(3 * 86_400_000));
});

test("a note day is the calendar day in the model's timezone", () => {
  assert.equal(noteDay(ms(Date.parse("2026-09-24T02:00:00Z")), TZ), "2026-09-23");
  assert.equal(noteDay(ms(Date.parse("2026-09-24T04:00:00Z")), TZ), "2026-09-24");
});

test("lateFor counts hours inside the first day and days after it", () => {
  assert.equal(lateFor(3 * 3_600_000), "3h late");
  assert.equal(lateFor(27 * 3_600_000), "1d late");
  assert.equal(lateFor(50 * 3_600_000), "2d late");
});
