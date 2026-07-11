# Prompt injection: the content path is accepted, the transport path is closed

## Context and Problem Statement

Two of HELM's writers put internet-origin text into vault files that later
become model context: the runner's morning-report skill instructs Claude to
web-search and write reports into the vault
([runner/runner.js](../../runner/runner.js), `buildPrompt`), and the chat
brain is instructed to write intent files into `system/queue/`
([lib/chat.ts](../../lib/chat.ts)). A hostile web page summarized into a
report, read back as context by a later session, could try to steer that
session — classic indirect prompt injection.
[ADR 0005](0005-syncthing-cannot-enqueue-work.md) closes the *transport*
path (a synced peer writing queue files); this ADR records the decision
about the *content* path.

## Considered Options

* Accept the content-path risk for this deployment shape
* Sanitize/quarantine internet-derived text before it re-enters context
* Forbid model-written files from ever re-entering model context

## Decision Outcome

Chosen: **accept it, with the blast radius already bounded**. This is a
single-user system: the HUD binds loopback only
([ADR 0003](0003-loopback-only-bind.md)), the queue never syncs
([ADR 0005](0005-syncthing-cannot-enqueue-work.md)), and every skill the
runner will execute is allowlisted with model-proposed skills outside
`ALLOWED_SKILLS` rejected. A successful injection can at worst distort
report prose or waste a run — it cannot open a new write surface or reach
another user.

Reevaluation triggers: **any multi-user surface, or any write path that
syncs into the queue.** Either breaks the assumptions above and the
sanitize/quarantine option stops being optional.

## Consequences

* Report content is trusted as read; a poisoned source can bias what the HUD
  displays and speaks until the user notices.
* The accepted risk is documented here rather than discovered in an
  incident.

## Pros and Cons of the Options

### Accept (chosen)

* Good: honest about the real exposure; no lost functionality.
* Bad: the model's own outputs are a persistence layer for injected text.

### Sanitize/quarantine

* Good: shrinks the content path.
* Bad: no reliable sanitizer for natural-language injection exists; buys
  mostly false confidence at real complexity cost for a one-user system.

### Never re-read model output

* Good: closes the loop completely.
* Bad: removes the product — the HUD's core loop is reading back the
  reports the agent wrote.
