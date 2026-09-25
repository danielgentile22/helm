#!/bin/zsh
# Remove the Helm 2.0 launchd jobs. Leaves ~/.helm2 (thread history) alone.
set -uo pipefail
UID_NUM="$(id -u)"
for job in com.helm2.server com.helm2.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$job" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$job.plist"
done
echo "removed"
