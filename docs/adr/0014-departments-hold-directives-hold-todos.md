# Departments hold directives, directives hold todos

The dashboard is organised by department, not by directive. The four departments are
the top level, each department holds its own directives, and a todo hangs off a
directive or off the department directly.

`Directive` previously meant one of exactly three ranked standing priorities, which
left Projects and Life with none at all and gave an active client engagement, with a
boss and a daily standup, nowhere to sit. The three ranked priorities survive as a
**flag**: any directive anywhere in the tree can be starred, and the list in
`CLAUDE.md` is a rendering of which three are starred rather than a second list that
can drift from the departments.

## Consequences

- **Escalation attaches only to things that can be finished.** Todos, in-flight work
  and dated obligations escalate. Directives do not. HELM put the three ranked
  priorities on a breathing orb and it changed nothing, because Daniel already knows
  what they are. A directive is context and a label; it is never a nag.
- Two escalation rules, one widget. A todo with a date escalates as the date
  approaches. A todo without one escalates on age.
- A todo may carry a `done-when` predicate checked by the nightly routine: a merged
  pull request, a clean working tree, a metric crossing a threshold, a file existing.
  A todo that checks itself is reported as done rather than waiting to be ticked.
- Repos always belong to the Projects department, per the rule already in
  `PROJECTS.md`. Chess repos are repos; the playing around them is Chess.
