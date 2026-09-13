/** Search snippet highlighting. Pure, no DOM. */

type Span = readonly [number, number];

export interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

/** Clamped, sorted, non-empty, non-overlapping. Adjacent spans stay separate: touching is not overlapping. */
function normalize(text: string, ranges: readonly Span[]): Span[] {
  const clamped: Span[] = [];
  for (const [start, end] of ranges) {
    const s = Math.min(Math.max(start, 0), text.length);
    const e = Math.min(Math.max(end, 0), text.length);
    if (s < e) clamped.push([s, e]);
  }
  clamped.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged: Span[] = [];
  for (const span of clamped) {
    const last = merged[merged.length - 1];
    if (last && span[0] < last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], span[1])];
    else merged.push(span);
  }
  return merged;
}

export function segments(text: string, ranges: readonly Span[]): readonly Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of normalize(text, ranges)) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
