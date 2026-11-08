#!/bin/bash
# Routine: doorbook-debrief.
#
# Writes the evening debrief the Doorbook phone app shows in its Review tab: three things that
# worked, one to try tomorrow, and the best opener once pitch metrics exist. The code belongs to
# the doorbook project (scripts/debrief/debrief.py), which asks one headless Claude session with
# no tools; helm runs it on its timer and hands it the model and effort from models.json. The
# day's log and the debrief live in $HELM_STATE/doorbook, never in a repo.
#
# Safe to run late and safe to run twice: it debriefs the latest finished work day, so a Mac
# asleep at 21:00 catches up on wake, and a day already debriefed with the same knocks is
# skipped without a Claude call. A day off writes nothing.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
# Alerts read the status written below, after this run has printed its output, so a
# fix session's log tail includes this run (ADR 0039, ADR 0041).
trap 'python3 "$ENGINE/runner/alerts.py"' EXIT
PROJECT="${DOORBOOK_ROOT:-$HOME/Projects/doorbook}"

model=$(python3 -c "import json;d=json.load(open('$ENGINE/models.json'));print(d['routines']['doorbook-debrief']['model'])")
effort=$(python3 -c "import json;d=json.load(open('$ENGINE/models.json'));print(d['routines']['doorbook-debrief']['effort'])")

out=$(perl -e 'alarm 900; exec @ARGV' python3 "$PROJECT/scripts/debrief/debrief.py" \
	--model "$model" --effort "$effort" 2>&1)
rc=$?

failures=$(printf '%s\n' "$out" | grep -cE '^FAIL')
if [ "$rc" != 0 ] && [ "$failures" = 0 ]; then
	failures=1
fi

python3 "$ENGINE/runner/status.py" doorbook-debrief \
	"$([ "$rc" = 0 ] && echo pass || echo fail)" "$failures"

if [ "$rc" != 0 ]; then
	printf '%s\n' "$out"
fi
exit $rc
