# Contract tests where three files must agree

## Context and Problem Statement

The skill list lives in three places that can't import each other:
`ALLOWED_SKILLS` ([lib/skills.ts](../../lib/skills.ts)), the `buildPrompt()`
cases in [runner/runner.js](../../runner/runner.js) (plain Node, no TS
imports), and the tab/deck maps in [lib/tabs.ts](../../lib/tabs.ts)). The
failure mode of drift is silent: a skill in the allowlist but missing a
`buildPrompt()` case dispatches fine and then does nothing — voice just
quietly misroutes.

## Considered Options

* Contract tests asserting the three sets are identical
* A shared module all three import
* A monorepo build step that generates the three lists from one source

## Decision Outcome

Chosen: **contract tests**
([scripts/test-skill-contract.ts](../../scripts/test-skill-contract.ts),
[scripts/test-tabs.ts](../../scripts/test-tabs.ts)). A shared module would
fix it structurally, but the runner is deliberately a zero-build plain-Node
daemon; a contract test buys the same guarantee without coupling the
runtimes. The same file also pins timezone agreement between HUD and runner,
where drift would split "today" across two dates.

## Consequences

* Adding a skill means touching three files plus the test telling you which
  one you forgot. That friction is the feature.

## Pros and Cons of the Options

### Contract tests

* Good: same drift guarantee, zero runtime coupling; the failure message
  names the file you forgot.
* Bad: the duplication itself remains.

### Shared module

* Good: single source of truth.
* Bad: the runner would need a TS build step or the lib would need to
  regress to plain JS — either sacrifices the zero-build daemon for a list
  of a dozen strings.

### Generated lists

* Good: single source, no runtime coupling.
* Bad: a codegen step and its staleness failure mode, to solve what one
  test already solves.
