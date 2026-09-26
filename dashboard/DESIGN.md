---
name: helm dashboard
description: An ink map of one person's obligations. Four departments in their corners, each as tall as what it holds, with pull carried by how loudly the ink is set.
colors:
  void: "#06070b"
  void-2: "#0c0e15"
  plane: "#1b2130"
  plane-lit: "#283144"
  plane-hot: "#384560"
  bone: "#eeebe3"
  bone-dim: "#bcc2cd"
  bone-faint: "#9399a6"
  rule: "#1f2533"
  near: "#ffb445"
  far: "#7fd4e8"
  unstable: "#ff7a52"
  stable: "#a2d5a3"
  ash-deep: "#787e8d"
  focus: "#c9a7ff"
typography:
  lead-t1:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 580
    lineHeight: "32px"
    letterSpacing: "-.016em"
  lead-t2:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 560
    lineHeight: "27px"
    letterSpacing: "-.01em"
  lead-t3:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 540
    lineHeight: "22px"
    letterSpacing: "-.004em"
  week-calm:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 560
    lineHeight: 1.15
    letterSpacing: "-.02em"
  drawer-title:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 580
    lineHeight: 1.2
    letterSpacing: "-.014em"
  dept-name:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 620
    lineHeight: 1.1
    letterSpacing: "-.01em"
  directive-name:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.25
  row-title:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 450
    lineHeight: "19px"
  notes:
    fontFamily: "\"Instrument Sans\", system-ui, sans-serif"
    fontSize: "14.5px"
    lineHeight: 1.45
  body:
    fontFamily: "\"JetBrains Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: "\"JetBrains Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "12px"
    letterSpacing: ".02em"
    fontFeature: "\"tnum\""
  caps:
    fontFamily: "\"JetBrains Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: ".14em"
  keycap:
    fontFamily: "\"JetBrains Mono\", \"JetBrainsMono Nerd Font\", \"JetBrainsMono NFM\", ui-monospace, \"SF Mono\", Menlo, monospace"
    fontSize: "11px"
    lineHeight: "16px"
rounded:
  hair: "1px"
  xs: "2px"
  sm: "3px"
  md: "4px"
  sheet: "8px"
spacing:
  row: "3px 4px"
  cell: "11px 14px 10px"
  cell-gap: "10px"
  gutter: "32px"
  map: "16px 24px 18px"
  band: "26px 0 22px"
  header: "0 20px"
  drawer: "24px 26px"
components:
  dept-head:
    textColor: "{colors.bone}"
    typography: "{typography.dept-name}"
    height: "30px"
  cell:
    backgroundColor: "{colors.plane}"
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.md}"
    padding: "{spacing.cell}"
  cell-t2:
    backgroundColor: "{colors.plane-lit}"
    textColor: "{colors.bone}"
  cell-t1:
    backgroundColor: "{colors.plane-lit}"
    textColor: "{colors.bone}"
  cell-done:
    backgroundColor: "transparent"
    textColor: "{colors.bone-faint}"
  lead-t1:
    textColor: "{colors.bone}"
    typography: "{typography.lead-t1}"
  lead-t2:
    textColor: "{colors.bone}"
    typography: "{typography.lead-t2}"
  lead-t3:
    textColor: "{colors.bone}"
    typography: "{typography.lead-t3}"
  row:
    textColor: "{colors.bone-dim}"
    typography: "{typography.row-title}"
    rounded: "{rounded.sm}"
    padding: "{spacing.row}"
  row-hot:
    textColor: "{colors.bone}"
  row-late:
    textColor: "{colors.unstable}"
  row-rest:
    textColor: "{colors.ash-deep}"
  rail-segment:
    backgroundColor: "{colors.bone-faint}"
    rounded: "{rounded.hair}"
    height: "4px"
  rail-segment-late:
    backgroundColor: "{colors.unstable}"
  rail-segment-soon:
    backgroundColor: "{colors.near}"
  rail-segment-event:
    backgroundColor: "{colors.far}"
  star:
    textColor: "{colors.bone-faint}"
    size: "10px"
  week-item:
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.sm}"
    padding: "3px 5px"
    height: "24px"
  drawer:
    backgroundColor: "{colors.void-2}"
    textColor: "{colors.bone}"
    padding: "{spacing.drawer}"
    width: "420px"
  keycap:
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.sm}"
    padding: "0 5px"
    typography: "{typography.keycap}"
  field:
    backgroundColor: "{colors.plane}"
    textColor: "{colors.bone}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
