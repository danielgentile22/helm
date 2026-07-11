# Deterministic feeds where an LLM adds only failure modes

## Context and Problem Statement

Data tiles (calendar agenda, GitHub activity, USCF rating, job applications)
need fresh numbers on a schedule. The project already had a working pattern
for background work — headless `claude -p` skills — and the agenda tile
originally used it. Should data fetching be an AI skill?

## Considered Options

* Plain Python scripts hitting the APIs directly
* Keep the headless `claude -p` agent per feed

## Decision Outcome

Chosen: **plain scripts** ([feeds/](../../feeds/)). Most run as scheduled
launchd jobs; the agenda feed is spawned by the runner, which validates its
JSON output and substitutes a typed `ok:false` on garbage or timeout
([runner/runner.js](../../runner/runner.js), "Calendar agenda cache").

Fetching a calendar is not a judgment task. The agenda tile was originally a
headless `claude -p` agent — **689 of 712 runs produced identical output at
LLM latency and cost, and the other 23 were the interesting failures**. A
deterministic feed is faster, free, and testable: the transform is a pure
function exercised against canned API responses with no network
([feeds/test_calendar_agenda.py](../../feeds/test_calendar_agenda.py)). LLMs
are reserved for tasks that need synthesis — the reports, the reviews, the
open-ended voice asks.

## Consequences

* Each feed hand-rolls one API client, including OAuth for Google Calendar.
  Worth it: those clients fail loudly and identically, which is the point.

## Pros and Cons of the Options

### Plain scripts

* Good: deterministic, free, milliseconds, unit-testable offline.
* Bad: hand-rolled API clients to maintain.

### Headless `claude -p` per feed

* Good: no client code; the agent adapts to API quirks.
* Bad: measured in production — 97% of runs reproduced a deterministic
  transform at ~1000x the latency and real token cost, and the failures were
  nondeterministic instead of loud.
