# runner

helm's scheduler: routines, services, the capture producers and the checks.

Routines are jobs helm runs on a timer under launchd. Some are prompts it sends
to itself headlessly through `claude -p`; `capture` is pure code and calls no
model at all. A service is the other kind of job: a process launchd keeps alive
rather than fires on a schedule. The vault holds knowledge, this directory holds
code, and everything that changes because something ran lives in `~/.helm/`
(`HELM_STATE`), outside both.

```
runner/
├── install-routines.sh   launchctl and the files in ~/Library/LaunchAgents, nothing else
├── launchd.py            models.json turned into jobs and plist text, as pure functions
├── schedule.py           the schedule grammar in models.json, parsed in one place
├── routines/             one script per routine
├── producers/            capture.py and the five sources it runs, plus todo_edit.py
├── hooks/                session_note.py, the three Claude Code session hooks
├── checks/               deterministic checks the routines call
└── schemas/              the daily note contract

~/.helm/
├── status/               what the dashboard reads: agenda, projects, per-routine
│                         results, sources/ caches, sessions/ notes
├── logs/                 launchd stdout and stderr
├── metrics/              metrics.csv, one row per reading
├── voice/                turns/ from talk, and an optional whisper-prompt.txt
├── dashboard-auth/       the dashboard's passkeys and sessions
└── backup/               where the backup routine writes, and when it last did
```

## The rules every routine follows

- **Safe to run late.** launchd fires a missed job on wake, not at the scheduled
  hour. A routine that assumes it is 07:00 will be wrong.
- **Safe to run twice.** Same inputs, same end state. Today's report is
  overwritten, never appended.
- **Silent on success.** A routine that writes something every day is a routine
  you stop reading. HELM's `atlas-distill` stopped producing output on
  2026-08-02 and nobody noticed for three weeks.
- **Host-portable.** No paths hardcoded to one machine. The plist is generated at
  install time, so moving helm to another machine is one command, not an edit.
- **Model, effort and schedule come from `models.json`**, never from the script.
  The card on the dashboard and the job on disk cannot disagree. A routine that
  needs no model records `null` for both and says why.

## Installed jobs

| Routine | When | Model | Does |
|---|---|---|---|
| `integrity-check` | daily 07:00 | sonnet, low | Verifies every router pointer, every wikilink, every repo against its project note, and the dashboard checks and tests. Writes a report only when something is broken |
| `capture` | every 30 min | none | Refreshes `status/agenda.json` and `status/projects.json` from the deterministic producers. No Claude call |

A routine is a script on a timer. A service is a process launchd keeps alive, and
there are two:

| Service | Runs | Does |
|---|---|---|
| `dashboard` | at login, restarted if it exits | `dashboard/serve.py --no-open`, so `http://127.0.0.1:8642/` is answering without anyone starting it |
| `voice` | at login, restarted if it exits | `voice/server.py` under its own virtualenv, so `127.0.0.1:3108` has the speech models warm and hold Space works without anyone starting it |

One launchd job per entry under `routines` and `services` in `models.json`, labelled
`com.helm.<name>`. `daily HH:MM` becomes a `StartCalendarInterval`, `every Nm` becomes
a `StartInterval` with `RunAtLoad`, so a laptop that wakes gets a fresh snapshot
instead of waiting out the interval, and a service becomes `KeepAlive` with a
`ThrottleInterval` so a crash loop costs a restart every 15 seconds rather than a
busy core.

`launchd.py` is what decides all of that, as pure functions of the registry and the
two paths handed to them, tested by reading the generated text back with `plistlib`
the way launchd reads it. `install-routines.sh` runs `launchd.py --list` for the plan
and `launchd.py --plist <label>` for each file, and owns `launchctl` and
`~/Library/LaunchAgents` and nothing else. Both halves of the installer loop over the
same listing, so what it can install is exactly what `--uninstall` removes.

Install or reinstall after adding a routine or a service, or changing a schedule:

