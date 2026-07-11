# Three router tiers, with a rules engine that always works

## Context and Problem Statement

Every voice utterance needs a route: run a known skill, answer a dashboard
question, or think hard about something open-ended. Latency and cost differ
by orders of magnitude across those. How is routing decided, and what
happens when the deciding model is down?

## Considered Options

* Three tiers, three engines (local Ollama / Claude Haiku / rules), models
  degrading to rules
* Always ask an LLM
* Rules only

## Decision Outcome

Chosen: **the tier ladder**. Tier 1 dispatches a known skill to the queue,
tier 2 answers instantly from a vault snapshot, tier 3 hands off to a
background `claude -p` session ([lib/router.ts](../../lib/router.ts)). Three
engines can do the routing — a local Ollama model, Claude Haiku, or a
deterministic rules engine — and the model engines degrade to rules on any
error.

Most utterances are "run the morning report" (tier 1, milliseconds) or
"what's in the queue" (tier 2, answered from files already on disk) and
shouldn't pay for a 30-second background AI session. The rules fallback
means voice keeps working offline and when both model engines are down —
degraded to exact phrases, but never dead. Model output is distrusted: a
tier-1 route naming a skill outside `ALLOWED_SKILLS` is rejected and
re-routed rather than executed.

## Consequences

* Three engines to keep behaviorally aligned, and the rules engine is a pile
  of regexes with the fragility that implies —
  [scripts/test-router.ts](../../scripts/test-router.ts) sweeps utterances
  across all of them.

## Pros and Cons of the Options

### Tier ladder with rules fallback

* Good: common cases are instant and free; voice never dies with the
  network.
* Bad: three engines' worth of alignment surface (see
  [ADR 0007](0007-contract-tests-for-triplicated-lists.md) for the same
  problem elsewhere).

### Always-LLM

* Good: one engine, best comprehension.
* Bad: every "what time is it"-class utterance pays model latency and cost,
  and voice dies offline.

### Rules only

* Good: deterministic, free, offline.
* Bad: exact phrases only — tier 3 (open-ended asks) can't exist.

## Confirmation

Measured with [scripts/bench-router-model.mjs](../../scripts/bench-router-model.mjs)
(warm model, grammar-enforced JSON, 16-utterance sweep mirroring the test
suite's), 2026-07-11, Apple Silicon, local Ollama:

| engine | valid JSON | tier accuracy | skill discipline | p50 latency | p90 latency |
|---|---|---|---|---|---|
| `qwen3:4b` (local) | 16/16 | 12/16 | 15/16 | 1404ms | 3094ms |

The 4 misses were all tier confusion (chitchat and snapshot questions routed
to tier 1/3), never an unsafe skill dispatch — and one utterance answered
correctly but self-classified as tier 1. This is exactly why model-proposed
skills are validated against `ALLOWED_SKILLS` and why
[scripts/test-router.ts](../../scripts/test-router.ts) sweeps the rules
engine, which handles the known phrasings deterministically before a model
is ever asked. The Haiku engine is not benchmarked here (it spends API
tokens); the rules engine is exercised directly by the test suite.
