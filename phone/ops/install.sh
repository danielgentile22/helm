#!/bin/zsh
# Install (or reinstall) the Helm 2.0 launchd jobs for the current user.
# Idempotent: unloads existing jobs first, renders the server plist from the
# template with this repo's path and node binary, then loads both jobs.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$HOME/.helm2"

[ -f "$REPO/.env" ] || { echo "missing $REPO/.env (copy .env.example and fill it in)"; exit 1; }
[ -f "$REPO/public/app.js" ] || { echo "client not built; run: npm run build:client"; exit 1; }

sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin|g" \
  "$REPO/ops/com.helm2.server.plist.template" > "$AGENTS/com.helm2.server.plist"
cp "$REPO/ops/com.helm2.caffeinate.plist" "$AGENTS/com.helm2.caffeinate.plist"

UID_NUM="$(id -u)"
for job in com.helm2.server com.helm2.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$job" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$job.plist"
  launchctl kickstart -k "gui/$UID_NUM/$job"
done
echo "installed. log: ~/.helm2/server.log"
echo "status: launchctl print gui/$UID_NUM/com.helm2.server | grep -E 'state|pid'"
