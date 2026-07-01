# Deploy the HELM chat brain to Fly.io

The chat brain — the existing Next app (`/chat` + `/api/chat`), the `claude`
CLI, and a synced copy of the vault — runs on one always-on Fly VM, reachable
from the phone/laptop **only over Tailscale** (no public internet surface). The
Mac keeps running full HELM unchanged. The vault stays identical on both sides
via two-way Syncthing over the tailnet.

Files: `Dockerfile`, `entrypoint.sh` (supervises tailscaled → syncthing → next),
`fly.toml` (volume at `/data`, no public service, always-on).

---

## One-time setup

### 0. Prerequisites
- `flyctl` installed and logged in (`fly auth login`) — Daniel already uses Fly for Morphy.
- A [Tailscale](https://tailscale.com) account with the Mac and phone already on the tailnet.
- The Mac's vault at `/Users/user/Projects/Vault` (~28 MB).

### 1. Claude auth token (on the Mac)
```bash
claude setup-token        # prints a long-lived OAuth token
```
Copy the token — it becomes the `CLAUDE_CODE_OAUTH_TOKEN` secret below. (This is
how the headless `claude -p` on the VM authenticates without a login.)

### 2. Tailscale auth key
In the Tailscale admin console → **Settings → Keys → Generate auth key**. Make it
**reusable** and ideally **ephemeral + tagged** (e.g. `tag:helm`). Copy it — it
becomes `TS_AUTHKEY`.

### 3. Create the app, volume, and secrets
```bash
fly apps create helm-chat
fly volumes create vault_data --size 3 --region iad   # persistent /data
fly secrets set \
  TS_AUTHKEY='tskey-auth-…' \
  CLAUDE_CODE_OAUTH_TOKEN='…from step 1…'
```
`fly.toml` already sets the non-secret env (`VAULT_ROOT=/data/vault`,
`HUD_TZ=America/New_York`, `CLAUDE_BIN=claude`, `PORT=3107`, `TS_HOSTNAME=helm-chat`).
No `NOTION_TOKEN` — Morphy is read-only, answered from the synced
`system/morphy-state.json`.

### 4. Deploy
```bash
fly deploy
fly scale count 1     # exactly one always-on machine
```
On boot the entrypoint joins the tailnet, starts Syncthing, then `next start`.
`fly logs` prints the tailnet IP (`tailnet IP: 100.x.y.z`). With MagicDNS the
host is `helm-chat`.

### 5. Pair Syncthing (Mac ↔ VM) — the vault sync
The vault folder is shared two-way over the tailnet. Both Syncthing GUIs are
reachable only via the tailnet (no public port):

1. **VM GUI:** open `http://helm-chat:8384` (or `http://100.x.y.z:8384`).
2. **Mac:** install Syncthing (`brew install syncthing && brew services start syncthing`),
   open `http://localhost:8384`.
3. On the Mac, **Add Remote Device** → paste the VM's Device ID (VM GUI → Actions → Show ID).
   On the VM, accept the Mac. (Connect over the tailnet addresses.)
4. On the Mac, **Add Folder** → the vault (`/Users/user/Projects/Vault`),
   share it with the VM. On the VM, accept the shared folder and set its path to
   **`/data/vault`**. Let the first sync converge (~28 MB).

Verify: a note edited in Obsidian appears under `/data/vault` on the VM, and a
chat that writes a note shows up in Obsidian on the Mac.

### 6. Smoke test
```bash
./scripts/smoke-fly.sh            # or: ./scripts/smoke-fly.sh 100.x.y.z
```
Checks `/chat` serves 200 and `/api/chat` returns a real reply (spends a few tokens).

### 7. Phone / laptop access
- Install the **Tailscale** app, sign into the same tailnet.
- Open `http://helm-chat:3107/chat` (or `http://100.x.y.z:3107/chat`).
- Phone: **Share → Add to Home Screen** for an app icon.
- Laptop: same URL, nothing else to install beyond Tailscale.

---

## Redeploy (the routine)
After changing the app on the Mac:
```bash
fly deploy && ./scripts/smoke-fly.sh
```
That's the whole loop — secrets, volume, and Syncthing pairing persist.

---

## Operating notes
- **Always-on:** no `[http_service]` in `fly.toml` → nothing public and Fly's
  autostop never applies. `fly scale count 1` keeps one machine up.
- **A daemon dies → clean restart:** the entrypoint takes the container down if
  tailscaled, syncthing, or next exits; Fly restarts the machine rather than
  leaving it half-dead.
- **Sync conflicts:** rare, only when Obsidian and chat edit the *same* note in
  the same window. Syncthing writes a non-destructive `*.sync-conflict-*` file —
  search the vault for `sync-conflict` occasionally and merge by hand.
- **Token longevity:** `CLAUDE_CODE_OAUTH_TOKEN` can expire. If turns start
  failing auth, re-run `claude setup-token` on the Mac and
  `fly secrets set CLAUDE_CODE_OAUTH_TOKEN=…`.
- **Logs:** `fly logs`. **Shell:** `fly ssh console`.

---

## Deployed instance (this machine)
The live deploy, for reference. None of this is secret — the two secrets
(`TS_AUTHKEY`, `CLAUDE_CODE_OAUTH_TOKEN`) live only in `fly secrets`.

| | |
|---|---|
| Fly app | `helm-chat` (the global `helm-chat` was taken) |
| Volume | `vault_data` 3 GB @ iad → `/data` |
| Tailnet host / IP | `helm-chat` / `REDACTED-TAILNET-IP` |
| Chat URL | `http://helm-chat:3107/chat` |
| Mac vault | `/Users/user/Projects/Vault` → VM `/data/vault` |
| Syncthing folder ID | `helm-vault` (must match on both sides) |
| VM Syncthing device | `REDACTED-DEVICE-ID` (v1.19.2) |
| Mac Syncthing device | `REDACTED-DEVICE-ID` (v2.1.1) |

When adding the VM as a remote device on the Mac, pin its address to
`tcp://REDACTED-TAILNET-IP:22000` — a tailnet-only node won't turn up in
Syncthing's global discovery.
