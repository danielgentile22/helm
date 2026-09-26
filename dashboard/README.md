# dashboard

One command:

```sh
python3 dashboard/serve.py
```

It builds `dist/` if the sources are newer than the last build, serves the build and
the API on `http://127.0.0.1:8642/`, and opens a browser. `--no-open`, `--no-build`,
`--port` and `--host` are there when you want them, and `HELM_DASHBOARD_PORT` sets the
default port.

On a machine where the service is installed, that same command finds helm already
answering, opens the browser and exits. Nothing has to be started first, and the
command in muscle memory keeps working.

The server is Python standard library only, a `ThreadingHTTPServer` in the same process
as the producers under `runner/producers/`, so the one write reaches
`todo_edit.set_done` as a function call rather than a subprocess (ADR 0021). Node is a
build time tool and nothing more.

## Routes

| Method | Path | Returns |
|---|---|---|
| GET | `/api/agenda`, `/api/projects` | `~/.helm/status/<name>.json` byte for byte, with `Date` and `ETag`. 304 on `If-None-Match`, 503 `unavailable` when capture has never run |
| PUT | `/api/todos/<id>/done` | `{"done": bool}` in, `{"id", "done", "changed", "commit", "line", "agenda_produced"}` out |
| PATCH | `/api/todos/<id>` | any of `{"text", "when", "project"}` in, `{"id", "changed", "commit", "line", "agenda_produced"}` out; a new text is a new `id` |
| POST | `/api/todos` | `{"text", "dept", "project", "when"}` in, `{"id", "changed", "commit", "line", "agenda_produced"}` out; 422 `refused` with a readable reason for a duplicate or a bad date |
| GET | `/api/health` | `{"ok", "now", "reach", "dist_built", "service"}` |
| POST | `/api/talk` | an `audio/*` clip in, `{"turn", "transcript", "ack", "ms"}` out; 415 for any other content type, 409 while a turn is working |
| GET | `/*` | `dist/`, with `index.html` for any path without a dot so a reload on a client route works. **open**: a phone with no session yet has to load the page to sign in |
| POST | `/auth/register/options`, `/auth/register/verify` | the passkey enrollment ceremony, gated by the one shot token from `serve.py --enroll` |
| POST | `/auth/login/options`, `/auth/login/verify` | the sign in ceremony; a good assertion sets the `otto_session` cookie |
| POST | `/auth/logout` | drops the session |
| GET | `/auth/me` | `{"via", "authenticated", "enrolled"}`, what the page asks once at load |

Errors are one shape everywhere: `{"error": {"code", "detail"}}`.

## The two doors

Every socket binds to loopback. On the Mac, `http://127.0.0.1:8642/` is the dashboard
and nothing is asked. With a tailnet name configured the same process opens a second
loopback listener on `HELM_TAILNET_LOCAL_PORT`, and that listener is the tailnet door:
`tailscale serve` terminates HTTPS on the tailnet and proxies to it, every request on it
is a tailnet request whatever Host header it carries, and every `/api` request through it
needs a session that a passkey assertion minted (ADR 0016, ADR 0025). The door is a fact
of the socket, never of a header a client chose. Set it up once:

```sh
# .env
HELM_HOSTNAME=<this-mac>.<tailnet>.ts.net
HELM_TAILNET_PORT=8643          # the HTTPS port on the tailnet
HELM_TAILNET_LOCAL_PORT=8644    # the loopback port behind it; nothing else dials this

tailscale serve --bg --https=8643 http://127.0.0.1:8644   # persists across reboots
launchctl kickstart -k gui/$(id -u)/com.helm.dashboard
python3 dashboard/serve.py --enroll                        # prints a ten minute link
```

The Host allowlist holds on both doors, so a hostname rebound to 127.0.0.1 is refused on
either. A write (anything but GET or HEAD) whose `Origin` is not this server's own name
for that door, or that arrives with `Sec-Fetch-Site: cross-site`, is refused in the same
gate, so a page on another site open in the desktop browser cannot post a clip to
`/api/talk` or cancel a turn through the loopback door. `/api/talk` also takes only an
`audio/*` content type.

