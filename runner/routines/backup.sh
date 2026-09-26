#!/bin/bash
# Routine: backup.
#
# Refreshes a local snapshot of what cannot be rebuilt: the vault (a verified git bundle
# plus a tarball of the working tree, so uncommitted notes survive) and the state worth
# keeping (chat threads, push subscriptions, passkey credentials, the guard's deny list).
#
# The destination is one line in ~/.helm/backup/target, a folder inside a folder that
# already exists on an external volume. The parent is never created.
# launchd runs this daily and whenever any volume mounts. If the volume is absent it does
# nothing, unless the last good backup is over 14 days old, and then it sends one macOS
# notification until the next success. It writes only inside the target folder and
# ~/.helm/backup, never creates the volume path, and is silent on success.

set -u
VAULT="${HELM_VAULT_ROOT:-$HOME/Vault}"
STATE="${HELM_STATE:-$HOME/.helm}"
HOME_STATE="$STATE/backup"
STATUS="$STATE/status/backup.json"
CONF="$HOME_STATE/target"
LAST="$HOME_STATE/last-success"
REMINDED="$HOME_STATE/reminded"
STALE_S=$((14 * 86400))
MIN_GAP_S=$((12 * 3600))
mkdir -p "$HOME_STATE" "$(dirname "$STATUS")"

now=$(date +%s)
last=$(cat "$LAST" 2>/dev/null || echo 0)
status() { printf '{"ran": "%s", "result": "%s", "last_success": %s}\n' "$(date -u +%FT%TZ)" "$1" "$last" > "$STATUS"; }

[ -s "$CONF" ] || { status "not configured"; exit 0; }
TARGET="$(head -1 "$CONF")"
VOLUME="$(dirname "$TARGET")"  # the existing folder that must be present

# One notification once the last good backup is over 14 days old, whether the drive is
# missing or the backup keeps failing, and none again until a backup succeeds.
remind() {
	if [ $((now - last)) -gt "$STALE_S" ] && [ ! -e "$REMINDED" ]; then
		days=$(( (now - last) / 86400 ))
		osascript -e "display notification \"No backup in $days days: $1\" with title \"helm backup\"" 2>/dev/null
		touch "$REMINDED"
	fi
}

if [ ! -d "$VOLUME" ]; then
	remind "plug in the backup drive."
	status "volume absent"
	exit 0
fi

[ $((now - last)) -lt "$MIN_GAP_S" ] && { status "fresh"; exit 0; }

fail() { status "failed: $1"; echo "backup failed: $1" >&2; rm -rf "$TARGET/.incoming"; remind "$1."; exit 1; }
mkdir -p "$TARGET/.incoming" || fail "cannot write $TARGET"
IN="$TARGET/.incoming"

git -C "$VAULT" bundle create "$IN/vault.bundle" --all 2>/dev/null || fail "vault bundle"
git bundle verify "$IN/vault.bundle" >/dev/null 2>&1 || fail "vault bundle does not verify"
tar -czf "$IN/vault-tree.tar.gz" -C "$(dirname "$VAULT")" --exclude "$(basename "$VAULT")/.git" "$(basename "$VAULT")" 2>/dev/null || fail "vault tree"

state=()
for p in threads auth push dashboard-auth guard settings.json; do
	[ -e "$STATE/$p" ] && state+=("$p")
done
if [ ${#state[@]} -gt 0 ]; then
	tar -czf "$IN/state.tar.gz" -C "$STATE" "${state[@]}" 2>/dev/null || fail "state"
fi

for f in "$IN"/*; do mv -f "$f" "$TARGET/" || fail "moving $(basename "$f") into place"; done
rmdir "$IN"
last=$now
echo "$now" > "$LAST"
rm -f "$REMINDED"
status "ok"