---

# Design System: helm dashboard

## Overview

**Creative North Star: "The Ink Map"**

The map keeps its corners but no longer sizes its planes by pull, so the name moves from the pressure to where the pressure now lives: in how loudly the ink is set.

The dashboard is one screen that answers one question when Daniel sits down: what
should I work on. The four departments (Work, Chess, Projects, Life) hold their four
corners, Work and Chess hanging from the header, the week under them, Projects and Life
under the week. Each department, and each directive inside it (a thread of work such as
Job search or the 1.e4 e5 course), is exactly as tall as what it holds, and so is the
week between the rows. Pull is carried by the ink instead of the area: the size the
directive's lead is set at, a rail whose length is the pull, and the lightness of the
plane under the loudest cells. The height nobody needs falls to the page's foot, below
the bottom row, as plain ground (ADR 0019).

Everything on the map is something Daniel wrote in the vault: a todo, a daily, an
event, filed under a directive on a department note (ADR 0015). A directive heading may
carry a star and a rank, and that rank multiplies the pull of everything under it
(ADR 0020). Nothing is pulled from a calendar or a commit log. The map is a picture of
his intentions, not a report on his obligations.

The treemap this replaces sized boxes by area. With the five todos Daniel actually had,
it gave Projects most of the screen for one late chore and left its planes mostly
empty. Area only reads when the board is busy, and the board is usually quiet. The
Observatory before it failed the same way, and is archived under `archive/observatory/`
with its own design system; the palette here is still cut from it.

**Key Characteristics:**

- Near black ground, a raised plane per directive, a lit plane for a loud one.
- Boxes are as tall as their content. Pull is the lead's size, the rail's length and
  the plane's lightness, never the box's area.
- Every number stands beside its reason in words. "3 late", "tomorrow", "daily, not
  yet". The map never shows a bare score.
- Shape and word carry state; hue is never alone.
- Two faces: Instrument Sans for what Daniel wrote, JetBrains Mono for what the system
  measured.
- Nothing is stretched to fill the screen. The week is as tall as its busiest day, and
  the spare room is ground at the foot of the page.
- Nothing floats but the drawer.

## Colors

A near black sky, a wide grey ramp for structure and text, one warm token for what is
due soon, one cool token for an event, and a single reserved alarm hue. Every value is
a custom property on `:root` in `src/styles/tokens.css`.

### Primary

- **Arrival Amber** (`--near`): what is due soon, and only that. A soon segment on a
  rail, the reason under a soon lead, beside a soon row, in the start line and in the
  drawer, the rule down the start row's left edge unless the row is late, the "ready"
  marker on a todo whose predicate came true, and a done-when line that has come true. A
  reason that is not due soon ("no date", "Tue 6 Oct") is dim bone, never amber.

### Secondary

- **Distance Cyan** (`--far`): an event. Its glyph in a row, the week and the start line,
  its reason under a lead, and its segment on a rail. An event is a moment on someone's
  clock, not a thing to finish, and it is the one cool mark on the map.

### Tertiary

- **Unstable Orange** (`--unstable`): the one reserved alarm hue, and the only colour
  that means "wrong". Late rows and leads, a late segment on a rail, a department or
  directive summary that counts late things, the start row's rule when it is late, the
  late column of the week, a failed
  source, a failed voice turn, a quick add or edit form that cannot write, and the
  header's warnings. It never appears without a shape or a word beside it: a triangle,
  an X mark, the word "late", or a count.
- **Stable Green** (`--stable`): the healthy source health line, and nothing else. The
  check mark and the words `sources ok` carry that state.

### Neutral

- **Sky Void** (`--void`): the page ground, and the glyph on the phone's talk button
  while it is held.
- **Sky Void 2** (`--void-2`): the drawer's backing before its blur.
- **Plane, Lit Plane, Hot Plane** (`--plane`, `--plane-lit`, `--plane-hot`): the three
  tonal steps of structure, one visible step apart. Plane is a directive cell at tier 3
  or 4, a field's ground and the source flags' ground. Lit plane is a tier 1 or 2 cell, a
  row's hover, the drawer's edge, the source flags' hairline and a keycap's border. Hot plane is a row's hover inside a lit cell, the
  week's day rules, the dashed ring of a starred directive with nothing queued, the
  selection and the scrollbar thumb.
