import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtRelative } from "./format";

/** Monday, midday UTC, so no branch flips on the test machine's timezone. */
const now = new Date("2026-08-10T12:00:00.000Z");
const ago = (secs: number): string => new Date(now.getTime() - secs * 1000).toISOString();

const SEC = 1;
const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

test("anything under a minute, or in the future, reads as now", () => {
  assert.equal(fmtRelative(ago(0), now), "now");
  assert.equal(fmtRelative(ago(59 * SEC), now), "now");
  assert.equal(fmtRelative(ago(-30 * MIN), now), "now");
});

test("minutes from one up to the hour", () => {
  assert.equal(fmtRelative(ago(60 * SEC), now), "1m");
  assert.equal(fmtRelative(ago(12 * MIN + 45 * SEC), now), "12m");
  assert.equal(fmtRelative(ago(59 * MIN), now), "59m");
});

test("hours from one up to the day", () => {
  assert.equal(fmtRelative(ago(60 * MIN), now), "1h");
  assert.equal(fmtRelative(ago(3 * HOUR + 50 * MIN), now), "3h");
  assert.equal(fmtRelative(ago(23 * HOUR), now), "23h");
});

test("a day up to a week reads as the short weekday", () => {
  assert.equal(fmtRelative(ago(24 * HOUR), now), "Sun");
  assert.equal(fmtRelative(ago(6 * DAY), now), "Tue");
});

test("a week or older reads as the month and day", () => {
  assert.equal(fmtRelative(ago(7 * DAY), now), "Aug 3");
  assert.equal(fmtRelative(ago(8 * DAY), now), "Aug 2");
  assert.equal(fmtRelative("2025-12-25T12:00:00.000Z", now), "Dec 25");
});
