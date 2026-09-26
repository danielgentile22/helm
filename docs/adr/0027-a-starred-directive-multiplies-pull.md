# A starred directive multiplies pull

A directive heading under `## Todos` may carry a star and a rank, `### Launch ★1`,
and every todo under it pulls harder by that rank's weight: 1.6 for the first, 1.35 for
the second, 1.15 for the third, 1 for anything unstarred. The star is not part of the
directive's name. Decided 2026-09-23.

ADR 0014 made the three ranked priorities a flag on the directive tree rather than a
second list, but nothing read the flag, so pressure ranked by date alone. On the live
board that put a side project chore three hours late at the top of the screen and in
the header's start line, while the first priority had no say at all.
Daniel chose to let rank weigh in.

The weights are set so rank reorders close calls without drowning the date. A late
todo under the first star (at least 4.8) always beats the latest possible unstarred one
(at most 4.5), and a first star todo due today (4.16) beats an unstarred one that has
only just gone late (3.0). A far off starred todo still sits below anything due soon.

## Consequences

- **ADR 0014's "a directive is never a nag" holds.** The star weights the todos under
  a directive; the directive itself still has no pressure of its own and nothing on
  screen escalates it. The map shows the star as a small mark and its rank beside the
  directive's name, never in colour.
- **One parser for the heading.** `todos.directive_heading` splits a title into its
  name and rank, and both capture and `todo_edit.py` go through it, so filing a todo
  under "Launch" finds `### Launch ★1` instead of coining a second heading.
  Only a trailing `★1`, `★2` or `★3` is a rank.
- **The row carries `star`.** Capture emits `"star": 1 | 2 | 3 | null` on every todo,
  and `decode.ts` reads anything else as unstarred rather than dropping the row.
- **"Due soon" is read off the date before weighting**, so a starred todo next month is
  not painted amber for being starred.
- **The stars live on the department notes.** Two sit on `Work.md` and one on
  `Chess.md` (the third added 2026-09-24).
- **2026-09-23, same day: an empty starred directive says so.** The first-ranked
  directive had no open todos, and since capture only emitted todo rows it vanished from
  the map entirely. The todos source now also reports every starred heading under
  `## Todos`, with or without todos, and agenda.json carries them as a top-level
  `"directives": [{"dept", "name", "star", "path", "line"}]`. They travel as rows of kind
  `directive` in the todos source's own cache, so they share its envelope and its failure
  domain, and capture lifts them out of `items` when it merges. The map draws a starred
  directive with nothing under it as a quiet cell after the department's real ones: its
  name, its star and rank, and the words "nothing queued", on a dashed ring with no fill,
  no rail and no hue. It pulls nothing and the cursor skips it; a click or its "+" opens
  quick add filed under it. ADR 0014 still holds: it is shown, never escalated.