- **Bone, Dim Bone, Faint Bone** (`--bone`, `--bone-dim`, `--bone-faint`): the text
  ramp, widened so each step reads on a cell. Bone for the thing being read (a lead, a
  loud directive's name, a department's name), dim bone (about 9:1 on a cell) for a
  row's title and its label, faint bone (about 5.5:1) for structure text and a calm
  rail segment.
- **Deep Ash** (`--ash-deep`, about 4:1 on a plane and 3.2:1 on a lit one): what is
  done or quiet. A done row, a row waiting out its undo window, the path line in the
  drawer, a placeholder, an offline voice. Done and struck text is exempt from 4.5:1, but
  never drops under 3:1 on the lit plane it most often sits on.
- **Rule** (`--rule`): the hairline under the header and under each department's head,
  and the ring around a finished directive.
- **Focus Violet** (`--focus`): keyboard focus only. The focus ring, a focused field's
  border, the caret, and the cursor row's rule and pointer.

### Named Rules

**The Shape Beside the Colour Rule.** No state anywhere is carried by hue alone. Late
is a triangle and a count. An event is a bar. A daily is a circle, filled when done.
Ready is a filled square and the word "ready". A rail is hidden from a screen reader
and always has its words beside it. A quiet department says "nothing pulling".
A starred directive with nothing under it says "nothing queued".
*Audit test:* screenshot the map under achromatopsia emulation. If any two states
become the same picture, the surface fails.

**The Token Only Rule.** Every colour is a custom property in `tokens.css`, and
translucent colours are `color-mix` over a token. No component hardcodes one.
*Audit test:* grep `src/` for a hex literal outside `styles/tokens.css`. Zero matches.

**The One Alarm Rule.** `--unstable` is the only hue that means something is wrong, and
it is spent on late work and on failures only.
*Audit test:* every occurrence of `unstable` in `shell.css` sits on a `late`, `alarm`,
`failed`, `warn` or `problem` class.

**The Uncoloured Star Rule.** A starred directive is context, never a nag (ADR 0007).
Its mark is a shape and a digit in faint bone and never takes a hue.

## Typography

**Human Face:** Instrument Sans (`--sans`, with `system-ui, sans-serif`), a variable
face with weight 400 to 700 and width 75% to 100%.
**System Face:** JetBrains Mono (`--mono`, with the Nerd Font names, `ui-monospace`,
`SF Mono`, `Menlo`, `monospace`), weight 100 to 800.

Both are self-hosted woff2 files in `src/styles/fonts/` with their licences, so the
phone gets the same page as the desk.

**Character:** two faces, two voices. What Daniel wrote (a todo, a directive, a
department, a note, a subtask) is set in the sans, at weights between 450 and 620 with
slight negative tracking at the larger sizes. What the system says about it (a date, a
count, a reason, a keycap, a heading label, a path) is set in the mono at 12px or
smaller. The page itself is set in the mono; the sans is applied to each human element.

### Hierarchy

- **Lead, tier 1** (580, 28px, 32px line, -0.016em, width 88%): the lead of a directive
  pulling 3 or more. Anything late gets here.
- **Lead, tier 2** (560, 22px, 27px line, -0.01em, width 92%): a lead pulling 2 or more.
- **Lead, tier 3** (540, 17px, 22px line, -0.004em): a lead pulling 0.9 or more.
- **Week, best day** (560, 30px, 1.15, -0.02em): the one sentence the week band shows
  when nothing is late and nothing lands today. 24px on the phone.
- **Drawer title** (580, 24px, 1.2, -0.014em).
- **Department name** (620, 20px, 1.1, -0.01em): 22px on the phone. Faint bone when the
  department is quiet.
- **Directive name** (600, 15px, 1.25): dim bone, bone in a tier 1 or 2 cell. The
  week's "This week" heading and the start line's title use the same 15px.
- **Row title** (450, 14.5px, 19px line): a row's title in dim bone, bone when the row
  pulls 2 or more. A week item's title is 14px on an 18px line.
- **Notes** (400, 14.5px, 1.45): a lead's notes; 15px at 1.5 in the drawer. Subtasks
  are the same face at 14px.
- **Label** (mono, 12px, 0.02em, tabular numbers): a reason, a summary, the header, the
  week's facts line.
