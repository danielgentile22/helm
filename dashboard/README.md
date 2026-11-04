# dashboard

The server the next interface will be built on. The pressure map that used to live here
is gone; what remains is the Python server, its passkey door, and a page that says Helm.

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
| GET | `/*` | `dist/`, with `index.html` for any path without a dot. **open**, so a phone with no session can load the page |
| POST | `/auth/register/options`, `/auth/register/verify` | the passkey enrollment ceremony, gated by the one shot token from `serve.py --enroll` |
| POST | `/auth/login/options`, `/auth/login/verify` | the sign in ceremony; a good assertion sets the `otto_session` cookie |
| POST | `/auth/logout` | drops the session |
| GET | `/auth/me` | `{"via", "authenticated", "enrolled"}` |

Errors are one shape everywhere: `{"error": {"code", "detail"}}`. The routes of the
retired interface are in git history.

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

The passkey ceremony is still served, but the page that drove it is gone, so enrolling
waits for the next interface. Passkeys and sessions live under `~/.helm/dashboard-auth/`.

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
| `server/auth.py`, `server/passkey.py` | the passkey rows, and WebAuthn verification (ES256 on P-256) in the standard library |
| `server/test_*.py` | `python3 -m unittest discover -s dashboard/server -p 'test_*.py'` |
| `src/App.svelte`, `src/main.ts` | the placeholder page |
| `public/` | the app mark, its PNG sizes (`npm run icons`), and the manifest Chrome installs |
