# The hero is a band between two department rows

The dashboard's frame is two rows of department boxes with the hero slot in a wide
band between them: Work and Chess across the top, Projects and Life across the
bottom, each box exactly half its row. Decided 2026-09-22 after one prototype round,
over three alternatives measured against the same live data.

The frame before this one was four narrow columns around a tall centre, 236px a
side. It was built for the instrument and it starved the text. A department box
had room for about twelve characters of a title, and the title is the only thing on
the screen a human wrote. The instrument had a thousand pixels for seven items, and
on the data otto actually holds the bottom half of the disc was empty most days.
Daniel's own line was that the interface was unsatisfying and not easy to read, and
that was the whole finding: the layout traded reading for looking and got neither.

Four directions were prototyped against the real `agenda.json` and `projects.json`
at 1512 by 900, all in one page behind a switcher, and a fifth was the current
frame with only the font and contrast fixed, kept so the others could be judged
against it by clicking back:

| Direction | What it tried | Why it lost |
|---|---|---|
| Contrast and type only | lifted greys, larger sizes, frame untouched | titles still cut at ten characters; the wider mono made it worse |
| Rebalanced frame | 360px columns, wrapping titles, date lines | readable, but four corners holding one or two items each were mostly dark |
| List first | one merged agenda grouped by state, disc as a 210px token | the most readable page, and it gave up the instrument |
| **Wide hero** | two department rows, the disc in a band between them | rows run long on one line, the disc keeps its size, nothing is starved |

Wide hero won because the departments need horizontal room and the disc needs
vertical room, and stacking them gives each what it needs from the same screen.
A row of text is wide and short. A disc is square. Four tall columns fit neither.

## Consequences

- **A box is as tall as its rows.** The grid rows are `auto`, capped at 40vh with a
  scrollbar past that, and the band takes what is left with a floor that keeps the
  disc at 380px. Nothing measures a height in script. The first draft measured and
  set pixel heights with a resize observer, and it was deleted because CSS already
  knows how tall the content is.
- **Boxes are half a row, always.** A draft split the row by item count. It moved
  the centre line every time a todo was ticked, and Daniel asked for the boxes to
  start and end at the centre of the screen. Width is fixed; only height follows
  content.
- **Selection costs the hero only what the box needs.** A selected box gains one
  line per row, the file the thing is written in, and grows by that. A draft gave
  the selected box 55 percent of the screen and collapsed the disc to 236px, and
  the box was mostly dark. The instrument is the focal point until the reader
  chooses a department, and then it is still nearly the focal point.
- **The band has two text columns.** The next thing to land on the left, the
  repositories in flight on the right, 320px each. They say in words what the disc
  is drawing, on either side of it, so the redundancy in ADR 0017 sits next to the
  picture rather than in a corner. The repositories left the Projects box for good;
  at half a row they did not fit as a second column.
- **The disc labels only what it must.** In the shorter band there is no room for a
  label beside every body, so a body is labelled when it is late, hovered, or in the
  selected department, and the boxes carry the rest. This is the redundancy rule of
  ADR 0017 doing its job in the other direction.
- **The four corners rule survives.** Work is still top left and Life bottom right,
  on the boxes and on the disc, and keys 1 to 4 still select in that order. Only
  the shape of the corners changed.
- **One face, two sizes.** The same round set the whole page in JetBrains Mono, the
  face the rest of Daniel's desk uses, and lifted the two grey tones. The two voices
  in `dashboard/DESIGN.md` are now split by size and colour, not by family. That is
  recorded there, not here, because it is a design system fact rather than a
  layout decision.

The prototype page and its screenshots were throwaway and were not kept. The
finding they produced is the table above and the shipped frame.