- **Caps** (mono, 500, 11px, 0.14em, uppercase): the drawer's kind line, the edit form's
  labels, the START tag, the talk line's labels. The quick add chip tracks wider at
  0.22em, the start line's label at 0.16em, and the week's day labels narrower at 0.08em.
- **Keycap** (mono, 11px, 16px line): a key hint in a thin lit plane border. Only a key
  wears the border; a word such as START is caps with none, so it never reads as a key to
  press.

The leads step down together when the board is too tall for the screen (see Layout):
at the tightest density they are 24px on 28px, 19px on 24px and 16px on 21px.

### Named Rules

**The Two Faces Rule.** What Daniel wrote is Instrument Sans; what the system measured
is JetBrains Mono. A new element picks its face by who authored the words, not by how
important it is.
*Audit test:* every `font-family: var(--sans)` in `shell.css` sits on a title, a name,
a note, a subtask or a field for one.

**The Reason Rule.** A pull is never shown as a number. Every sized thing carries the
words that sized it: a department summary, a directive's words beside its rail, a
row's reason.
*Audit test:* `pressure()` returns `{ value, reason, late, soon }` and no component
reads `value` into text.

**The Tier Rule.** How loud a lead is set is its pull and nothing else, read off
`TIER_AT` (3, 2 and 0.9) in `src/lib/model/ink.ts`. Below 0.9 a directive has no lead
and is its rows.

## Layout

**The frame.** A 48px header, then the map, which is the rest of the screen. Nothing is
placed by script: CSS knows how tall the content is.

**The map.** A two column grid with a 32px gutter and `16px 24px 18px` of padding. Work
top left, Chess top right, Projects bottom left, Life bottom right. The top row is as
tall as its taller department and hangs from the header; the row under it is the week
band, as tall as its busiest column plus a small floor and never under 108px; the
bottom row follows the band directly. The rows start at the top (`align-content: start`)
and the height nobody needs falls below the bottom row, at the page's foot. The corners
keep their left and right, top and bottom order; they do not pin to the screen's floor.
The band asks for its height as `--want` on the map (from `Week.svelte`), and the grid
gives it that much when the departments leave room, and less, down to 108px, when they
do not. A department is its head (the name, its key, its rail and its
words, and a "+") over its directives: one directive takes the whole width, more flow
as two balanced columns read down the first and then the second, which is the order
`j` walks them. Under 560px of department width the columns become one. Cells sit
10px apart.

**Pull.** `src/lib/model/pressure.ts`, pure, the one place the ranking lives. Late work
starts at 3 and climbs with age to 4.5. Due today is 2.6, tomorrow 2, within three
days 1.4, within the week 0.9, later 0.4. An event within three hours is 2.8. A daily
is 0.7 until it is done, then nothing. An undated todo is 0.35. Every todo under a
starred directive is multiplied by its rank: 1.6, 1.35, 1.15, or 1 when unstarred
(ADR 0020). "Soon" is read off the date before the star, so a starred todo next month
is never painted amber. Routines are background and never reach the map. A directive's
pull is the sum of its things, a department's the sum of its directives.

**Where pull shows.** Three places, all in `src/lib/model/ink.ts`:

- *The lead's tier.* The strongest open thing in a directive is its lead, set at tier
  1, 2 or 3 by `TIER_AT`. A tier 4 directive has no lead.
- *The rail.* One segment per loud open thing (late, due soon, an event), strongest
  first, then the calm ones (undated, a daily, far off) pooled into one neutral tail,
  each `pull x --ppp` pixels long with an 8px floor so the shortest is still a bar and
  never a dot. `--ppp` is one scale for the whole board: at most 14 pixels per unit, less
  when the loudest department would run past 170 pixels (150 and 12 on the phone). A
  department's rail is its loud segments, directive by directive, then one calm tail
  for the whole department (`segments` in `ink.ts`).
- *The plane.* A tier 1 or 2 cell steps up to lit plane; tier 1 also carries a lit top
  edge.

