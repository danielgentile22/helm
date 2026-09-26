# otto holds only what Daniel puts in

The dashboard's agenda is Daniel's own entries and nothing else: todos on department
notes, and the next fire of every scheduled routine. Google Calendar is deleted as a
capture source. `agenda.json` has two sources, `todos` and `routines`, and the model
has two kinds of thing, `job` and `todo`.

ADR 0020 chose to read the calendar directly with the Calendar API v3 rather than
through a connector, and it was the right call about *how* to read a calendar. This
record supersedes the part that decided to read one at all. A calendar is a mirror of
other people's demands on the day, arriving whether or not Daniel agreed to any of it.
Rendering it beside his own work made the screen a report on his obligations rather
than a board of his intentions, and the loudest bodies on it were the ones he had the
least say in. The point of the second brain is that he wrote what is on it.

Google Calendar stays a connector otto reads on request, with full control per
`CLAUDE.md`. Asking what is on Wednesday still works. Nothing captures it on a
schedule, and no producer writes an event row.

## Consequences

- **A source is not deleted by disabling it.** No feature flag, no config toggle, no
  `calendar.py` sitting unreferenced. The `event` variant is gone from the model, its
  glyph is gone from the instrument atlas, and the decoder has no branch for it, so a
  stray event row in a hand-edited file is dropped and counted like any other row that
  fails its contract.
- **`agenda.json` has no `window`.** The 7-back, 28-forward horizon in ADR 0020 bounded
  the calendar and nothing else. Todos and jobs were never windowed, so with the
  calendar gone the key bounded nothing and was removed rather than left to mean
  something later.
- **`GCAL_TOKEN` leaves `.env.example`.** The stored OAuth token file is no longer read
  by anything in otto, so the repo stops naming it.
- **Every agenda row is now writable.** Both remaining kinds trace back to a file in
  this repo or the vault: a todo to a line on a department note, a job to
  `models.json`. That makes the dashboard's one write into the vault the general case
  rather than an exception carved out for todos, and it means nothing on the agenda
  can be wrong in a way Daniel cannot fix by editing a file.
- The bar for a future source is the same question: did Daniel put it there? Email,
  tracker issues and anything else arriving from outside can be read on request and
  still fail that test.
