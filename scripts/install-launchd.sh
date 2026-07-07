#!/bin/sh
# Render the scripts/com.helm.*.plist templates (__HELM_ROOT__ / __HOME__
# placeholders) with this machine's paths, install them into
# ~/Library/LaunchAgents, and (re)load them. Idempotent: re-run after editing
# a template to pick up changes.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

for tpl in "$ROOT"/scripts/com.helm.*.plist; do
  name="$(basename "$tpl")"
  label="${name%.plist}"
  out="$AGENTS/$name"
  sed -e "s|__HELM_ROOT__|$ROOT|g" -e "s|__HOME__|$HOME|g" "$tpl" > "$out"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$out"
  echo "installed $label"
done
