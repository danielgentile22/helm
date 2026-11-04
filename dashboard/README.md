# dashboard

The four tabs (ADR 0037) and the server behind them: a Python server, its passkey door, and
a Svelte page that reads the routes below and makes the writes ADR 0038 allows.

```sh
python3 dashboard/serve.py
```

It builds `dist/` if the sources are newer than the last build, serves the build and
the API on `http://127.0.0.1:8642/`, and opens a browser. `--no-open`, `--no-build`,
`--port` and `--host` are there when you want them, and `HELM_DASHBOARD_PORT` sets the
default port. On a machine where the service is installed, the same command finds helm
already answering, opens the browser and exits.

The server is Python standard library only (ADR 0021). Node is a build time tool and
nothing more.

## Routes

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{"ok", "now", "reach", "dist_built", "service"}`. The integrity check and `serve.py` both probe it |
| GET | `/api/projects` | every project, from `~/.helm/status/projects.json` (below) |
| GET | `/api/projects/<slug>` | one project with its issue list and open ideas |
| GET | `/api/ideas?status=` | idea notes, read from the vault per request |
| GET | `/api/background` | every routine and service, assembled per request |
| GET | `/api/devices` | device notes with live tailnet presence |
| POST | `/api/ideas` | `{title, project?, department?, due?}` adds an idea and commits it in the vault. 201 with `{"idea", "changed"}` |
| POST | `/api/ideas/<id>/status` | `{status: open\|done\|dropped}`. 200 with `{"idea", "changed"}`, 404 for an unknown id |
| POST | `/api/ideas/<id>/due` | `{due: "YYYY-MM-DD"\|null}`. 200 with `{"idea", "changed"}`, 404 for an unknown id |
| POST | `/api/ideas/<id>/promote` | `{repo?, confirm?}` files the idea as an issue in its project's tracker. 200 with `{"idea", "issue", "changed"}`; 409 `{"needs_confirm": true, "repo"}` for a GitHub repo someone else owns until `confirm: true` |
| POST | `/api/routines/<name>/run`, `/pause`, `/resume` | a routine in `models.json` only. 200 with `{"routine", "changed"}`, 409 when the state refuses it |
| GET | `/api/alerts` | `{"alerts", "counts", "total"}`: every open, undismissed alert (shape in `docs/data-shapes.md`), newest first, with a count per tab |
| POST | `/api/alerts/<key>/dismiss` | hides one alert until its fingerprint changes. 200 with `{"alert", "changed"}`, 404 for an unknown key. A key with `#` in it is sent encoded |
| GET | `/api/push/key` | `{"key"}`, the VAPID public key the browser subscribes with |
| POST | `/api/push/subscribe` | the browser's `PushSubscription.toJSON()`. 200 with `{"changed"}`; the same endpoint twice keeps one row |
| POST | `/api/push/unsubscribe` | `{endpoint}`. 200 with `{"changed"}` |
| POST | `/api/push/test` | **loopback only**. Sends "Test notification from helm" to every subscription and answers `{"sent", "removed", "failed"}` |
| GET | `/*` | `dist/`, with `index.html` for any path without a dot. **open**, so a phone with no session can load the page |
| POST | `/auth/register/options`, `/auth/register/verify` | the passkey enrollment ceremony, gated by the one shot token from `serve.py --enroll` |
| POST | `/auth/login/options`, `/auth/login/verify` | the sign in ceremony; a good assertion sets the `otto_session` cookie |
| POST | `/auth/logout` | drops the session |
| GET | `/auth/me` | `{"via", "authenticated", "enrolled"}` |

`/sw.js` is the service worker: it shows an alert's push, sets the app icon's badge to the
push's count, and opens the app at the alert's tab when the notification is tapped. It caches
nothing.

Errors are one shape everywhere: `{"error": {"code", "detail"}}`. The routes of the
retired interface are in git history. Every `/api` row reaches `tailnet`: free on
loopback, behind the passkey over the tailnet (ADR 0016, ADR 0038).

### The writes

- **Ideas** go through `runner/producers/idea_edit.py` in process, under the vault write
  lock. Each write that changes a note is one vault commit with a fixed subject (`Add an
  idea`, `Mark an idea done`, `Drop an idea`, `Reopen an idea`, `Change an idea's due
  date`), never the idea's text; a commit that fails puts the note back as it was. A
  title is 1 to 200 characters on one line, a project is a project note's title, a due
  date is ISO. Setting what is already set writes nothing and answers `changed: false`.
  A promoted idea is 409.
