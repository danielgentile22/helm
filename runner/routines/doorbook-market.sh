#!/bin/bash
# Routine: doorbook-market.
#
# Sweeps every listing in the doorbook project's area (for sale, under contract, sold) with
# agent and brokerage. The code belongs to the doorbook project (scripts/market/sweep.py);
# helm only runs it on its timer. No Claude call.
# The addresses and what the sites said live in $HELM_STATE/doorbook, never in a repo.
#
# Safe to run late and safe to run twice: each run reads the whole ZIP and merges it into
# market.json under a lock, so a second run started meanwhile exits at once.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
# Alerts read the status written below, after this run has printed its output, so a
# fix session's log tail includes this run (ADR 0039, ADR 0041).
trap 'python3 "$ENGINE/runner/alerts.py"' EXIT
PROJECT="${DOORBOOK_ROOT:-$HOME/Projects/doorbook}"

out=$(perl -e 'alarm 1800; exec @ARGV' python3 "$PROJECT/scripts/market/sweep.py" 2>&1)
rc=$?

failures=$(printf '%s\n' "$out" | grep -cE '^FAIL')
if [ "$rc" != 0 ] && [ "$failures" = 0 ]; then
	failures=1
fi

python3 "$ENGINE/runner/status.py" doorbook-market \
	"$([ "$rc" = 0 ] && echo pass || echo fail)" "$failures"

if [ "$rc" != 0 ]; then
	printf '%s\n' "$out"
fi
exit $rc
