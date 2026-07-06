#!/bin/sh
# External runner-liveness check (issue #58). The in-runner fleet watchdog
# can't watch its own corpse: launchd KeepAlive covers a dead PROCESS, but a
# heartbeat-zombie (alive, scheduler wedged) needs an outside eye. Runs every
# 10 min via com.helm.watchdog.plist: heartbeat stale > 2 min -> kickstart -k
# the runner (kill + restart) and post a banner.
#
# ponytail: heartbeat read + one kick + one banner. Anything smarter lives in
# runner/fleet.js, which a live runner runs itself.

VAULT_ROOT="${VAULT_ROOT:-$(sed -n 's/^VAULT_ROOT=//p' "$HOME/.claude/.env" | tr -d '"' )}"
HB="$VAULT_ROOT/system/runner-status.json"

# Missing heartbeat file = runner never wrote one = dead. Otherwise compare
# mtime (the runner rewrites the file every 15 s, so mtime IS the heartbeat).
if [ -f "$HB" ]; then
    now=$(date +%s)
    hb=$(stat -f %m "$HB")
    age=$((now - hb))
    [ "$age" -le 120 ] && exit 0
    msg="runner heartbeat ${age}s old — restarting com.helm.runner"
else
    msg="no runner heartbeat file — starting com.helm.runner"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') $msg"
launchctl kickstart -k "gui/$(id -u)/com.helm.runner"
osascript -e "display notification \"$msg\" with title \"HELM · watchdog\"" 2>/dev/null || true
