#!/bin/zsh
# Install (or reinstall) the Helm Chat launchd jobs for the current user.
# Idempotent: unloads existing jobs first, renders the server plist from the
# template with this repo's path and node binary, then loads both jobs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$HOME/.helm/logs"

[ -f "$REPO/.env" ] || { echo "missing $REPO/.env (copy .env.example and fill it in)"; exit 1; }
[ -f "$REPO/public/app.js" ] || { echo "client not built; run: npm run build:client"; exit 1; }

sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin|g" \
  "$REPO/ops/com.helm.chat.plist.template" > "$AGENTS/com.helm.chat.plist"
cp "$REPO/ops/com.helm.caffeinate.plist" "$AGENTS/com.helm.caffeinate.plist"

UID_NUM="$(id -u)"

# bootout returns before the old process has exited and launchd has dropped
# the label; a bootstrap in that window fails with "Input/output error".
# Poll until the label is gone (up to 15 s) rather than guess at a sleep.
wait_gone() {
  local i
  for i in {1..150}; do
    launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1 || return 0
    sleep 0.1
  done
  echo "$1 did not unload within 15 s"; return 1
}

for job in com.helm.chat com.helm.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$job" 2>/dev/null || true
  wait_gone "$job"
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$job.plist"
  launchctl kickstart -k "gui/$UID_NUM/$job"
done
echo "installed. log: ~/.helm/logs/com.helm.chat.log"
echo "status: launchctl print gui/$UID_NUM/com.helm.chat | grep -E 'state|pid'"
