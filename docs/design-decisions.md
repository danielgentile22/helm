# Design decisions

The deliberate engineering behind HELM, for an engineer reading the repo cold.
HELM is a voice-controlled personal HUD: a Next.js dashboard, a Python
voice server, and a Node "runner" daemon that executes AI skills via headless
`claude -p`. Everything below exists because the runner runs an AI agent with
broad permissions on a personal machine — most decisions are about keeping
that power reachable by exactly one person.

## 1. Files as the message bus

**Decision.** All state is plain files in an Obsidian vault — queue intents,
run records, reports, feed caches. No database, no broker, no sockets between
components. The HUD writes `system/queue/<id>.json`
([lib/skills.ts](../lib/skills.ts)); the runner polls the directory and
executes ([runner/runner.js](../runner/runner.js)).

**Why.** Every component (HUD, runner, feeds, Claude itself) can read and
write state with nothing but the filesystem; the user can too, in any text
editor or in Obsidian. Debugging is `cat`. Sync to other machines is
Syncthing on the vault directory — no replication logic written here.

**Cost.** Polling latency (seconds, fine for a personal HUD), no
transactions, and file writes must be atomic to avoid readers seeing torn
JSON — hence [lib/atomicWrite.ts](../lib/atomicWrite.ts) (write temp file,
rename). And a file-based queue synced by Syncthing creates a real attack
surface, which decision 5 closes.

## 2. Fail-closed shared-key auth on every write route

**Decision.** Every state-changing API route requires an `X-HELM-KEY` header
matching `HELM_API_KEY`. If no key is configured, writes return 503 — not
open access ([lib/auth.ts](../lib/auth.ts)).

**Why.** The queue feeds a runner that executes
`claude -p --dangerously-skip-permissions`. The classic failure here is CSRF:
a drive-by web page in the same browser posts to `localhost:3107/api/queue`.
A custom header defeats that — cross-origin JS can't attach one without a
CORS preflight, and same-origin policy stops it from reading the key off
`/api/key`. Fail-closed matters because "no key configured" is exactly the
state a fresh clone is in; defaulting to open would make the most common
setup the most dangerous one. Comparison uses `timingSafeEqual`, and
oversized bodies are rejected by `Content-Length` *before* buffering
(`bodyTooLarge`), since a post-read length check can't prevent the
allocation.

**Cost.** Every write route carries two lines of guard glue, and the HUD's
own pages must fetch the key at runtime ([lib/helmKey.ts](../lib/helmKey.ts)).
The logic is pure and unit-tested in
[scripts/test-security.ts](../scripts/test-security.ts).

## 3. Loopback-only bind on the machine that can execute code

**Decision.** The Mac HUD binds `127.0.0.1`, never `0.0.0.0`
([scripts/com.helm.hud.plist](../scripts/com.helm.hud.plist)).

**Why.** Defense in depth under decision 2: even if the key leaked or the
auth check regressed, LAN peers can't reach the port at all. The only host
that may talk to the queue is the host the user is sitting at.

**Cost.** No phone access to the Mac HUD. Remote access is handled by a
separate deployment with a deliberately weaker capability set (decision 4)
rather than by widening this bind.

## 4. Remote access = same app, method-based write lockout

**Decision.** The Fly.io VM (tailnet-only) runs the identical image with
`CHAT_ONLY=1`. Middleware 404s every mutating API request
(POST/PUT/PATCH/DELETE) except `/api/chat`; GET/HEAD pass
([middleware.ts](../middleware.ts)).

**Why.** The perimeter line that matters is reads vs. writes, not a route
allowlist: a GET never touches the queue, so it can never reach the Mac
runner. Gating on HTTP method means the phone renders every tab read-only
and new write routes are covered automatically — no middleware edit to
forget. An earlier version 404'd reads too, which left the remote tabs
hollow while the write surface it was meant to remove still existed.

**Cost.** One standing rule: no route may mutate on GET, or it slips through
the gate. That's REST hygiene anyway, but here it's load-bearing.

## 5. Syncthing must not be able to enqueue work