Open the link on the phone, register the passkey with Face ID, then add the page to the
home screen. Passkeys, sessions and the pending enrollment token live under
`~/.helm/dashboard-auth/`, outside the repo. The server is still standard library only: the WebAuthn
verification, ES256 on P-256, is `server/passkey.py`.

The write is a PUT of desired state, never a toggle, so a retry, a double click and a
lost response all converge. A repeat answers 200 with `changed: false`. The content id
is the address, so no path crosses the wire (ADR 0015). After a change the server reruns
the todos source and re-merges `agenda.json`, and `agenda_produced` is that file's new
stamp. Writes into the vault hold the same `flock` the `update-vault` command line
interface holds, because the vault's git index is one shared writer.

`service` is `{"label": "com.helm.dashboard", "installed": bool}`, read from
`launchctl` at request time, so the interface can tell a dashboard someone started by
hand from one the service is keeping up.

## The service

`com.helm.dashboard` is a launchd agent that runs `dashboard/serve.py --no-open` at
login and restarts it whenever it exits, so the port is answering before anyone thinks
to look. It is installed by the same script that installs the routines and removed by
the same `--uninstall`:

```sh
runner/install-routines.sh                              # routines and the service
runner/install-routines.sh --uninstall                  # remove all of them
launchctl list | grep com.helm.dashboard                # is it loaded
launchctl kickstart -k gui/$(id -u)/com.helm.dashboard  # restart it now
tail -f ~/.helm/logs/com.helm.dashboard.err              # why it is unhappy
```

It keeps the build-if-stale behaviour, because that is the one command a fresh clone
and a stale checkout both converge on (ADR 0021). The cost is that the first login
after a source change spends a few seconds building before the port answers, and the
existing degradation path (serve the build that is already there when npm is missing
or the build fails) keeps that from being fatal.

Two copies never fight over the port. `serve.py` probes `/api/health` before binding:
helm already answering means it opens the browser and exits 0, and a listener that is
not helm is a one line message rather than a traceback.

The daily integrity check runs `runner/checks/check_service.py`, which reports an agent
that is loaded with nothing answering, and a service `models.json` names on a machine
that was never installed. It says so in words; nothing there is carried by colour.

The dashboard keeps working with no service installed. A fresh clone is still one
command away from a running dashboard.

## Reach

Loopback only today, with no authentication implemented. Every route still declares a
reach in the table in `server/routes.py`, and `authorize` is the first statement of
dispatch. It refuses on two counts, and both are needed:

- **the peer**, which must be 127.0.0.1 or `::1`.
- **the Host header**, which must be `127.0.0.1`, `localhost` or `[::1]`, bare or on the
  port the server is bound to. Anything else is 403 `forbidden` with the Host in the
  detail. Without this a page on any site can point a hostname it controls at 127.0.0.1
  and read `/api/agenda` as its own origin, because a rebound name is a loopback peer.
  The bound port reaches `authorize` on the request, set by `make_server` off the socket.

The passkey gate for `tailnet` routes lands in that one function when it is needed
(ADR 0016). Routes marked `loopback` never graduate, whatever is turned on around them.

## The installed app

helm installs as a Chrome app, so it opens in its own window with its own icon
instead of as one tab among thirty. Installing is a manual step, once per machine:

1. Open `http://127.0.0.1:8642/` in Chrome.
2. Install it: the icon in the address bar, or the three dot menu, Cast Save and
   Share, Install page as app.
3. It lands in `~/Applications/Chrome Apps/` and in the Dock and the app switcher,
   under the helm mark from `public/icon.svg`.

The manifest asks for `window-controls-overlay`, so the window keeps the full frame
with the traffic lights floating over helm's own top strip rather than a browser
toolbar eating it. It carries a stable `id`, so reinstalling is recognised as the
same app rather than a second one.

### The service worker

`src/sw.ts` is a thin wrapper over `src/lib/sw/policy.ts`, which is where every
caching rule lives and the only place one is expressed. The policy is a pure
function from a method and a path to one of three strategies:

