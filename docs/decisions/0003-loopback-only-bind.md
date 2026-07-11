# Loopback-only bind on the machine that can execute code

## Context and Problem Statement

The Mac HUD's `/api/queue` ultimately drives `claude -p
--dangerously-skip-permissions`. What network surface should the HUD expose?

## Considered Options

* Bind `127.0.0.1` only
* Bind `0.0.0.0` and rely on the OS firewall
* Bind the Tailscale interface for phone access

## Decision Outcome

Chosen: **loopback only**. The Mac HUD binds `127.0.0.1`, never `0.0.0.0`
([scripts/com.helm.hud.plist](../../scripts/com.helm.hud.plist)).

Defense in depth under [ADR 0002](0002-fail-closed-shared-key-auth.md): even
if the key leaked or the auth check regressed, LAN peers can't reach the
port at all. The only host that may talk to the queue is the host the user
is sitting at.

## Consequences

* No phone access to the Mac HUD. Remote access is a separate deployment
  with a deliberately weaker capability set
  ([ADR 0004](0004-method-based-remote-write-lockout.md)) rather than a
  wider bind here.

## Pros and Cons of the Options

### Loopback only

* Good: the strongest perimeter is the one with no door; survives auth
  regressions.
* Bad: remote access must be solved separately.

### 0.0.0.0 + firewall

* Good: one deployment serves every device.
* Bad: the perimeter becomes firewall configuration — mutable, invisible to
  the repo, and one `pf` misstep from exposing a code executor to the LAN.

### Tailscale interface bind

* Good: tailnet-only is a real perimeter.
* Bad: still puts the queue-to-runner write path on the network; a stolen
  phone session could enqueue work on the Mac. The read-only remote
  ([ADR 0004](0004-method-based-remote-write-lockout.md)) gives the phone
  what it actually needs.