**Decision.** The vault's `.stignore` excludes `system/queue/` and
`system/runs/` from sync, on the Mac and written unconditionally by
[entrypoint.sh](../entrypoint.sh) on the VM before Syncthing starts.

**Why.** Decision 1 makes the queue a directory of files and decision 1's
sync story is Syncthing — combined naively, any synced peer becomes a code
executor: a prompt-injected chat turn on the VM could write a queue file and
Syncthing would carry it to the Mac, where the runner executes it with
skipped permissions. Excluding the queue from sync severs that path at the
transport layer instead of trusting every peer forever.

**Cost.** Run history doesn't sync either, so the remote HUD can't show it.
Acceptable: run records are an operator view, and the alternative was a
write channel into the executor.

## 6. Three router tiers, with a rules engine that always works

**Decision.** Voice input routes to one of three tiers — tier 1 dispatches a
known skill to the queue, tier 2 answers instantly from a vault snapshot,
tier 3 hands off to a background `claude -p` session
([lib/router.ts](../lib/router.ts)). Three engines can do the routing: a
local Ollama model, Claude Haiku, or a deterministic rules engine; the model
engines degrade to rules on any error.

**Why.** Latency and cost scale with tier: most utterances are "run the
morning report" (tier 1, milliseconds) or "what's in the queue" (tier 2,
answered from files already on disk) and shouldn't pay for a 30-second
background AI session. The rules fallback means voice keeps working offline
and when both model engines are down — degraded to exact phrases, but never
dead. Model output is distrusted: a tier-1 route naming a skill outside
`ALLOWED_SKILLS` is rejected and re-routed rather than executed.

**Cost.** Three engines to keep behaviorally aligned, and the rules engine
is a pile of regexes with the fragility that implies —
[scripts/test-router.ts](../scripts/test-router.ts) sweeps utterances across
all of them.

## 7. Contract tests where three files must agree

**Decision.** The skill list lives in three places that can't import each
other: `ALLOWED_SKILLS` ([lib/skills.ts](../lib/skills.ts)), the
`buildPrompt()` cases in [runner/runner.js](../runner/runner.js) (plain
Node, no TS imports), and the tab/deck maps in [lib/tabs.ts](../lib/tabs.ts).
Tests assert the three sets are identical
([scripts/test-skill-contract.ts](../scripts/test-skill-contract.ts),
[scripts/test-tabs.ts](../scripts/test-tabs.ts)).

**Why.** The failure mode of drift is silent: a skill in the allowlist but
missing a `buildPrompt()` case dispatches fine and then does nothing, with
no error surfaced to the user — voice just quietly misroutes. A shared
module would fix it structurally, but the runner is deliberately a
zero-build plain-Node daemon; a contract test buys the same guarantee
without coupling the runtimes. The same file also pins timezone agreement
between HUD and runner, where drift would split "today" across two dates.

**Cost.** Adding a skill means touching three files plus the test telling
you which one you forgot. That friction is the feature.

## 8. Deterministic feeds where an LLM adds only failure modes

**Decision.** Data tiles (calendar agenda, GitHub activity, USCF rating, job
applications) are plain Python scripts hitting APIs directly
([feeds/](../feeds/)), not AI skills. The runner spawns them on a schedule,
validates their JSON output, and substitutes a typed `ok:false` on garbage
or timeout ([runner/runner.js](../runner/runner.js), "Calendar agenda
cache").

**Why.** Fetching a calendar is not a judgment task. The agenda tile was
originally a headless `claude -p` agent — 689 of 712 runs produced identical
output at LLM latency and cost, and the other 23 were the interesting
failures. A deterministic feed is faster, free, and testable: the transform
is a pure function exercised against canned API responses with no network
([feeds/test_calendar_agenda.py](../feeds/test_calendar_agenda.py)). LLMs
are reserved for tasks that need synthesis — the reports, the reviews, the
open-ended voice asks.

**Cost.** Each feed hand-rolls one API client, including OAuth for Google
Calendar. Worth it: those clients fail loudly and identically, which is the
point.