```sh
runner/install-routines.sh              # generate every plist and load it
runner/install-routines.sh --uninstall  # unload and remove all of them
runner/launchd.py --list                # the plan, without touching launchd
launchctl kickstart -k gui/$(id -u)/com.helm.capture     # run one now
launchctl kickstart -k gui/$(id -u)/com.helm.dashboard   # restart the dashboard
launchctl kickstart -k gui/$(id -u)/com.helm.voice       # restart the voice process
```

A command in the registry is a list of tokens. A token with a slash in it is a path
inside helm and is joined to whatever root the installer is run from; anything else
is a bare word. Nothing names one machine, so moving helm to another is a
re-run rather than an edit.

## The integrity check

Six deterministic checks, then Claude only if one fails.

- `checks/check_pointers.py` - every backticked path in every router resolves
- `checks/check_links.py` - every wikilink in the vault resolves. Code spans are
  skipped, since Obsidian does not render a link inside backticks, and `Inbox/`
  is a valid target but never a source, so a dead link in an old report cannot
  fail the check forever
- `checks/check_registry.py` - every repo under `~/Projects` has a project note,
  and every note's `repo:` points at a folder that exists
- `checks/check_freshness.py` - every capture source in `agenda.json` and
  `projects.json` is succeeding and produced its rows within twice its cadence,
  read from those two files rather than from a status file summarising them
- `checks/check_service.py` - every service in `models.json` has a launchd agent
  loaded and something answering helm's own `/api/health` on the loopback port. It
  reports an agent that is loaded but silent (the process is crash looping or wedged,
  and `logs/com.helm.dashboard.err` says why) and a service the registry names on a
  machine that was never installed. Each line says what is wrong in words
- the dashboard's own checks, which nothing else runs on a schedule:
  `npm --prefix dashboard run check` (the loop guard, the model tests and the
  caching policy under `node --test`, the worker's own type check, then
  `svelte-check`) and `python3 -m unittest discover`
  over `dashboard/server`, `runner` and `runner/producers`. A tree with no
  `dashboard/node_modules` reports one FAIL line naming the install command, rather
  than pages of npm output

On failure it writes `Inbox/runs/integrity/YYYY-MM-DD.md` in the vault with the raw
output, then asks Claude (Sonnet, low effort, per `models.json`) for one bullet
per problem: what broke, likely cause, and the fix. On success it writes nothing
but `status/integrity-check.json`.

This is the routine that makes everything else trustworthy. Routers are only
worth reading if their pointers are real.

## Capture

`producers/capture.py` runs four sources, each its own failure domain, and writes
the only two files the dashboard reads:

- `status/agenda.json` - dated things, one merged list sorted by `at`: open todos
  and the next fire of every routine. Beside that list, `directives` names every
  starred directive heading on the department notes, with or without todos under it
  (`{"dept", "name", "star", "path", "line"}`), so a priority with nothing queued
  still reaches the map (ADR 0027). The todos source reports these as rows of kind
  `directive` in its own cache, so they share its failure domain, and capture lifts
  them out of `items`. The todos envelope's `count` includes them
- `status/projects.json` - every repo and workspace under `~/Projects`, with its
  tracker joined on by path

Each source also keeps its own cache at `status/sources/<name>.json`, and both
merged files copy that source's envelope verbatim under `sources.<name>`:

| Field | Means |
|---|---|
| `produced` | last success, and the time the rows were actually true |
| `attempted` | last try. It differs from `produced` exactly when the source is failing |
| `ok` | false when this run failed. The rows beside it are then the last good ones |
| `reason` | `auth`, `network`, `deps`, `timeout`, `parse` or `crash`, with detail |
| `count`, `cadence_s` | rows held, and how often the source is supposed to run |

Each merged file's own `produced` is the newest of its sources', so re-merging after one
source reran does not restamp rows nothing recollected.

So a failing source never blanks the dashboard and never lies about its age. Every
time-dependent number (late, age, days since touched) is left to the reader, which
is the only thing holding `now`.

