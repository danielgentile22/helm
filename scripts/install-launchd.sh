#!/bin/sh
# Render the scripts/com.helm.*.plist templates (__HELM_ROOT__ / __HOME__
# placeholders) with this machine's paths, install them into
# ~/Library/LaunchAgents, and (re)load them. Idempotent: re-run after editing
# a template to pick up changes.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"
mkdir -p "$ROOT/logs"   # plists' StandardOutPath/StandardErrorPath live here (gitignored)

# Escape sed-replacement specials (\ & and the | delimiter) so paths with odd
# characters render literally instead of corrupting the plist.
sed_escape() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
ROOT_ESC="$(sed_escape "$ROOT")"
HOME_ESC="$(sed_escape "$HOME")"

for tpl in "$ROOT"/scripts/com.helm.*.plist; do
  name="$(basename "$tpl")"
  label="${name%.plist}"
  out="$AGENTS/$name"

  # No voice venv = nothing to run; installing anyway makes launchd respawn a
  # failing job every 10 s forever. Skip (and remove any stale install).
  if [ "$label" = "com.helm.voice" ] && [ ! -x "$ROOT/voice-server/.venv/bin/python" ]; then
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$out"
    echo "skipped $label (voice-server/.venv missing — see README voice setup)"
    continue
  fi

  sed -e "s|__HELM_ROOT__|$ROOT_ESC|g" -e "s|__HOME__|$HOME_ESC|g" "$tpl" > "$out"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  # bootout is async — bootstrap can hit "Input/output error" if the old job
  # is still tearing down. One short retry covers it.
  launchctl bootstrap "gui/$(id -u)" "$out" 2>/dev/null \
    || { sleep 2; launchctl bootstrap "gui/$(id -u)" "$out"; }
  echo "installed $label"
done