| Request | Strategy | Why |
|---|---|---|
| `/assets/*` | cache first | the hash is in the name, so a hit is never the wrong bytes |
| the shell document | network first, cache as fallback | not hashed, so a stale copy must never win while the server answers |
| `GET /api/agenda`, `GET /api/projects` | network first, cache as fallback | a snapshot served from cache arrives as itself, with its own `produced` stamp, and the page classifies its age the way it always has (ADR 0020) |
| `PUT /api/todos/<id>/done` | network only | never cached, never queued, never retried. A failed write surfaces as a failed write |
| everything else | network only | straight through, untouched |

So a stopped server reads as closed rather than broken: the shell paints from cache,
the panels show the last snapshot they saw with its real age, and the app picks the
server back up on the next poll with no reload.

There are no deferred writes of any kind, and the closed set of strategies is asserted
in `src/lib/sw/policy.test.ts` so that adding one would have to be a deliberate edit
there first.

Registration lives in `src/main.ts` behind `import.meta.env.PROD`, so `npm run dev` is
not complicated by caching. A new worker skips waiting and claims open clients, so opening
the installed app after a build gets the new interface rather than the last one.

### Turning the cache off

A misbehaving worker on a local origin is annoying to clear by hand, so the way out is
written down before it is needed. Through Chrome: `chrome://serviceworker-internals`,
find `http://127.0.0.1:8642`, Unregister; or DevTools, Application, Service workers,
Unregister, and Application, Storage, Clear site data.

To ship the fix instead of clicking it, replace the body of `src/sw.ts` with a worker
that takes itself out, then `python3 dashboard/serve.py` and open the app once:

```ts
self.addEventListener("install", () => { void self.skipWaiting(); });
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) await caches.delete(name);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll()) client.navigate(client.url);
  })());
});
```

## Development

```sh
python3 dashboard/serve.py --no-open     # the API and the last build, on 8642
npm run dev                              # vite on 5173, proxying /api to 8642
```

`?sel=Life` on the URL zooms a department on load, for a screenshot.

Vite's dev server proxies `/api` to the Python server, so there is one API
implementation and the frontend knows one base URL. The proxy lives in
`vite.config.ts`.

## dist

`dist/` is built on demand and never committed. `serve.py` rebuilds it when anything
under `src/`, `index.html`, `public/`, `package.json` or `vite.config.ts` is newer than
`dist/.built`, running `npm install` first when `node_modules/` is missing. A fresh
clone and a stale checkout converge on the same first command. If npm is not installed
and a build is already there, it serves that build with a warning; if neither exists it
exits with a one line message.

## Files

| Path | What it is |
|---|---|
| `serve.py` | the launcher: probe the port, build if stale, then serve |
| `server/app.py` | request and response types, `authorize`, `dispatch`, the HTTP handler |
| `server/routes.py` | the route table and every handler |
| `server/test_routes.py` | `python3 -m unittest discover -s dashboard/server -p 'test_*.py'` |
| `src/lib/model/*.test.ts` | the model layer under `node --test`, run by `npm test` and `npm run check` |
| `src/lib/sw/policy.ts` | every caching rule, as a pure function. `policy.test.ts` is its table of cases |
| `src/sw.ts` | the worker entry: listeners, and the strategy the policy returns. Built to `dist/sw.js`, at the root so its scope is the whole origin |
| `tsconfig.sw.json` | the worker's own type check. DOM and WebWorker cannot share one program, so `npm run check:sw` covers `src/sw.ts` and `tsconfig.json` excludes it |
| `src/` | the Svelte client: `App.svelte` and the header, `lib/panels/Map.svelte` and the boxes, cells, rows and drawer under it |
| `src/lib/model/pressure.ts` | how hard a thing pulls and why, and a department's view of its directives. The one place the ranking lives |
| `src/lib/model/ink.ts` | what carries pull on the map: lead tiers, the rails and their scale, and the week band (ADR 0026) |
| `DESIGN.md` | the pressure map's design system, read before drawing anything new |
| `archive/observatory/` | the previous dashboard, the Approach disc, as it stood at tag `observatory-ui` (ADR 0024) |
| `public/icon.svg` | the app mark, and the favicon the page links. `npm run icons` rasterises it to the two PNG sizes the manifest names |
| `public/manifest.webmanifest` | what Chrome installs: the name, the stable `id`, the icons and `window-controls-overlay` |
| `prototypes/` | the design record, kept untouched (ADR 0021). `attention/` is the round that chose the map |
