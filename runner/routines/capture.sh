#!/bin/bash
# Routine: capture.
#
# Refreshes the two files the dashboard reads, agenda.json and projects.json,
# from the deterministic producers under runner/producers. No Claude call: this
# is a calendar fetch, a few git commands, and a read of four vault notes.
#
# Safe to run late and safe to run twice: both files are overwritten, every
# time-dependent number is left to the reader, and a source that fails keeps its
# last good rows and says so in its own envelope. Silent on success.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS="${HELM_STATE:-$HOME/.helm}/status/capture.json"
mkdir -p "$(dirname "$STATUS")"

# macOS ships no timeout(1). perl's alarm is the portable stand-in, and 240s is
# well inside the 30 minute cadence even when every gh call is slow.
out=$(perl -e 'alarm 240; exec @ARGV' python3 "$ENGINE/runner/producers/capture.py" 2>&1)
rc=$?

failures=$(printf '%s\n' "$out" | grep -cE '^FAIL')
# A timeout or an import error kills the run before any source reports, so the
# count would read 0 problems next to a failing result.
if [ "$rc" != 0 ] && [ "$failures" = 0 ]; then
	failures=1
fi

cat > "$STATUS" <<JSON
{
  "routine": "capture",
  "last_run": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "result": "$([ "$rc" = 0 ] && echo pass || echo fail)",
  "failures": $failures
}
JSON

if [ "$rc" != 0 ]; then
	printf '%s\n' "$out"
fi
exit $rc
