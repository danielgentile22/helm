#!/bin/bash
# Routine: job search.
#
# Every morning: search LinkedIn's public listings against the criteria in the
# vault, screen them, have a cheaper model judge each posting's eligibility and
# skills, have Claude rank the live pool and pick the day's ten, tailor a resume
# and cover letter for each, and leave a PDF on the desktop with the funnel and
# the apply links. The record goes in the vault. runner/jobs/run.py does all of
# it; this script only bounds its time and writes the status file if it dies
# before doing so.
#
# Safe to run late (the day is the date it starts) and safe to run twice (every
# file is overwritten, and a posting picked on an earlier day stays picked in
# the pool). Not silent on success: the report is the point.

set -u
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
STATUS="${HELM_STATE:-$HOME/.helm}/status/job-search.json"
mkdir -p "$(dirname "$STATUS")"

# macOS ships no timeout(1). Six hours: ten tailorings two at a time, each
# allowed 35 minutes and one retry, plus the search. Still before noon.
perl -e 'alarm 21600; exec @ARGV' python3 "$ENGINE/runner/jobs/run.py"
rc=$?

if [ "$rc" != 0 ] && ! grep -q "\"last_run\": \"$(date -u +%Y-%m-%dT%H)" "$STATUS" 2>/dev/null; then
	cat > "$STATUS" <<JSON
{
  "routine": "job-search",
  "last_run": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "result": "fail",
  "failures": 1,
  "detail": "run.py exited $rc before writing its status (timed out or crashed)"
}
JSON
fi
exit $rc