**The lead's detail.** A tier 1 lead shows a short look under its reason, at the title's
indent: two lines of notes, the subtask progress as squares and a count ("■□□ 1 of 3
done", words alone past eight subtasks), and the done-when line. Anything longer is the
drawer's.

**Reading order.** The map's DOM runs Work, Chess, the week, Projects, Life, the order
the eye reads it, so Tab and a screen reader agree with the picture. The grid areas
place them; the DOM only orders them.

**The week.** `week()` and `columns()` in `ink.ts`. A late column when anything is late,
then today, then the next six days, each a column ruled at the top and down its left
side. Two or more empty days in a row fold into one column that names the span ("Sat 26
to Tue 29") with "clear" under it; a single empty day stays its own column and says
"clear" too. Today is never folded and keeps its 2px bone rule even when clear; late sits
on a 2px alarm rule with its triangle. A column with nothing in it takes 0.6 of a share,
so the days that hold something get the width. Each day lists what lands on it, soonest
first. The late column does not repeat the map: every late thing the map draws (as a
lead or a row) is counted under its department, one line each ("▲ 1 late · Projects",
triangle and word, in the alarm hue), and a click opens the strongest of them; a late
thing the map does not show is listed by name after the counts. The band is as tall as
its busiest column: counted at 24px a line when compact, measured when roomy. When the
week is quiet (three lines or fewer in every column) and the departments leave room for
62px an item, it is roomy: titles may take two lines and each item says where it is
filed. Squeezed by a crowded board, each column lists as many 24px lines as fit, then
"+N more" (`fitRows` in `layout.ts`). The band's head is "This week" and a facts line
("dailies 1 of 3 done · 2 undated on the map"); dailies are counted, never listed,
because they land every day.

**The best day.** With nothing late and nothing landing today, the band leads with the
sentence "Nothing late, nothing due today." at the week's display size, and under it
"next up" and the next dated thing and its day, or "nothing dated in the next seven
days".

**Density.** The ink shrinks before the page scrolls. The band gives way to its 108px
floor first. Then the map tries each density in turn and keeps the first that fits:
density 0 is everything at full size, density 1 sets every compact row on one line with
an ellipsis (the whole title stays in its title attribute and the drawer) and drops the
lead's detail, density 2 also sets every lead a step smaller. The step is the same for
every cell, so the tiers still read against each other. Only a board that fits none of
these scrolls.

**Zoom and keys.** Keys 1 to 4 fill the map with one department, its directives in
columns at least 340px wide, and the week steps aside. Escape goes back. Clicking a
department's background does the same. None of the keys is live while a field is being
typed into or a button someone tabbed to has focus:

- `1` to `4`: zoom that department; the same key again, or Escape, goes back.
- `j` and `k` (or the arrows): move the cursor down and up the rows, in the order the
  map draws them. The ends hold rather than wrap. An open drawer follows the cursor.
- `Enter`: open the cursor's row, else the start line's thing, while the drawer is
  closed.
- `x`: tick the drawer's thing when it is open, else the cursor's row, into the undo
  window; `x` again while it waits takes it back.
- `e`: edit the same thing in the drawer's form.
- `u`: take back the newest tick still waiting.
- `n`: open the quick add field, in the zoomed department if there is one.
- `?`: the legend of marks and keys, in the drawer; `?` again or Escape closes it.
- `Escape`: the quick add field, else the legend or the drawer (its form first), else
  the zoom, else the cursor.
- `Space` (held): talk.

Every tick waits five seconds in the header before it is written, because a tick is a
commit to the vault's history.

**Focus.** Opening the drawer puts focus on its heading, so the title is read out and
the keys still work (a heading is not a button, and a button someone tabbed to keeps
its keys). Closing it hands focus back to the title of the row it last showed, or to
whatever opened it; backing out of the edit form puts focus on the heading again. Focus
the page moves itself counts as clicked, not tabbed (`src/lib/focus.ts`), so a title it
lands on after Escape does not swallow `j` and `k`. It only moves when focus was in the
drawer or nowhere, so a click elsewhere keeps the focus it made.

**Motion.** The map reflows; nothing on it animates its size. What moves: a row's
background lighting (0.15s ease out), the drawer sliding in (0.25s ease out), the source
flags fading in (0.12s ease out), and a voice turn in flight, where the talk glyph
breathes (1.6s) and a short line sweeps the header's bottom rule (1.8s) until the turn
lands. Under `prefers-reduced-motion: reduce` nothing transitions and the in-flight rule
is lit solid instead.

**The phone.** Below 700px the four corners become four pages on a horizontal track
that snaps one department per swipe, in corner order, then a fifth page for the week,
opening on the page it was last on. A page is its department in flow and nothing else;
the week is shown once, on its own page after Life, because it belongs to no department
and repeating it under each one read as four copies of the same list. The week's page
has the same head as a department's (its name at 22px over a rule) and lists the late
counts, today and every day, spans folded the same way, one 44px line each beside a 78px
day label that breaks a span over two lines.
Every row is a 44px line with its tick's hit area filling it. Pull keeps its place in
the header as a strip of four 3px bars, each `6 + 22 x (pull / loudest)` pixels long,
the current page in bone with its department's name beside it in the human face at 14px, a page
with late things in the alarm hue. The week's tab comes last: seven 2px ticks, a fixed
26px, because it carries no pull, with "Week" beside it when it is the page. The drawer is a
sheet from the bottom, at most 80% of the screen, over a scrim. A round 64px talk
button and a 44px "+" sit under everything; the quick add field stacks above them at
16px so the phone does not zoom on focus. Keycaps are gone.

### Named Rules

**The Four Corners Rule.** Work top left, Chess top right, Projects bottom left, Life
bottom right, and keys 1 to 4 zoom in that order.
*Audit test:* the `.map` grid areas in `shell.css` are the single source of a
department's corner.

**The Ink Is Attention Rule.** A box is as tall as what it holds and nothing else.
Pull is carried by the lead's tier, the rail's length and the plane's step, never by
area, never by padding a box out, never by where it sits.
*Audit test:* no component sets a height or width from a pull, except a rail segment
and the phone's strip bar, which are lengths.

**The Nothing Stretches Rule.** No box, and not the week, is stretched to fill the
screen. The week is as tall as its busiest column plus a small floor, and the height
nobody needs falls below the bottom row as plain ground. It is never drawn as empty
ruling or empty plane.
*Audit test:* on a quiet board the band's height is within its floor of its tallest
column, and the gap sits under Projects and Life, not inside the band.

**The Floor Rule.** Nothing open is ever silently cut. A week column that cannot list
everything says "+N more", and a late thing the map does not show is listed by name. A row that is set on one line keeps its whole title in its
title attribute and in the drawer.

## Elevation & Depth

Flat. Depth between the ground, a directive, and a loud directive is tonal, from
`--void` through `--plane` to `--plane-lit`, plus the `--rule` hairline. A tier 1 cell
adds a lit top edge (`inset 0 1px 0`, bone at 12%), which is light on a surface, not a
lift. Rules drawn inside an element (the start row's amber edge, the cursor row's
violet edge) are 2px inset lines, also not a lift. Exactly one surface floats, the
drawer.

### Shadow Vocabulary

- **Drawer lift** (`box-shadow: 0 12px 32px -10px color-mix(in srgb, var(--void) 95%, transparent)`):
  the drawer only, paired with `backdrop-filter: blur(8px)` over void 2 at 92%.
- **Lit top edge** (`box-shadow: inset 0 1px 0 color-mix(in srgb, var(--bone) 12%, transparent)`):
  a tier 1 cell only.

### Named Rules

**The Nothing Floats but the Drawer Rule.** The drawer is the one raised surface. Rows,
cells, departments and the week are on the ground. The source health flags open over
the map but sit flat: plane, a lit plane hairline, no shadow and no blur. The legend is
the drawer's, not a surface of its own.

## Shapes

Corners are nearly square: 1px on a rail segment, 2px on a checkbox, 3px on a row, a
keycap, a field and a focus ring, 4px on a cell and the source flags readout, 8px only
on the top corners of the phone's sheet. The one circle is the phone's talk button.
Nothing is pill shaped.

The form language is one small glyph vocabulary, shared between the rows, the week, the
start line and the drawer (`glyphFor` in `src/lib/model/derive.ts`):

- **Filled diamond** (`◆`): a dated todo.
- **Hollow diamond** (`◇`): an undated todo.
- **Triangle** (`▲`): late, everywhere it appears, and the failed source flag.
- **Bar** (`▮`): an event, in Distance Cyan.
- **Circle** (`○` / `●`): a daily, hollow until done today.
- **Filled square** (`■`): a done subtask, against `□` for an open one.

A row's glyph and a week item's carry their kind as a word too (`glyphKind` in
`derive.ts`): late, dated, undated, daily, event or routine, as the glyph's title and as
visually hidden text, so a screen reader hears "late" rather than the shape's name.

Two marks are drawn rather than typed:

- **The rail**: segments 4px tall (6px in a department's head), 2px apart, as long as
  their pull.
- **The star**: a 10px five point star drawn in SVG, filled with the text colour, then
  its rank digit, in the mono at 11px in faint bone.

### Named Rules

**The Shared Glyph Rule.** A row and the drawer that show the same thing wear the same
shape. A new kind of thing adds one kind in `glyphKind` and its shape in `glyphFor`,
and nowhere else.

**The Filled Means Dated Rule.** Filled is a thing with a date or a thing done; hollow
is the same thing without.

## Components

### Department head

A department's name in the human face at 20px, its key in a keycap, then its rail and
its summary in words ("1 late, 2 due soon", "3 open", "nothing pulling"), the summary in
the alarm hue with a triangle when anything is late, and at the right a 28px "+" that
opens quick add in that department. A 1px rule sits under it. A quiet department's name
and words drop to faint bone. Its background is a click target that zooms it; when
zoomed, "esc all four" replaces the zoom. When the department holds exactly one
directive, its head carries the rail and the words and the cell does not repeat them.

### Directive cell (signature component)

A raised plane, 4px corners, `11px 14px 10px` of padding, as tall as what it holds. Its
head is the directive's name in the human face ("Unfiled" for the todos filed under
none), its star when it has one, then its rail and its words at the right, dropping under
the name when the cell is narrow, unless it is its department's only directive. Then its
lead at its tier's size with its reason under it, the lead's detail at tier 1, and its
other rows, strongest first, under a faint divider, then the done ones in deep ash.
Tier 1 and 2 cells step up to lit plane and bone text; tier 1 adds the lit top edge. A
directive whose things are all done drops its fill for a 1px rule ring and its name to
faint bone, so a finished thread reads as finished rather than missing.

### Starred directive with nothing queued

A starred directive with no open todos (ADR 0020) is one slim line after the
department's cells, across its width: no fill, a 1px dashed ring in hot plane at 80%
(a slot waiting for a todo, not the solid ring of finished work), its name in the human
face in faint bone, its star and rank as any starred cell shows them, "nothing queued" in
the system voice in faint bone at the right, then a 28px "+" (44px on the phone). No
rail, no pull, no hue: it is never louder than a cell that holds a todo, and `j` and `k`
skip it. A click anywhere on it, or its "+", opens quick add in its department and filed
under it. It does not count toward the department's columns, so a lone real directive
keeps its full width and its head keeps the rail.

### Rows

A checkbox, a glyph, a title that is a button, and a reason in the system face. The
title and its reason share a line while both fit; a long title wraps and the reason
drops under it, so nothing is cut. A row pulling 2 or more sets its title in bone. A
soon row's reason is amber. A late row takes the alarm hue on its title, glyph and
reason, and its glyph is already a triangle; a late lead does too, at its tier's size.
A done row sits in deep ash. A row with subtasks carries "□ 1/3" after its reason,
filled once all are done. The row the start line names wears a 2px rule down its left
edge, amber, or the alarm hue when it is late, and the word START in caps, unboxed. The cursor's row
wears a 2px violet rule and a `▸` pointer in the cell's margin, and lifts as a hover
does. Hover lifts a row to lit plane at 70%, or hot plane at 70% inside a lit cell. A
row ticked and waiting out its undo window is struck through in deep ash with its box
already filled.

### Rail

The pull drawn as a length, beside every department and directive. The calm tail is
faint bone at 75%, soon segments amber, event segments cyan, late segments the alarm
hue. A rail of undated things alone is one short neutral bar beside "2 open". It is `aria-hidden`; the words beside it are what a screen reader hears. It never
stands alone.

### Star

A starred directive's mark, beside its name: the drawn star and its rank, in faint
bone, titled "starred directive, rank N of 3", with "starred, rank N" for a screen
reader. It never takes a hue.

### Week band

Described under Layout. Its items are buttons: a glyph, a title in the human face and,
for an event, its time, lifting on hover as a row does and lit when the drawer or the
cursor is on the same thing. A late item is in the alarm hue. A late count is a button
too, in the system face at 12px ("▲ 2 late · Work"), its title attribute listing what it
counts, lit when the drawer or the cursor is on any of them.

### Drawer

The one thing that floats. Opens from the right over the map, 420px wide, on a title
click, and closes on Escape or its close verb. It carries the kind, the department and
the directive as a caps line, the title at the drawer's title size, the glyph and the
reason (amber only when due soon, the alarm hue when late, dim bone otherwise) with the
full date after it unless the reason already names the day (`whenLine` in
`detail.ts`), the notes, the subtasks with filled and hollow squares, the
done-when line, the path and line in the vault in deep ash, and three verbs with their
keys: `x` done, `e` edit, `esc` close. Its edit form turns the same lines into fields: a
caps label over each, fields on plane with a lit plane border and 3px corners, the
title field in the human face at 16px, a focused field's border in violet, a problem in
the alarm hue with its triangle.

The drawer is an `aside` labelled "details" (or "legend"), and focus follows it as Layout
describes. Pressing `?` fills it with the legend: every glyph and mark beside its words,
in the hues it wears on the map, then every key, on one screen, closed by `?` or Escape.

### Header

The mark `ENGINE` in the mono at 0.24em, then the day in one line: the date and the tally
in words ("4 late · 1 today", or "nothing due today"), late with its triangle. Then the
start line, `first(views)` read out and never a second ranking: the caps word START,
the thing's glyph, its title in the human face at 15px, its directive, its reason, and
an `enter` keycap. While a tick waits, the undo line takes the start line's
place: a filled square, the title, "+N more", the `u` verb and the seconds left. Then
warnings with a triangle, the key line (`j k` move, `enter` open, `x` done, `e` edit,
`?` keys), the talk state, and source health at the right. The key line shows whenever
it fits whole in the room the rest leaves, and is the first thing the header drops: it
never squeezes the start line. As the window narrows the other parts drop whole: the
directive under 1100px, the tally under 960px, the date under 820px. The start and undo lines only ever shorten their title. The header never widens
the page.

### Quick add

While open (`n`, or a department's "+"), it takes the middle of the header: a caps chip
naming the department (and, when a starred directive's "+" opened it, that directive in
the human face at 14px beside it, which a typed `#directive` overrides), one field of human text on plane in the human face at 15px, and
beside it one line in the system voice saying what Enter would write (the title in
quotes, then the department, the directive and when: "“buy milk” · life · due Fri 25
Sep"), the grammar while
the field is empty, why it cannot be sent yet in faint bone, or a failed write in the
alarm hue with its triangle. Enter writes the todo on its department note and lights the
new row for two seconds.

### Source health

One line in the header at the right: a check mark and `sources ok` in stable green, or
an X mark and a count in the alarm hue. The four source flags open under it on hover or
focus, flat on plane with a lit plane hairline, and are hidden (not only transparent)
while closed, so a screen reader does not read them. Each has its own shape: `○` fresh, `◑` stale, `▲` failed, `□` never. On the
phone the line is its dot alone and the flags open on a tap.

### Talk

The microphone's state as a word and a shape in the header: `●` listening, `○`
transcribing, `◐` working, `▶` speaking, `✕` offline in deep ash (quiet, because the
voice process being down is not an alarm), `▲` failed in the alarm hue. The last
transcript follows, and the rows a turn wrote are set apart by a rule, not a hue.

### Empty states

A department with nothing pulling says "nothing pulling". A board with nothing at all
says "nothing on the board" in the middle of the map. A starred directive with no
todos says "nothing queued". The best day is the week's one sentence. An empty day, or a
run of them folded into one column, is "clear".

## Do's and Don'ts

### Do:

- **Do** let a box be as tall as what it holds, and put pull in the ink: the lead's
  tier, the rail, the plane.
- **Do** put the words next to every number and every rail.
- **Do** keep the four corners where they are.
- **Do** set what Daniel wrote in Instrument Sans and what the system measured in
  JetBrains Mono.
- **Do** read a lead's size off `TIER_AT` and nothing else.
- **Do** add a glyph in `glyphFor` when a new kind of thing appears, and add it to the
  drawer.
- **Do** shrink the ink (one line rows, then smaller leads) before letting the map
  scroll.

### Don't:

- **Don't** draw anything Daniel did not write in the vault.
- **Don't** carry a state by hue alone.
- **Don't** size a box by its pull, or pad a box (or the week) to fill a gap; the spare
  room is ground at the page's foot.
- **Don't** colour the star, or let a directive escalate on its own; a star only
  weights the todos under it.
- **Don't** animate a box's size. Motion is a row lighting, the drawer sliding in, and
  a voice turn in flight.
- **Don't** add a second floating surface.
