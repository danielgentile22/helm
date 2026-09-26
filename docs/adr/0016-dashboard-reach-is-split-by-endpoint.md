# The dashboard's reach is split by endpoint, not by a blanket rule

ADR 0013 originally bound the whole dashboard to loopback forever, on the grounds that
its run endpoint executes Claude with Daniel's permissions. That endpoint is deferred
and may never exist, so the blanket rule now forbids harmless things for a reason that
no longer applies. Reach is drawn per endpoint class instead.

| Endpoint class | Reach | Why |
|---|---|---|
| Read any panel | tailnet, passkey-gated | a view of Daniel's own files |
| Toggle one checkbox | tailnet, passkey-gated | one byte, one known line, no free text |
| Launch Ghostty, run anything | **loopback only, permanently** | it acts on one specific machine, and doing it from another is meaningless |

Helm 2.0 is already on the tailnet behind a passkey and drives Claude Code with
permissions bypassed. A page that reads files and flips a checkbox is the least
dangerous thing on that network by a wide margin.

## Consequences

- Phase 6 ships loopback only, with no authentication implemented, but **every route
  carries the auth check from its first line**, as a no-op on loopback. Retrofitting
  authentication onto routes written assuming no attacker is exactly how HELM issue
  #36 happened.
- Loopback-only endpoints are marked as such in code when they are written. They never
  graduate, whatever is turned on around them.
- This also answers the phone: the dashboard may reach it eventually, behind the same
  passkey, and that is a configuration change rather than a new decision.
