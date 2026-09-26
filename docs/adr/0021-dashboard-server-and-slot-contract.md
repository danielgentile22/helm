# The dashboard is a Python stdlib server and a Vite build, and the slot is a handle

Decided 2026-09-17 after a three-candidate design round (opus, fable, sonnet, all
three independently choosing a Python server). The fable candidate is the base; the
PUT of desired state and the shared vault lock are grafted from the opus candidate.

## The server is Python stdlib, in process with the producers

`dashboard/server/` is a `ThreadingHTTPServer` on `127.0.0.1` with no dependencies,
started by `dashboard/serve.py`. Three reasons, in order. The one write reaches
`todo_edit.set_done` as a function call with a typed error, not a subprocess with an
argv boundary around a user-supplied id. The staleness rule already has one owner,
`runner/checks/check_freshness.py`, and the client mirrors it (twice the cadence)
rather than the server adding a second copy. And node stays a build-time tool: the
launch story on any host is `python3 dashboard/serve.py`.

Every route is a row in a table with a typed `Reach` column (`tailnet` or
`loopback`), and `authorize(request, reach)` is the first statement of dispatch, a
no-op on loopback today (ADR 0016). A route cannot be added without naming its reach.

| Method | Path | Reach | Returns |
|---|---|---|---|
| GET | `/api/agenda`, `/api/projects` | tailnet | the file, byte for byte, with `Date` and `ETag` |
| PUT | `/api/todos/<id>/done` | tailnet | `{"done": bool}` in, `{changed, commit, line}` out |
| PATCH | `/api/todos/<id>` | tailnet | any of `{text, when, project}` in, `{id, changed, commit, line}` out |
| GET | `/api/health` | tailnet | `{ok, now, reach}` |
| GET | `/*` | tailnet | `dist/`, `index.html` for paths without a dot |

The write is a PUT of desired state, never a toggle, so a retry, a double click and a
lost response all converge (`todo_edit.set_done` already reports `changed: false`).
The id is the address; no path crosses the wire (ADR 0015). One error shape:
`{"error": {"code", "detail"}}`. After a change the server re-merges `agenda.json`
from a fresh todos run (`capture.py --only todos` now re-merges from the caches), so
the file tells the truth within a second and the client's optimistic overlay expires by
the file's own `produced`.

The vault's git index is one real shared writer between the server and the
`update-vault` CLI, so `todo_edit.py` holds an `flock` around every write and commit,
and both callers pass through it.

## `dist/` is built on demand, never committed

`serve.py` runs `npm run build` when anything under `src/`, `index.html`, `public/` or
`package.json` is newer than `dist/.built`, so a fresh clone and a stale build converge
on the same first command. Development is `vite dev` proxying `/api` to the same Python
server, so there is one API implementation and the frontend knows one base URL.
Committed output would make every token tweak a binary diff and let source and build
disagree; a server that refuses to start on a missing build makes the first launch an
error.

## The model carries timestamps only, and `now` lives in one place

`decode(agenda, projects)` is the one place `unknown` becomes a typed `Model`. It holds
`Thing` rows (event, job, todo) with `at` and `since` as epoch milliseconds and never a
duration or a phase. `phase(thing, now)` classifies at read time (arriving, landed,
late with heat), which is what ADR 0020 bans storing in the files applied to the
client. `clock.svelte.ts` is the only reader of wall time, at two rates: once every
30 seconds for the panels and once per animation frame for the slot, with skew taken
from the server's `Date` header. Formatting uses `Intl.DateTimeFormat` on `agenda.tz`,
which replaces the prototype's offset sniffing off the first row and survives the DST
boundary inside the 35-day window.

The panels and the instrument read the same `Model` with the same `phase()`, which is
how ADR 0017's redundancy stays structural rather than a habit.

## The instrument is a component that attaches a handle

An instrument is a Svelte component that renders its own canvas and calls
`slot.attach({render, resume, onPalette, hit, onEmptyClick, shown})`. The slot gives it a runtime:
the model, size, selection, hover and focus, the palette, reduced motion, geometry, a
label placer with hysteresis, and `select()` and `open()` to report clicks. Neither
side names a three.js or Threlte type (ADR 0018). The Threlte instrument switches
Threlte's own animation loop off at component init and steps its scheduler from
`render(frame)`, calling `invalidate()` and then `scheduler.run(elapsed)`, so the
slot's clock is the only loop and three.js exists only inside its scene component. A
dev-only check that three.js's frame counter has not moved between two slot frames is
what holds that, rather than the comment saying so.
`shown()` returns the ids the canvas labelled legibly; the panel carries the rest.
An instrument cannot hand the panel text, only point at things.

## Consequences

- `dashboard/prototypes/` stays untouched as the record. The shared modules are ported
  into `dashboard/src/lib/slot/` as ES modules with verdict section 5's changes.
- No websocket. The files change every 30 minutes and a toggle answers in its
  response; a 60 second ETag poll while visible is enough.
- The passkey gate for `tailnet` routes lands in `authorize()` and nowhere else.
- A second instrument is a line in the registry and a dynamic import, so three.js
  stays out of the entry chunk and a raw WebGL or WebGPU instrument loads none of it.

## Amended 2026-09-22: a second write

The drawer edits a todo's text, date and directive through `PATCH /api/todos/<id>`, which
calls `todo_edit.edit` under the same lock and commits the same way the toggle does. Only
the named fields are rewritten, and sending what is already there changes nothing. The
content id is over the text, so a reworded todo answers with its new `id` and the client
follows it.
