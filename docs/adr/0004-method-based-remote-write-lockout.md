---
status: accepted
date: 2026-07-11
---

# Remote access = same app, method-based write lockout

## Context and Problem Statement

[ADR 0003](0003-loopback-only-bind.md) means the phone can't reach the Mac
HUD. A Fly.io VM on the tailnet runs the same app for remote use — but it
must never become a write path into the Mac runner. How is the remote
deployment's capability cut down?

## Considered Options

* Method-based gate: block all mutating HTTP methods except `/api/chat`
* Route allowlist: 404 everything except an approved route list
* A separate, read-only remote app

## Decision Outcome

Chosen: **method-based gate**. The VM runs the identical image with
`CHAT_ONLY=1`; middleware 404s every mutating API request
(POST/PUT/PATCH/DELETE) except `/api/chat`; safe methods pass
([middleware.ts](../../middleware.ts)).

The perimeter line that matters is reads vs. writes, not a route allowlist:
a GET never touches the queue, so it can never reach the Mac runner. Gating
on HTTP method means the phone renders every tab read-only and new write
routes are covered automatically — no middleware edit to forget.

### Consequences

* One standing rule: no route may mutate on GET, or it slips through the
  gate. That's REST hygiene anyway, but here it's load-bearing.
* New write routes need no middleware change; new read routes just work on
  the phone.

## Pros and Cons of the Options

### Method-based gate

* Good: covers unknown future routes; the phone gets full read-only tabs.
* Bad: depends on the mutate-only-on-non-GET convention.

### Route allowlist

* Good: explicit.
* Bad: **this was the first implementation and it was rejected in use** — it
  404'd reads too, which left the remote tabs hollow while the write surface
  it was meant to remove still existed. Every new route also meant a
  middleware edit to forget.

### Separate read-only app

* Good: no gate to reason about.
* Bad: a second frontend to keep in sync with every panel change, for one
  phone.
