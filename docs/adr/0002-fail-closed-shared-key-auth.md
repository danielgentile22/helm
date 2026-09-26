---
status: accepted
date: 2026-07-11
---

# Fail-closed shared-key auth on every write route

## Context and Problem Statement

The queue feeds a runner that executes `claude -p
--dangerously-skip-permissions`. The classic failure is CSRF: a drive-by web
page in the same browser posts to `localhost:3107/api/queue`. How do the
write routes authenticate a single local user?

## Considered Options

* A shared secret sent as a custom header
* Session cookies
* No auth — trust the loopback bind

## Decision Outcome

Chosen: **shared-key custom header**. Every state-changing route requires an
`X-HELM-KEY` header matching `HELM_API_KEY`. If no key is configured, writes
return 503 — not open access ([lib/auth.ts](../../lib/auth.ts)).

A custom header defeats CSRF — cross-origin JS can't attach one without a
CORS preflight, and same-origin policy stops it from reading the key off
`/api/key`. Fail-closed matters because "no key configured" is exactly the
state a fresh clone is in; defaulting to open would make the most common
setup the most dangerous one. Comparison uses `timingSafeEqual`, and
oversized bodies are rejected by `Content-Length` *before* buffering
(`bodyTooLarge`), since a post-read length check can't prevent the
allocation.

### Consequences

* Every write route carries two lines of guard glue, and the HUD's own pages
  must fetch the key at runtime ([lib/helmKey.ts](../../lib/helmKey.ts)).
* The logic is pure and unit-tested in
  [scripts/test-security.ts](../../scripts/test-security.ts).

## Pros and Cons of the Options

### Shared-key custom header

* Good: CSRF-proof by construction; stateless; trivial to send from curl.
* Bad: one secret, no identity, no revocation granularity — fine for exactly
  one user.

### Session cookies

* Good: standard.
* Bad: cookies are exactly what CSRF rides on, so it reintroduces the attack
  this design exists to stop, plus login UI for a single user.

### No auth on loopback

* Good: zero code.
* Bad: any web page in the local browser can post to loopback; the bind
  ([ADR 0003](0003-loopback-only-bind.md)) does not stop the browser itself.
