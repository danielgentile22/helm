# Capture is deterministic, and every source fails on its own

The producers that feed the dashboard are plain Python under `runner/producers/`,
run by launchd every 30 minutes. No Claude call sits anywhere in the capture path.
Each source (Google Calendar, the todos on department notes, the routine schedule,
git facts per repo, the trackers) is its own failure domain with its own cached file,
and the two merged files the dashboard reads, `runner/status/agenda.json` and
`runner/status/projects.json`, carry each source's envelope verbatim.

## The calendar decision

Daniel wants Google Calendar. The obvious route was the claude.ai Google Calendar
connector inside a headless `claude -p` run. Tested 2026-09-17: it works from a shell,
one call listing the calendar took 5 seconds and cost 18 cents. At a 30 minute cadence
that is roughly 9 dollars a day to reproduce a deterministic transform, and HELM had
already measured the same route in production: 689 of 712 headless runs produced
identical output at LLM latency, and the other 23 were nondeterministic failures
(ADR 0008 here).

So the calendar is read directly with the Calendar API v3 and the OAuth refresh token
HELM left at `~/.claude/helm-gcal-token.json`. That token still refreshed headlessly on
2026-09-17 with no browser. The connector was never tested under launchd, because the
decision does not rest on it. The `.ics` fallback from the handoff was not needed. If
the token ever stops refreshing, the source reports `auth` in its envelope and the
bootstrap command is `python3 ~/Projects/archive/helm/feeds/calendar-agenda.py --auth`,
which writes the same token file.

## Consequences

- **A source that fails keeps its last good rows.** Its envelope carries `produced`
  (when the rows were last true) and `attempted` (the last try), with `ok: false` and a
  typed reason. A network blip can never read as an empty calendar, and a dead producer
  can never read as fresh. This is the artifact-derived staleness ADR 0015 asks for: the
  dashboard compares `produced` to its own clock, and reads no status file.
- **The daily integrity check is the second witness.** `check_freshness.py` fails when
  any source is `ok: false` or older than twice its cadence. That covers the day nobody
  opens the dashboard, which is how HELM's `atlas-distill` died unnoticed for three weeks.
- **Timestamps, never durations.** `at`, `since`, `touched`, `produced`: the file states
  when, and the reader subtracts. A stamped `age_days` is wrong 29 minutes out of 30,
  and a stamped `late` is wrong the moment the clock passes it.
- **One list of dated things.** `agenda.json` holds calendar events, todos and scheduled
  jobs as one `items` list with a `kind`, sorted by `at`. The orrery builds one body list
  anyway; the fixture's three arrays were an artefact of writing it by hand.
- **The calendar window is 7 days back and 28 forward, and bounds only the calendar.**
  Back, so recent arrivals can leave a wake (verdict item 5). Forward, so the rim can be
  ordered by date (verdict item 4). Todos and jobs are never windowed.
- **Todo syntax is now fixed.** `- [ ] text (due: YYYY-MM-DD) done-when: <predicate>` on
  a department note. Age comes from the vault's own git history, so no one writes an
  opened date. A true predicate is reported in the file, never ticked in the vault.
- **Session notes live in otto, not in the repo.** A `Stop` hook writes the last recap
  of every turn to `runner/status/sessions/<folder>/<session>.md`, so a killed terminal
  still leaves a note, and `SessionStart` reads it back. Three project folders have no
  `.git`, a multi-repo workspace has none at its root, and nothing otto writes may dirty a tree the
  project scan is measuring, so "in the repo" is served by keying on the repo.
- **Repos are always Projects.** The fixture tinted repos by department; the file follows
  `PROJECTS.md` instead.
- `runner/schedule.py` is the one parser of the `daily HH:MM` and `every Nm` grammar,
  used by the installer, the routines source and the freshness check.
