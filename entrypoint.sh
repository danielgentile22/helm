#!/usr/bin/env bash
# One container, three long-lived processes: tailscaled (tailnet) → syncthing
# (vault sync) → next start (the chat app). Brought up in that order so
# Syncthing can reach the Mac over the tailnet. If ANY of the three dies we take
# the whole container down (exit 1) so Fly restarts the machine — a half-dead
# container (no sync, or no tailnet, or no app) is worse than a clean restart.
set -uo pipefail

: "${TS_AUTHKEY:?TS_AUTHKEY (Tailscale auth key) must be set — see fly secrets}"
TS_HOSTNAME="${TS_HOSTNAME:-helm-chat}"
PORT="${PORT:-3107}"

# State on the persistent volume so identities survive restarts (stable
# Syncthing device ID for pairing; tailnet node doesn't re-churn).
mkdir -p /data/tailscale /data/syncthing /data/vault

# Fly machines provide /dev/net/tun, but create it if the kernel didn't.
if [ ! -d /dev/net ]; then mkdir -p /dev/net; fi
if [ ! -c /dev/net/tun ]; then mknod /dev/net/tun c 10 200 || true; fi

# --- 1. Tailscale ------------------------------------------------------------
tailscaled --state=/data/tailscale/tailscaled.state \
           --socket=/var/run/tailscale/tailscaled.sock &
TAILSCALED_PID=$!

# wait for the daemon, then join the tailnet
for i in $(seq 1 30); do
  tailscale status >/dev/null 2>&1 && break
  sleep 1
done
tailscale up --authkey="${TS_AUTHKEY}" --hostname="${TS_HOSTNAME}" --accept-routes \
  || { echo "tailscale up failed"; exit 1; }
echo "tailnet IP: $(tailscale ip -4 2>/dev/null || echo '?')"

# --- 2. Syncthing ------------------------------------------------------------
# GUI on 0.0.0.0:8384 is tailnet-only (no Fly service exposes it publicly) — it's
# the one-time pairing surface. Vault folder is configured in the GUI; see runbook.
#
# .stignore BEFORE syncthing starts: the VM must never sync runner intents
# (system/queue) or run records (system/runs) to the Mac — a prompt-injected
# chat turn could otherwise enqueue work the Mac runner executes with
# --dangerously-skip-permissions. The Mac's vault carries the same .stignore,
# which is the enforcement that survives a compromised VM.
printf '/system/queue\n/system/runs\n' > /data/vault/.stignore \
  || { echo ".stignore write failed — refusing to start syncthing without it"; exit 1; }
syncthing serve --no-browser --home=/data/syncthing --gui-address="0.0.0.0:8384" &
SYNCTHING_PID=$!

# --- 3. Next app -------------------------------------------------------------
# Binds 0.0.0.0:$PORT → reachable at the tailnet IP. claude runs with cwd=VAULT_ROOT.
node_modules/.bin/next start -p "${PORT}" &
NEXT_PID=$!

echo "helm chat brain up — tailscaled=$TAILSCALED_PID syncthing=$SYNCTHING_PID next=$NEXT_PID"

# --- supervise: first death takes the container down -------------------------
# kill -0 only proves the PID exists; a wedged next (alive, not serving) needs
# the HTTP probe. No Fly [checks] block exists (no service), so this loop is
# the only liveness signal. 3 consecutive failures ≈ 30-90s wedged → restart.
trap 'kill $TAILSCALED_PID $SYNCTHING_PID $NEXT_PID 2>/dev/null; exit 0' TERM INT
http_fails=0
while true; do
  for pid in $TAILSCALED_PID $SYNCTHING_PID $NEXT_PID; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "process $pid exited — shutting down so Fly restarts the machine"
      kill $TAILSCALED_PID $SYNCTHING_PID $NEXT_PID 2>/dev/null
      exit 1
    fi
  done
  if curl -fsS -m 10 -o /dev/null "http://127.0.0.1:${PORT}/chat"; then
    http_fails=0
  else
    http_fails=$((http_fails + 1))
    echo "liveness probe failed (${http_fails}/3)"
    if [ "$http_fails" -ge 3 ]; then
      echo "next is up but not serving — shutting down so Fly restarts the machine"
      kill $TAILSCALED_PID $SYNCTHING_PID $NEXT_PID 2>/dev/null
      exit 1
    fi
  fi
  sleep 10
done
