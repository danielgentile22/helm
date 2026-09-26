#!/bin/bash
# Load helm's launchd jobs: one per routine and one per service in models.json.
#
# The plists are generated rather than committed, because launchd requires absolute
# paths and helm has to move between machines without an edit. What a job is
# lives in runner/launchd.py; this script owns launchctl and the files under
# ~/Library/LaunchAgents, and nothing else.
#
# Run this once per machine, and again after adding a routine or a service or
# changing a schedule in models.json.
#
# Pass --uninstall to unload and remove every job.

set -eu
ENGINE="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

# One row per job: label, the program launchd runs, and a plain words description of when.
PLAN="$(python3 "$ENGINE/runner/launchd.py" --list)"

if [ "${1:-}" = "--uninstall" ]; then
	while IFS=$'\t' read -r label _program _when; do
		[ -n "$label" ] || continue
		launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
		rm -f "$AGENTS/$label.plist"
		echo "removed $label"
	done <<-EOF
		$PLAN
	EOF
	exit 0
fi

mkdir -p "$AGENTS" "${HELM_STATE:-$HOME/.helm}/logs"

while IFS=$'\t' read -r label program when; do
	[ -n "$label" ] || continue
	plist="$AGENTS/$label.plist"

	if [ ! -x "$program" ]; then
		echo "SKIP  $label: ${program#"$ENGINE"/} is missing or not executable"
		continue
	fi

	python3 "$ENGINE/runner/launchd.py" --plist "$label" > "$plist"
	launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
	# A bootstrap right after a bootout fails with error 5 while launchd is still tearing
	# the old job down, so retry for a few seconds before calling it a failure.
	for _ in 1 2 3 4 5 6 7 8; do
		launchctl bootstrap "gui/$UID_NUM" "$plist" 2>/dev/null && break
		sleep 2
	done
	launchctl print "gui/$UID_NUM/$label" >/dev/null 2>&1 || { echo "FAIL  $label did not load"; exit 1; }
	echo "installed $label, $when"
done <<-EOF
	$PLAN
EOF

launchctl list | grep com.helm || true