- **Promotion** goes through `idea_edit.promote` under the same lock. The idea must be open
  and belong to a project whose tracker is `github` or `scratch`; `none`, or an idea that is
  not open, is 409. A GitHub project with several GitHub repos needs `repo`. The issue is
  filed first (`gh issue create`, or a numbered file in `<workspace>/.scratch/ideas/issues/`),
  then `issue:` and `status: promoted` are written and committed as `Promote an idea`.
  When the repo's owner is not the `gh` user (asked once per process), the answer is 409
  with `needs_confirm` and nothing is filed until the page sends `confirm: true` (ADR 0038).
  A promoted idea answers its issue again with `changed: false`. A tracker that fails is
  502 and writes nothing. When the issue is filed but the vault commit fails, the answer
  is 500 with `issue` beside the error, the note keeps `issue:`, and promoting again
  commits that issue without filing another.
- **Routines** go through `server/control.py`. Run is `launchctl kickstart`, refused with
  409 while the routine is paused, running or not loaded. Pause boots the job out, then
  moves its plist from `~/Library/LaunchAgents/` to `~/.helm/disabled/`; resume moves it
  back and bootstraps it. Both read both places every time, so a repeat or a retry after
  an interruption finishes the job, and pause refuses a routine that is running right
  now. `install-routines.sh` leaves a paused routine paused. Services have no write rows.
- Log lines never carry an idea's id (it is made from the title) or any request body.

### Notifications

An alert (ADR 0039) pushes once to every enrolled browser, puts its count on its tab and on
the header, and sets the number on the app icon. `runner/alerts.py` decides what is open;
`scripts/push.mjs` sends, with the VAPID keys it made once in `~/.helm/push/vapid.json`.
Subscriptions are in `~/.helm/push/dashboard.json`. A push carries only `{title, tab,
count}`, so no idea text or log line ever passes through Apple. Set `HELM_PUSH_SUBJECT` in
`.env` to a `mailto:` you own; the placeholder works for testing.

To turn them on for the iPhone:

1. Open the tailnet address in Safari and sign in with the passkey.
2. Tap Share, then Add to Home Screen. iOS delivers Web Push to home screen apps only.
3. Open helm from the home screen icon, sign in again if asked, tap the bell in the
   header, then Turn on notifications, and allow them when iOS asks.
4. On the Mac, `curl -X POST 127.0.0.1:8642/api/push/test` should answer `"sent": 1` and the phone shows "Test
   notification from helm".

The bell asks for permission only on a tap, which iOS requires. In Safari outside the home
screen app it explains step 2 instead.

## The tabs' JSON

The contract the interface is built against. Times are ISO 8601 with an offset, and the
reader subtracts (ADR 0020). Fields beyond the ones named here may be added; none named
here will change meaning.

### Projects

`GET /api/projects` reads the file capture writes every 30 minutes and calls nothing, so a
page load never reaches GitHub (ADR 0037).

```json
{
  "produced": "2026-11-04T08:00:00-05:00",
  "error": "github: network: gh pr list -R example/keel: ...",
  "projects": [{
    "slug": "keel",
    "title": "Keel",
    "note": "Atlas/Projects/Keel.md",
    "status": "active",
    "pinned": true,
    "tracker": "github",
    "pull_requests_scope": "all",
    "repos": [{"name": "keel", "path": "~/Projects/keel", "github": "example/keel"}],
    "issues": {"open": 2, "by_status": {"ready-for-agent": 1, "open": 1}},
    "pull_requests": [{"repo": "keel", "number": 7, "title": "Export leads as CSV",
                       "url": "https://github.com/example/keel/pull/7", "draft": false,
                       "ci": "pass", "author": "jordan", "branch": "lead-export"}],
    "branches": [{"repo": "keel", "name": "lead-export", "ahead": 2, "at": "2026-11-03T10:00:00+00:00"}],
    "last_commit": {"at": "2026-11-03T10:00:00+00:00", "repo": "keel", "subject": "Export leads"},
    "ideas_open": 1,
    "problems": []
  }]
}
```

- `error` is null when every capture source behind the file is succeeding. Otherwise it
  names each failing one and why, and the rows are that source's last good ones. Before
  capture has ever run, `projects` is empty and `error` says so.
- Order: pinned first, then the newest commit or branch, then the title.
- `note` is null for a folder under `~/Projects` that no project note names, so drift
  shows. Its `status` is null too. Notes with `status: archived` are left out, and so is
  the folder they name.
- `tracker` is `github`, `scratch` or `none`. `issues` is null for `none`, and for a
  GitHub tracker that GitHub has not answered for yet: unknown, never zero. With
  `scratch`, `by_status` counts the `Status:` lines of the open files (a file with none
  counts as `open`); with `github`, the first triage label, else `open`. GitHub's list
  is capped at 50.
