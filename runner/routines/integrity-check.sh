#!/bin/bash
# Routine: integrity check.
#
# Verifies that helm's routers still describe reality. Deterministic checks do
# the work; Claude is invoked only when something is broken, to write a short
# report naming what to fix. A passing run costs nothing and writes nothing but
# a status file, so silence means healthy.
#
# Safe to run late and safe to run twice: today's report is overwritten, not
# appended, and nothing is mutated.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
DAY="$(date +%Y-%m-%d)"
VAULT="${HELM_VAULT_ROOT:-$HOME/Vault}"
REPORT_DIR="$VAULT/Inbox/runs/integrity"
REPORT="$REPORT_DIR/$DAY.md"
STATUS="${HELM_STATE:-$HOME/.helm}/status/integrity-check.json"
mkdir -p "$REPORT_DIR" "$(dirname "$STATUS")"

# The dashboard's own checks, which nothing else runs on a schedule: the loop guard, the
# model tests and svelte-check, then every Python test under the server and the producers.
# npm needs node_modules, and a clone that has never built reports one line rather than
# pages of npm output.
dashboard_checks() {
	local rc=0 got
	if [ ! -d "$ENGINE/dashboard/node_modules" ]; then
		echo "FAIL  dashboard/node_modules is missing, run: npm --prefix dashboard install"
		rc=1
	elif got=$(npm --prefix "$ENGINE/dashboard" run check 2>&1); then
		echo "PASS  npm run check"
	else
		printf '%s\n' "$got" | tail -20
		echo "FAIL  npm run check"
		rc=1
	fi
	for suite in dashboard/server runner runner/producers; do
		if got=$(cd "$ENGINE" && python3 -m unittest discover -s "$suite" -p 'test_*.py' 2>&1); then
			echo "PASS  python tests in $suite"
		else
			printf '%s\n' "$got" | tail -20
			echo "FAIL  python tests in $suite"
			rc=1
		fi
	done
	return $rc
}

out=$(
	echo "## Pointers"
	python3 "$ENGINE/runner/checks/check_pointers.py"; p=$?
	echo
	echo "## Wikilinks"
	python3 "$ENGINE/runner/checks/check_links.py" "$VAULT"; l=$?
	echo
	echo "## Repos against project notes"
	python3 "$ENGINE/runner/checks/check_registry.py"; r=$?
	echo
	echo "## Capture freshness"
	python3 "$ENGINE/runner/checks/check_freshness.py"; f=$?
	echo
	echo "## Dashboard service"
	python3 "$ENGINE/runner/checks/check_service.py"; s=$?
	echo
	echo "## Dashboard checks and tests"
	dashboard_checks; d=$?
	exit $(( p || l || r || f || s || d ))
)
rc=$?
# Detail lines only. Each check also prints a PASS/FAIL summary line, which
# would otherwise be counted as a problem of its own.
failures=$(printf '%s\n' "$out" | grep -E '^ *FAIL' | grep -vcE 'checked|drifting|targets missing')

cat > "$STATUS" <<JSON
{
  "routine": "integrity-check",
  "last_run": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "result": "$([ "$rc" = 0 ] && echo pass || echo fail)",
  "failures": $failures,
  "report": $([ "$rc" = 0 ] && echo null || echo "\"${REPORT/#$HOME/~}\"")
}
JSON

if [ "$rc" = 0 ]; then
	# Safe to run twice means the artifacts agree with the status, not just that
	# nothing new is written. An earlier failing run today left a report; if this
	# run passes and the report survives, anything reading the directory sees a
	# failure that is already fixed. Observed 2026-09-16: status said pass at
	# 13:00 with a report from 13:40 sitting next to it.
	rm -f "$REPORT"
	echo "PASS  nothing to report"
	exit 0
fi

# Something is broken. Ask Claude to turn the raw output into a short report.
model=$(python3 -c "import json;d=json.load(open('$ENGINE/models.json'));print(d['routines']['integrity-check']['model'])")
effort=$(python3 -c "import json;d=json.load(open('$ENGINE/models.json'));print(d['routines']['integrity-check']['effort'])")

{
	echo "---"
	echo "type: reference"
	echo "title: Integrity check $DAY"
	echo "updated: $DAY"
	echo "tags: [helm, integrity-check, routine]"
	echo "---"
	echo "# Integrity check: $DAY"
	echo
	echo "$failures problem(s). Raw output below, then what to do about it."
	echo
	echo '```'
	printf '%s\n' "$out"
	echo '```'
	echo
} > "$REPORT"

prompt="helm's daily integrity check failed. Raw output:

$out

Write a short section for a report: one bullet per broken thing, saying what
broke, the most likely cause, and the single command or edit that fixes it. A
broken pointer usually means a file moved and its router was not updated in the
same turn. Be specific and terse. No preamble. No em dashes."

cd "$ENGINE" && HELM_NO_SESSION_NOTE=1 claude -p "$prompt" --model "$model" --effort "$effort" >> "$REPORT" 2>&1

echo "FAIL  $failures problem(s), report written to ${REPORT/#$HOME/~}"
exit 1