```sh
python3 runner/producers/capture.py                       # what launchd runs
python3 runner/producers/capture.py --only todos          # rerun one source, re-merge both files from the caches
python3 runner/producers/capture.py --only todos --print  # one source, nothing written
```

Secrets are named in `.env` at the helm root, never committed. `.env.example`
lists every name and its default.

### Todo syntax

`producers/sources/todos.py` reads open checkboxes off the four department notes. A
`### <directive>` heading under `## Todos` files the boxes below it under that
directive (ADR 0014), and indented lines under a box are its notes and subtasks. A
trailing `★1`, `★2` or `★3` on the heading stars the directive and weights its todos
(ADR 0027); the star is not part of the name:

```markdown
## Todos

### Launch ★1
- [ ] tailor resume for the Acme posting (due: 2026-09-18)
  Two pages. Lead with the route rebuild.
  - [ ] read the PDF once
  - [x] run resume-tailor
- [ ] apply to one role (daily) (done: 2026-09-22)
- [ ] coaching session (at: 2026-09-24 19:00)
- [ ] merge the feature branch done-when: pr merged example/repo#14
```

Three kinds. A plain box is a todo, due at 17:00 on its `(due: YYYY-MM-DD)` day or
undated. `(daily)` is a daily task: it is never ticked, `(done: YYYY-MM-DD)` records
the last day it was done, and it counts as done today when that is today. `(at:
YYYY-MM-DD HH:MM)` is an event at that moment. Markers may sit anywhere in the text
and are not part of it, so the content id survives adding a date. `done-when:
<predicate>` must be the tail. Age needs no date: the commit that added the line says
when it appeared.
Four predicates are understood, and a true one is reported, never ticked (ADR 0014):

```
pr merged <owner/repo>#<n>      gh pr view --json state; MERGED
tree clean <path>               git status --porcelain empty
metric <name> >= <value>        last row for <name> in ~/.helm/metrics/metrics.csv
file exists <path>              the path exists
```

A predicate that cannot run (gh down, path missing) keeps the previous answer, so a
known true never flips to unknown.

Writing a todo goes through `producers/todo_edit.py`, never by hand: `add` appends a
validated line under `## Todos` and commits in the vault, `tick <id>` and `untick <id>`
flip the box on the line with that content id. `edit <id>` rewrites the fields it is
given (`--text`, one of `--due` / `--daily` / `--at` / `--undated`, and `--project` or
`--unfile`) and leaves the rest alone, carrying the `done-when:` tail and a daily's
`(done:)` over untouched; a new directive moves the whole block, notes and subtasks with
it, and the same values in every field write nothing. `note <id> "<line>"` appends an
indented note under a todo, or a subtask box with `--sub`. `add` and `edit` refuse a text
that is already a box on that note, because the id is a hash of the note path and the
text, so two of them would share one address. Only the text is hashed, so rescheduling or
refiling a todo keeps its id. The `update-vault` skill, the `voice-todo` skill, and the
dashboard's toggle endpoint all call it. `HELM_VAULT_ROOT` (an absolute path) points the
producers at a copy of the vault, which is how the voice fixture runs headless.

## Session notes

`hooks/session_note.py` is registered on three Claude Code hooks in
`~/.claude/settings.json`. It is deterministic, calls no model, reads no transcript,
and finishes in about a tenth of a second.

| Hook | Does |
|---|---|
| `Stop` | Overwrites `status/sessions/<cwd key>/<session id>.md` with the latest assistant message, trimmed to 1500 characters, plus cwd, time, session id and branch. Keeps the newest 5 per folder |
| `SessionEnd` | Records `reason:` on that note |
| `SessionStart` | Prints the newest note for this folder, so a fresh session opens knowing where the last one stopped |

The cwd key is the folder's path under `$HOME` with `/` replaced by `__`, so
`~/Projects/helm2` becomes `Projects__helm2`. Nothing is ever written into the
session's own working directory, which is why a note helm writes cannot make a repo
read as dirty. `producers/sources/repos.py` joins the newest note onto each repo row
as `last_session`.