- `ci` is `pass`, `fail`, `pending` or `none`: any failed check is a fail, then any
  unfinished one is pending.
- With `pull_requests_scope: "mine"`, `pull_requests` holds only the GitHub user's own,
  and `branches` only those whose last commit carries the repo's `git config
  user.email`.
- `branches` are local branches not merged into the default branch. `last_commit` is the
  newest on any local branch of any of the project's repos.
- `problems` names note fields this could not use, and what it read instead.

`GET /api/projects/<slug>` is one entry with `produced` and `error` beside it, plus:

```json
{
  "issues_list": [{"id": "importer/01", "title": "Stream large PGN files", "status": "ready-for-agent",
                   "url": null, "path": "~/Projects/compiler/.scratch/importer/issues/01-stream.md",
                   "repo": "importer", "updated": "2026-11-02T10:00:00-05:00"}],
  "ideas": ["the open ideas for this project, each an idea record as below"]
}
```

A scratch issue's `id` is `<effort>/<number>`, its `repo` the file's `Repo:` line; a
GitHub issue's is `<repo>#<number>` with a `url`. `ideas` and `ideas_open` are read from
the vault at request time. An unknown slug is 404.

### Ideas

`GET /api/ideas?status=open|done|dropped|promoted|all`, `open` when absent, anything else
400. Read from the vault per request through `idea_edit.parse_idea`.

```json
{
  "ideas": [{"id": "2026-11-01-book-the-lisbon-flights", "path": "Atlas/Ideas/2026-11-01-book-the-lisbon-flights.md",
             "title": "Book the Lisbon flights", "created": "2026-11-01", "status": "open",
             "department": "Life", "project": null, "due": "2026-11-15", "issue": null}],
  "errors": ["Atlas/Ideas/2026-11-02-x.md: unknown status 'someday', want one of open, done, dropped, promoted"]
}
```

Soonest due first, undated after, newest first within each. A note that does not parse is
named in `errors` and the rest are still listed.

### Background

`GET /api/background` assembles the routine record of `docs/data-shapes.md` per request
from `models.json`, `launchctl list`, `~/.helm/disabled/`, `~/.helm/status/<name>.json` and
`~/.helm/logs/`.

```json
{
  "routines": [{
    "name": "backup", "kind": "routine", "schedule": "daily 09:00 and on mount",
    "model": null, "effort": null, "why": "...",
    "label": "com.helm.backup", "loaded": true, "running": false, "last_exit": 0,
    "paused": false,
    "last_run": "2026-11-03T14:00:05+00:00",
    "result": "fail", "result_text": "volume absent", "failures": null,
    "last_success": "2026-10-25T16:30:51+00:00",
    "next_run": "2026-11-04T09:00:00-05:00",
    "log_tail": ["..."], "log_updated": "2026-11-03T14:00:05+00:00"
  }],
  "services": [{
    "name": "dashboard", "kind": "service", "why": "...", "listed": true,
    "label": "com.helm.dashboard", "loaded": true, "running": true, "last_exit": -15,
    "log_tail": ["..."], "log_updated": "2026-11-04T07:50:00+00:00"
  }]
}
```

- `result` is `paused` when the plist is in `~/.helm/disabled/`, else `pass` for a status
  file that says `pass`, `ok` or `fresh`, `unknown` with no status file, and `fail` for
  anything else. `result_text` is what the file said.
