# Setting up a Helm 2.0 host

One checklist for a new machine. Today that is the MacBook; the same steps move it to the
always-on desktop. Every step is safe to repeat.

## 1. Prerequisites

- macOS with Node 25 or newer and npm.
- Claude Code installed and logged in for the user who will run the server (`claude` works in a terminal).
- Tailscale installed, logged in, and set to start at login. Check `tailscale status` shows this
  machine and the phone. Nothing here is reachable until Tailscale is running.
- The vault at `~/Projects/Vault` (or set `HELM_VAULT_ROOT`).

## 2. Install

```
cd ~/Projects/helm2
npm ci
npm run build:client
cp .env.example .env
```

Fill in `.env`:

- `HELM_API_KEY`: a long random string, for curl. `openssl rand -hex 32` is fine.
- VAPID keys: `npx web-push generate-vapid-keys` prints a public and a private key. Subject is a
  `mailto:` address.
- `HELM_BIND_ADDR`: `tailscale ip -4`.
- `HELM_HOSTNAME`: the machine's tailnet DNS name without the trailing dot, for example
  `mac.tail1234.ts.net`. Get it from `tailscale status --self --json | jq -r .Self.DNSName`.
  This is the passkey relying party id, so it must match the address the phone opens exactly.

Check it boots:

```
npm start
```

It prints the listen address and, with no passkey enrolled yet, a one-shot enrollment link.
Stop it with Ctrl-C.

## 3. HTTPS over the tailnet

Passkeys, service workers, and web push all require a secure context. Tailscale provides real
certificates for `*.ts.net`:

```
tailscale serve --bg 8420
```

That serves `https://<HELM_HOSTNAME>` and proxies to the server on port 8420. It persists across
reboots. `tailscale serve status` shows it. Never use Funnel; the app must stay tailnet-only.

## 4. Run it under launchd

```
ops/install.sh
```

This renders and loads two user agents: `com.helm2.server` (KeepAlive, restarts on crash, logs to
`~/.helm2/server.log`) and `com.helm2.caffeinate` (`caffeinate -dims`, keeps the Mac awake).
Rerun the script after pulling changes; it is idempotent. `ops/uninstall.sh` removes both.

Boot is idempotent by design: the server repairs any torn log, seals any turn that was open when
it died, and refuses to start if another instance holds `~/.helm2/helm.lock`.

## 5. Enroll the phone

The server prints an enrollment link when no passkey exists. Read it from the log:

```
grep enroll ~/.helm2/server.log | tail -1
```

Open that link on the phone in Safari within ten minutes. It creates a passkey with Face ID and
then asks you to sign in. The link works once. To enroll another device later:

```
curl -s -X POST -H "X-Helm-Key: $HELM_API_KEY" https://<HELM_HOSTNAME>/auth/enroll
```

## 6. Install to the home screen

In Safari on the phone: Share, then Add to Home Screen. Open Helm from the home screen from now
on; push notifications only work from the installed app. Tap Notifications in the thread list to
enable them.

## 7. Verify

- Thread list loads with no prompt on a second open.
- New thread, send a message, watch it stream.
- Lock the phone mid-turn, wait, unlock: the transcript catches up with no gap.
- Put the phone down during a turn: a notification arrives when it finishes.
- `curl -H "X-Helm-Key: ..." https://<HELM_HOSTNAME>/api/threads` works from the Mac.

Manual passkey check recorded here because the WebAuthn library ships no test authenticator: the
assertion path is verified on the phone at step 5, not in the test suite.

## Moving to the always-on desktop

Repeat steps 1 to 6 on the new machine, then copy `~/.helm2` from the old one (thread history,
sessions, push subscriptions, credentials). The passkey's relying party id is the hostname, so a
new hostname means enrolling the phone again. Stop the old server first so two instances never
write the same logs.

## Not yet built

Nightly off-machine sync of `~/.helm2`. The destination is not chosen; it should share the
vault's backup destination.
