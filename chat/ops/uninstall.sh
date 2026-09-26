#!/bin/zsh
# Remove the Helm Chat launchd jobs. Leaves ~/.helm (thread history) alone.
set -uo pipefail
UID_NUM="$(id -u)"
for job in com.helm.chat com.helm.caffeinate; do
  launchctl bootout "gui/$UID_NUM/$job" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$job.plist"
done
echo "removed"