- `last_run` reads `last_run`, or backup's `ran`. `last_success` reads the file's own
  (backup's epoch seconds become ISO), else `last_run` when that run passed.
- `next_run` is null while paused. `log_tail` is the last 40 lines of whichever of
  `com.helm.<name>.err` and `.out` was written last.
- Services are the `services` in `models.json` (`listed: true`) and any other loaded
  `com.helm.*` job (`listed: false`).

### Devices

`GET /api/devices` reads every `type: device` note in Atlas and joins it to
`tailscale status --json` on the note's `tailnet` host name. The tailnet answer is asked
with a 3 second limit and kept for 30 seconds.

```json
{
  "devices": [{
    "slug": "studio-desk-mac", "title": "Studio desk Mac", "kind": "desktop",
    "status": "in service", "role": "always-on host for helm and T3 Code", "t3": "host",
    "tailnet": "studio-desk", "specs": {"chip": "M5 Max", "memory": "64 GB"},
    "purchased": "2026-09-23", "warranty_until": "2029-09-23",
    "path": "Atlas/Life/Devices/Studio desk Mac.md",
    "presence": {"online": true, "last_seen": null},
    "problems": []
  }],
  "tailnet_error": null
}
```

- `presence` is null when the note has no `tailnet`, and for every device when the
  tailnet could not be asked, with `tailnet_error` saying why. A name the tailnet does
  not know is `{"online": false, "last_seen": null}`.
- A value outside its set is kept as written and named in `problems`; a malformed date,
  or a `specs` that is not a map, reads as null. One bad note never fails the route.
- Sorted in service first, then ordered, spare, retired, sold, then by title.

## The two doors

Every socket binds to loopback. On the Mac, `http://127.0.0.1:8642/` is the dashboard
and nothing is asked. With a tailnet name configured the same process opens a second
loopback listener on `HELM_TAILNET_LOCAL_PORT`, and that listener is the tailnet door:
`tailscale serve` proxies to it, and every `/api` request through it needs a session a
passkey assertion minted (ADR 0016, ADR 0025). The door is a fact of the socket, never
of a header a client chose.

```sh
# .env
HELM_HOSTNAME=<this-mac>.<tailnet>.ts.net
HELM_TAILNET_PORT=8643          # the HTTPS port on the tailnet
HELM_TAILNET_LOCAL_PORT=8644    # the loopback port behind it; nothing else dials this

tailscale serve --bg --https=8643 http://127.0.0.1:8644
launchctl kickstart -k gui/$(id -u)/com.helm.dashboard
```

The page signs in with the passkey when a read or a write answers 401; enrolling still runs from
`serve.py --enroll`. Passkeys and sessions live under `~/.helm/dashboard-auth/`.

`authorize` is the first statement of dispatch. It checks the peer (127.0.0.1 or `::1`)
and the Host header (a loopback name, or the tailnet name on the tailnet listener), so a
page on another site cannot rebind a hostname to 127.0.0.1 and read the API as its own
origin. A write whose `Origin` is not this server's, or that arrives marked
`Sec-Fetch-Site: cross-site`, is refused in the same gate.

## The service

`com.helm.dashboard` is a launchd agent that runs `dashboard/serve.py --no-open` at
login and restarts it whenever it exits. It is installed and removed with the routines:

```sh
runner/install-routines.sh                              # routines and the service
runner/install-routines.sh --uninstall                  # remove all of them
launchctl kickstart -k gui/$(id -u)/com.helm.dashboard  # restart it now
tail -f ~/.helm/logs/com.helm.dashboard.err              # why it is unhappy
```

`serve.py` probes `/api/health` before binding, so two copies never fight over the port.
The daily integrity check runs `runner/checks/check_service.py`, which reports an agent
that is loaded with nothing answering.

## Development

```sh
python3 dashboard/serve.py --no-open     # the API and the last build, on 8642
npm run dev                              # vite on 5173, proxying /api to 8642
npm run check                            # svelte-check
```

`dist/` is built on demand and never committed. `serve.py` rebuilds it when anything
under `src/`, `index.html`, `public/`, `package.json` or `vite.config.ts` is newer than
`dist/.built`.

## Files

| Path | What it is |
|---|---|
| `serve.py` | the launcher: probe the port, build if stale, then serve |
| `server/app.py` | request and response types, `authorize`, `dispatch`, the HTTP handler |
| `server/routes.py` | the route table and its handlers |
| `server/background.py`, `server/devices.py` | the Background and Devices records, as functions of what they are handed |
| `server/machine.py` | everything asked of or told to the machine: `launchctl list`, `tailscale status`, the `launchctl` writes and where `LaunchAgents` is. Tests replace all of it |
| `server/control.py` | run now, pause and resume a routine, convergent from any state between the two |
| `server/auth.py`, `server/passkey.py` | the passkey rows, and WebAuthn verification (ES256 on P-256) in the standard library |
| `server/test_*.py` | `python3 -m unittest discover -s dashboard/server -p 'test_*.py'` |
| `src/App.svelte`, `src/app.css` | the shell: header, the tab rail or tab bar, the colour tokens |
| `src/lib/` | `api.ts` (the contract above as types, one `fetchJson`), `route.svelte.ts` (the URL is the state), `poll.svelte.ts` (each open tab refetches every 60 seconds and on focus), `auth.ts` (the sign in ceremony), `ideas.svelte.ts` (an idea list's writes, drawn before the server answers, with undo), `time.ts` |
| `src/tabs/` | one component per tab, plus the project, routine, device and idea cards |
| `src/ui/` | the small parts: dot, pill, badge, icons, load states, the capture box, the toast |
| `public/` | the app mark, its PNG sizes (`npm run icons`), and the manifest Chrome installs |
