# Syncthing must not be able to enqueue work

## Context and Problem Statement

[ADR 0001](0001-files-as-the-message-bus.md) makes the queue a directory of
files, and its sync story is Syncthing. Combined naively, any synced peer
becomes a code executor: a prompt-injected chat turn on the VM could write a
queue file, Syncthing would carry it to the Mac, and the runner would
execute it with skipped permissions.

## Considered Options

* Exclude the queue from sync via `.stignore`
* Trust the synced peers (they're all mine)
* A separate authenticated transport for queue entries

## Decision Outcome

Chosen: **`.stignore`**. The vault's `.stignore` excludes `system/queue/`
and `system/runs/` from sync — on the Mac, and written unconditionally by
[entrypoint.sh](../../entrypoint.sh) on the VM before Syncthing starts.
Excluding the queue from sync severs the path at the transport layer instead
of trusting every peer forever.

## Consequences

* Run history doesn't sync either, so the remote HUD can't show it.
  Acceptable: run records are an operator view, and the alternative was a
  write channel into the executor.
* The VM writes its `.stignore` on every boot, so a peer can't quietly drop
  the exclusion.

## Pros and Cons of the Options

### `.stignore` exclusion

* Good: one declarative file kills the whole attack class; no trust in peer
  behavior required.
* Bad: loses run-history sync.

### Trusting synced peers

* Good: zero work.
* Bad: "all my devices" includes the internet-facing VM whose chat input is
  attacker-influenced text; trust doesn't survive that.

### Separate queue transport

* Good: could sync history safely.
* Bad: a bespoke authenticated channel built to re-add a capability nobody
  needs — the queue is only ever written by the machine that runs it.
