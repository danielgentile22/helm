# The dashboard is a pressure map

> Superseded in part by ADR 0026 (2026-09-23): boxes are no longer sized by pressure.
> The pressure model, the four corners and the rest of this record stand.

The dashboard is a map of the four departments, each box in its corner sized by how
hard its open work pulls on attention, each holding its directives as cells sized the
same way, with a drawer for the detail of any one thing. The Approach disc and the
hero slot are gone. Decided 2026-09-22 after one prototype round of four directions.

The Approach (ADR 0019) was designed against a week of ninety bodies, most of them
calendar events. ADR 0022 removed the calendar, and the disc then drew seven things:
four of them late in a knot at the centre, and a week of rings with nothing on them.
Daniel's own words were that it was lame to look at and added little. Under
questioning the question the screen has to answer turned out to be a different one
from the one the disc drew. Not "when does everything land" but "what should I work
on", with the departments that need attention growing and the empty ones shrinking.

Four replacements were prototyped against a fixture built from Daniel's real todos and
directives (`dashboard/prototypes/attention/`):

| Direction | What it tried | Why it lost |
|---|---|---|
| The Answer | one todo in large type in the band, the rest in two department rows | said what to do, but the corners sized by content only |
| Answer over Map | the answer in a fixed middle column, the four corners sized by pressure | close, but two ideas on one screen |
| **Pressure Map** | a treemap: departments hold directives hold todos, area is attention | chosen |
| Project Cards | every directive a card sized by pressure | an inventory, not an answer; dailies and events had no card |

Daniel chose the map.

## Consequences

- **Pressure is the one ranking, and it is in one file.** `src/lib/model/pressure.ts`
  scores a thing (late climbs with age, then due today, tomorrow, this week, later; an
  event is hard near its hour; a daily is a small constant until done; an undated todo
  is a little; a routine almost nothing) and always returns the words that justify
  the number. Nothing on screen shows a bare score.
- **Area is attention.** `src/lib/model/layout.ts` splits the screen by pressure and
  nothing else, with a floor so an empty department is a strip that says "nothing
  pulling" rather than nothing. The four corners rule survives: only sizes move.
- **A todo has a kind, a directive, notes and subtasks.** `(daily)`, `(at: ...)`, a
  `### <directive>` heading under Todos, and indented lines under a box. The syntax is
  in `runner/README.md` and `runner/producers/sources/todos.py`. A daily is done by
  date and never ticked, so nothing has to reset it. Content ids did not change.
- **The map draws only what Daniel wrote.** ADR 0022 holds. Commits, sessions and
  routine runs were considered as fuel for the old disc and rejected: he did the work,
  so he knows it is done.
- **The slot contract, Threlte, three.js and the instrument registry are deleted.** ADRs
  0010, 0011, 0012, 0014 (the slot half) and 0016 describe the archived UI, not this
  one. The bundle went from a WebGL scene to 61 KB.
- **The Observatory is archived, not deleted.** Tag `observatory-ui` marks its last
  commit and `dashboard/archive/observatory/` is a copy of its UI source with a README
  on running it. Its design system stays with it; `dashboard/DESIGN.md` now describes
  the map.
- **Repositories left the screen.** The in-flight repo list was the Projects box's
  second column and then the band's right column. The producer still runs and
  `projects.json` still carries it, but the map draws todos, and a repo is not a todo.
