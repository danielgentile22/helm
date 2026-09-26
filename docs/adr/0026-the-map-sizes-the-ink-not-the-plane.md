# The map sizes the ink, not the plane

The four departments keep their corners, but no box is sized by pressure any more. A
department and a directive cell are as tall as what is in them. Pressure is carried by
the ink instead: the lead's title steps through four sizes by pull, a rail beside every
department and directive is as long as its pull with the reason in words next to it,
and the loudest cells sit on a lighter plane. The height the boxes do not use becomes
one band between the two rows that holds the week. Decided 2026-09-23. This replaces
the "area is attention" consequence of ADR 0024; the rest of 0017 stands.

A critique of the live map on 2026-09-23 (`dashboard/.impeccable/critique/`) scored it
25 of 40. With the five todos Daniel actually has, the treemap gave Projects 56% of the
screen for one late chore and left the directive planes 69% empty. The same code on a
twenty todo fixture filled its cells and looked finished. Area only reads as a message
when there is enough on the board for the differences to mean something, and the board
is usually small. That is the Observatory's failure again: designed against a busy
fixture, shipped into a quiet week.

Three directions were weighed: size the ink (this one), switch layouts by density (a
ranked list under about twelve open items, the treemap above), and cap each box at what
its content needs. Daniel chose the first. It was prototyped as variant
`6-size-the-ink` in `dashboard/prototypes/improvements/` against his live board and the
busy fixture, on desktop and phone, before it was ported.

## Consequences

- **`src/lib/model/ink.ts` replaces the rectangle maths.** It holds the lead tiers
  (pull of 3, 2 and 0.9 and above), the rail segments and their one board wide scale,
  and the week the band draws. `layout.ts` keeps only `fitRows`, which the band's day
  columns use, and the room-fitting lead detail in `detail.ts` is gone with the boxes
  it measured.
- **The spare height is the week, not nothing.** A late column, today and six days,
  each ruled to the bottom row so an empty day reads as an empty day. With nothing late
  and nothing due today the band leads with that sentence and the next thing coming.
- **Busy boards shrink before they scroll.** The map tries full size, then one line
  rows, then smaller leads, and only a board that fits none of those scrolls.
- **Titles are Instrument Sans, data stays JetBrains Mono.** Both are self-hosted woff2
  files under `src/styles/fonts/` with their licences. The one machine face rule of the
  old `DESIGN.md` is retired: what Daniel wrote is set in the sans, what the system
  measured is set in the mono.
- **Rectangles no longer animate.** The map reflows instead of settling, which removes
  the only motion `DESIGN.md` allowed besides a voice turn.
- **2026-09-23, same day: the band fits its content, and the leftover falls to the foot.**
  The second critique found the full height band was mostly empty ruling on a quiet week
  (five todos drew half a screen of blank columns) and that it repeated what the map
  already showed. The band is now as tall as its busiest column plus a small floor, the
  bottom row follows it directly, and the height nobody needs falls below the bottom row
  at the page's foot. The four corners keep their left and right, top and bottom order;
  they no longer pin to the screen's floor. Two or more empty days in a row fold into one
  column that names the span ("Sat 26 to Tue 29", "clear"), while today keeps its own
  column and its bone rule. The late column counts what is already drawn on the map by
  department ("▲ 1 late · Projects") and lists by name only what the map does not show.
  A crowded board still squeezes the band toward its floor before the ink shrinks, and
  only then scrolls. On the phone the week is a page of its own after the four
  departments rather than repeated under each one.
