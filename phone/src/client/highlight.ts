/** Search snippet highlighting. Pure, no DOM. The server sends valid, in-bounds offsets; only overlap is resolved here. */

import { mergeRanges, type MatchRange } from "../shared/protocol";

export interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

export function segments(text: string, ranges: readonly MatchRange[]): readonly Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, stop] of mergeRanges(ranges)) {
    const end = Math.min(stop, text.length);
    if (start >= end) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
