#!/bin/bash
# Routine: integrity check.
#
# Verifies that helm's routers still describe reality. Deterministic checks do
# the work; Claude is invoked only when something is broken, to write a short
# report naming what to fix. A passing run costs nothing and writes nothing but
# a status file, so silence means healthy.
#
# The same failures are explained once: when today's FAIL lines hash the same as
# the last explained run's, the stored explanation is reused instead of asking
# Claude again. The report, or its removal, is committed to the vault, staging
# only the report folder. The vault is never pushed.
#
# Safe to run late and safe to run twice: today's report is overwritten, not
# appended, and nothing but the report and the state files is touched.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
DAY="$(date +%Y-%m-%d)"
VAULT="${HELM_VAULT_ROOT:-$HOME/Vault}"
REPORT_DIR="$VAULT/Inbox/runs/integrity"
REPORT="$REPORT_DIR/$DAY.md"
STATUS="${HELM_STATE:-$HOME/.helm}/status/integrity-check.json"
# The last explanation Claude wrote: line 1 is the hash of the FAIL lines it explained.
EXPLAINED="${HELM_STATE:-$HOME/.helm}/status/integrity-check-explained.md"
mkdir -p "$REPORT_DIR" "$(dirname "$STATUS")"

# Commit the report folder, and only it, so a run never leaves its output untracked or
# sweeps in someone else's staged edit. A busy index (another session committing) only
# costs today's commit; the next run picks the report up.
commit_report() {
	git -C "$VAULT" rev-parse --git-dir >/dev/null 2>&1 || return 0
	git -C "$VAULT" add -A -- "$REPORT_DIR" 2>/dev/null || return 0
	git -C "$VAULT" diff --cached --quiet -- "$REPORT_DIR" && return 0
	git -C "$VAULT" commit -q -m "$1" -- "$REPORT_DIR" >/dev/null 2>&1 || echo "WARN  could not commit ${REPORT_DIR/#$HOME/~}"
}

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
	for suite in dashboard/server runner runner/producers runner/jobs; do
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

python3 "$ENGINE/runner/status.py" integrity-check \
	"$([ "$rc" = 0 ] && echo pass || echo fail)" "$failures" \
	"report=$([ "$rc" = 0 ] && echo null || echo "${REPORT/#$HOME/~}")"

# Alerts read the status just written (ADR 0039). Never the routine's own result.
python3 "$ENGINE/runner/alerts.py"

if [ "$rc" = 0 ]; then
	# Safe to run twice means the artifacts agree with the status, not just that
	# nothing new is written. An earlier failing run today left a report; if this
	# run passes and the report survives, anything reading the directory sees a
	# failure that is already fixed. Observed 2026-09-16: status said pass at
	# 13:00 with a report from 13:40 sitting next to it.
	rm -f "$REPORT"
	commit_report "Clear the $DAY integrity report"
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

# The same detail lines as the count above, so a changed summary total alone is not news.
hash=$(printf '%s\n' "$out" | grep -E '^ *FAIL' | grep -vE 'checked|drifting|targets missing' | shasum | cut -d' ' -f1)
if [ -f "$EXPLAINED" ] && [ "$(head -n 1 "$EXPLAINED")" = "$hash" ]; then
	echo "Unchanged since the last explained run, so the explanation is reused:" >> "$REPORT"
	echo >> "$REPORT"
	tail -n +2 "$EXPLAINED" >> "$REPORT"
elif answer=$(cd "$ENGINE" && HELM_NO_SESSION_NOTE=1 claude -p "$prompt" --model "$model" --effort "$effort" 2>&1); then
	printf '%s\n' "$answer" >> "$REPORT"
	printf '%s\n%s\n' "$hash" "$answer" > "$EXPLAINED"
else
	# A failed call is not stored, so the next run asks again.
	printf '%s\n' "$answer" >> "$REPORT"
fi
commit_report "Record the $DAY integrity check"

echo "FAIL  $failures problem(s), report written to ${REPORT/#$HOME/~}"
exit 1
