import type { Checks, Tracker } from "../lib/api";
import type { Tone } from "../ui/Dot.svelte";

export const checksTone: Record<Checks, Tone> = { pass: "pass", fail: "fail", pending: "pending", none: "off" };

export const checksLabel: Record<Checks, string> = {
  pass: "checks passing",
  fail: "checks failing",
  pending: "checks running",
  none: "no checks",
};

export const trackerLabel: Record<Tracker, string> = {
  github: "GitHub Issues",
  scratch: "local tracker",
  none: "no tracker",
};
