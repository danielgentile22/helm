# The tailnet door is a passkey, and the phone holds the microphone

The dashboard now answers on two doors. On the Mac it is `http://127.0.0.1:8642/` and
nothing is asked. On the phone it is `https://<mac>.<tailnet>.ts.net:8643/`, fronted by
`tailscale serve`, and every `/api` request through that door carries a session cookie
that a WebAuthn assertion minted. Decided 2026-09-23, the day the mobile layout started.

ADR 0016 already drew this line: panels and the checkbox toggle may reach the tailnet
behind a passkey, and the phone reaching the dashboard is a configuration change rather
than a new decision. This record is that configuration, and the two things it settles
that 0009 left open.

## What the door is

- Every socket still binds to loopback only, and the door is the listener. The process
  opens two: the dashboard port is the loopback door, and a second loopback port
  (`OTTO_TAILNET_LOCAL_PORT`) is the only thing `tailscale serve` is pointed at. Every
  request on that second socket is stamped tailnet before a header is read, so which
  door a request came through is a fact of the socket and not a Host header the client
  chose. `app.via` then holds a Host allowlist on each door, so a hostname rebound to
  127.0.0.1 is still refused, and `app.authorize` asks the passkey gate on a tailnet row
  through the tailnet door and nothing else. Amended 2026-09-23, after the codebase
  review reproduced a tailnet request with `Host: localhost` walking through the
  loopback door with no session.
- A write from another site is refused in the same gate: any method but GET or HEAD
  whose `Origin` is not this server's own name for its door, or that carries
  `Sec-Fetch-Site: cross-site`. The desktop door asks no session, so without this a page
  in Daniel's browser could post a clip to the talk route and run the skill.
- Every route has one of three reaches. `open` is the page and its assets and the
  ceremony itself, because a phone with no session yet has to load the page to sign in.
  `tailnet` is everything the page reads and writes. `loopback` is reserved for anything
  that only means something on this machine, and today no row carries it.
- The ceremony is the same shape Helm 2.0 uses: a resident passkey with user
  verification required, so Face ID on every sign in, a 32 byte session token in an
  `HttpOnly; Secure; SameSite=Strict` cookie, thirty days. Enrollment is never reachable
  from the network on its own: `serve.py --enroll` writes a one shot token to a file the
  server reads, and a successful registration deletes it.
- The server stays standard library only (ADR 0021). `server/passkey.py` is the WebAuthn
  verification, ES256 on P-256, with the RFC 6979 known answer in its tests.

## The two things 0009 left open

**The voice rows graduate.** ADR 0016 and the route table held `/api/talk`, `/api/speak`
and the turn rows at loopback on the grounds that a microphone and speakers are one
machine's hardware. They are not: the browser records the clip and the browser plays the
reply, and the phone holding the microphone is the whole point of mobile. The run behind
a turn is one fixed skill on a transcript, not a shell, so it is not the "run anything"
row 0009 keeps at loopback forever. That row still does not exist.

**The installed app's two files graduate.** `sw.js` and the manifest were loopback so no
worker would cache Daniel's day on another origin. The tailnet origin is Daniel's own,
behind a passkey, and the phone cannot install the app without them.

## Consequences

- `OTTO_HOSTNAME` unset means loopback only, exactly as before, and none of `auth.py` is
  reached. The tailnet door is a setting, not a build.
- Passkeys, sessions and the pending enrollment token live under `runner/auth/`,
  gitignored. A new machine enrolls again; nothing here travels.
- A 401 anywhere sends the page back to the sign in screen without losing what it had.
