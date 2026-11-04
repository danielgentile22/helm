# Data shapes

The records the tabs are built on (ADRs 0037 and 0039). Projects, ideas and devices are
vault notes the owner can read and edit by hand. The routine record is assembled per
request, and alerts live in State. Examples use the demo vault's cast.

## Project

The existing project note, with two optional fields added. Found anywhere in Atlas by
`type: project`.

```yaml
---
type: project
title: Keel
status: active            # active | dormant | shipped | archived
repo: ~/Projects/keel      # a repo, or a workspace folder holding several
tracker: github           # github (default when the repo has a GitHub remote) | scratch | none
pull_requests: all        # all (default) | mine: only the owner's own branches and pull requests
pinned: true              # optional, sorts first
---
```

- `tracker: scratch` reads `<repo>/.scratch/*/issues/*.md`. Each file's `Status:` line is
  one of the five triage labels; `resolved` and `wontfix` count as closed.
- With `tracker: scratch` the repos under the workspace are still read for branches,
  pull requests, last commit and CI, filtered by `pull_requests`.
- Capture writes what the tab shows to `~/.helm/status/projects.json`, one entry per
  project: open issues by status, open pull requests, unmerged branches, last commit, CI
  result. The tab never calls GitHub.

## Idea

One note per idea at `Atlas/Ideas/<created>-<slug>.md`.

```yaml
---
type: idea
created: 2026-11-01
status: open              # open | done | dropped | promoted
project: Keel             # a project title, optional
department: Projects      # Work | Projects | Chess | Life; derived from project when set
due: 2026-11-15           # optional
issue: https://github.com/example/keel/issues/12   # set on promotion
---
Let Priya export the Lisbon itinerary as a calendar file

Anything else, in any shape.
```

- The first body line is the title. The capture box writes only that line plus
  frontmatter.
- An idea with neither project nor department gets `department: Life` until edited, so
  nothing is unfiled.
- Promotion to a scratch tracker writes `<repo>/.scratch/ideas/issues/<NN>-<slug>.md`
  with `# <title>`, `Status: needs-triage`, a `Repo:` line when one is named, and the
  rest of the idea's body, and sets `issue:` to that path. Promotion to GitHub files the
  title and the rest of the body, plus a line saying it came from helm, and sets
  `issue:` to the issue URL. `issue:` is written before `status: promoted`, so an open
  idea with an `issue:` is a promotion whose commit failed, and promoting it again
  records that issue instead of filing another.
- Editing rewrites the title line, the notes after it (`notes` in the row), or the
  project. The file name keeps its first slug, so the id never changes. A promoted idea
  is not edited; it lives on in its issue.
- Every write is a vault commit whose subject names the action only: `Add an idea`,
  `Edit an idea`, `Promote an idea`, `Drop an idea`.

## Device

The existing device page, with frontmatter added. One note per device, found anywhere in
Atlas by `type: device`. The page's prose (Identity, Role, State, History) stays as it is.

```yaml
---
type: device
title: Studio desk Mac
kind: desktop             # desktop | laptop | phone | tablet | watch | display | dock | storage | network | audio | camera | home
status: in service        # ordered | in service | spare | retired | sold
role: always-on host for helm and T3 Code
t3: host                  # host | client | none
tailnet: studio-desk      # tailnet host name, optional; joins live presence
specs:                    # free map, shown as a table
  chip: M5 Max
  memory: 64 GB
  storage: 2 TB
purchased: 2026-09-23
warranty_until: 2029-09-23
---
```

- Online status and last seen come from `tailscale status --json` at request time, joined
  on `tailnet`. A device with no `tailnet` shows no presence, not "offline".
- Live usage comes only for the machine the dashboard runs on, the tailnet's `Self`: memory
  used (counted the way Activity Monitor counts it) and memory pressure, disk used on the
  Data volume, the one-minute load against the core count, and boot time. Read fresh per
  request; each part is null when its probe fails. Every other device has `usage: null`.
- Devices that today share a note (a phone and a watch in one page) get a page each.

## Routine record

Not stored. Assembled per request from four sources, so the Background tab never
disagrees with the machine.

| Field | From |
|---|---|
| `name`, `schedule`, `model`, `why` | `models.json` |
| `kind` | `routine` when `models.json` lists it, `service` for any other `com.helm.*` job |
| `loaded`, `running`, `last_exit` | `launchctl list` |
| `paused` | its plist is in `~/.helm/disabled/` |
| `last_run`, `result`, `failures`, `last_success` | `~/.helm/status/<name>.json`, normalised at the boundary (backup writes `ran` and epoch seconds; the rest write `last_run`) |
| `next_run` | `runner/schedule.py` `next_fire`, unless paused |
| `log_tail` | the last lines of `~/.helm/logs/com.helm.<name>.err` and `.out` |

Run now is `launchctl kickstart`; pause and resume move the plist and boot it out or in.
Services can be restarted from loopback only.

## Alert

One file per alert at `~/.helm/alerts/<key>.json` (ADR 0039). The key names what the
alert is about, so evaluating the same condition twice rewrites the same file.

```json
{
  "key": "routine:backup",
  "tab": "background",
  "title": "backup failed: volume absent",
  "opened": "2026-11-04T09:00:04Z",
  "fingerprint": "volume absent",
  "pushed": "2026-11-04T09:00:05Z",
  "dismissed": null,
  "closed": null
}
```

- `tab` is one of `projects`, `ideas`, `background`, `devices`.
- `fingerprint` is what the condition looked like when it opened. A dismissed alert
  stays hidden while the fingerprint matches and reopens, and pushes again, when it
  changes.
- An alert counts toward the badges while `closed` and `dismissed` are both null. The
  app icon shows the total; each tab shows its own count.
- Closed alerts older than a week are deleted on the next evaluation.
- Push subscriptions are in `~/.helm/push/dashboard.json`, one per enrolled browser.
