// The glyph a thing wears, and what the header says about capture health. Pure.

import type { Freshness, Ms, Phase, Source, Thing } from "./types";

const TROUBLE: readonly { state: Freshness["state"]; word: string }[] = [
  { state: "failed", word: "failing" },
  { state: "never", word: "never produced" },
  { state: "stale", word: "stale" },
];

/** What a glyph stands for, in the word a title and a screen reader give it. */
export type GlyphKind = "late" | "dated" | "undated" | "daily" | "event" | "routine";

export function glyphKind(thing: Thing, phase: Phase): GlyphKind {
  if (phase.state === "late") return "late";
  if (phase.state === "open") return "undated";
  if (phase.state === "daily") return "daily";
  if (thing.kind === "event") return "event";
  return thing.kind === "todo" ? "dated" : "routine";
}

const GLYPH: Readonly<Record<Exclude<GlyphKind, "daily">, string>> = {
  late: "▲", dated: "◆", undated: "◇", event: "▮", routine: "■",
};

/** The glyph a thing wears in a row and in the drawer: a triangle when it is late, a
 *  hollow diamond when it has no date, a circle for a daily (filled once done), a bar
 *  for an event, a filled diamond for a dated todo, a square for a routine. */
export function glyphFor(thing: Thing, phase: Phase): string {
  const kind = glyphKind(thing, phase);
  if (kind === "daily") return phase.state === "daily" && phase.done ? "●" : "○";
  return GLYPH[kind];
}

/** Mirrors runner/checks/check_freshness.py. A zero cadence means no limit, as it does there. */
export function freshness(source: Source, now: Ms): Freshness {
  if (!source.ok) {
    return { state: "failed", reason: source.reason ?? "no reason recorded", rowsFrom: source.produced };
  }
  if (source.produced === null) return { state: "never" };
  const ageMs = now - source.produced;
  const limit = 2 * source.cadenceMs;
  if (limit > 0 && ageMs > limit) return { state: "stale", ageMs };
  return { state: "fresh" };
}

/** The header's one line about capture health. Worst state wins: failed, then never, then stale. */
export function health(states: readonly Freshness["state"][]): { ok: boolean; label: string } {
  for (const { state, word } of TROUBLE) {
    const n = states.filter((s) => s === state).length;
    if (n > 0) return { ok: false, label: `${n} ${n === 1 ? "source" : "sources"} ${word}` };
  }
  return { ok: true, label: "sources ok" };
}
