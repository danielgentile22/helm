// How many rows fit in a fixed height, pure. The map itself no longer measures boxes: a
// department and a directive are as tall as their content (ADR 0026). The week band is the
// one place a crowded board can squeeze, so each of its day columns asks this how many rows
// it shows once it has less than it asked for.

/** How many rows of height rowH fit in room, and how many are left over. When they do not
 *  all fit, the last line that fits says "+N more" instead of a row, so nothing is cut off
 *  silently. With under two lines of room the count rides on the name line instead
 *  (`inline`) and every line goes to rows. A cell whose lead is already its top thing may
 *  show no rows at all; any other cell keeps its top row (`least`), since a name and a
 *  count alone would hide what it is. */
export function fitRows(
  count: number, room: number, rowH: number, least: 0 | 1 = 1,
): { shown: number; more: number; inline: boolean } {
  const lines = Math.max(0, Math.floor(room / rowH));
  if (count <= lines) return { shown: count, more: 0, inline: false };
  const inline = lines < 2;
  const shown = Math.min(count, inline ? Math.max(least, lines) : lines - 1);
  return { shown, more: count - shown, inline };
}
