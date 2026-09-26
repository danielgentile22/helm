# One phone app: Helm Chat is the shell

Supersedes ADR 0013, and the phone door in ADR 0025. The phone reaches helm through
one address, one passkey and one home-screen app. Helm Chat is the shell and its
server is the front door; the dashboard's views become tabs inside it, and their data
requests go over loopback to the Python dashboard server, which keeps its capture
producers. The dashboard's own tailnet listener and its passkey code are deleted.

ADR 0013 kept the two apart because Helm Chat is an append-only event log driving
Claude and the dashboard is a disposable view of files, and sharing code or tokens
between them looked like coupling for no gain. What changed is that they became one
product. Chat is the main way Daniel reaches the vault from the phone, and the status
views are what he wants next to it. Two icons with two sign-ins make him choose a
door before he can ask a question.

The lighter option was one address with two apps behind it and a shared cookie. It
saves the port of the views, and it leaves a seam in the middle of the one surface
that should feel whole.

## Consequences

- One passkey store, Helm Chat's. The reach classes in ADR 0016 still hold, now
  enforced at Helm Chat's gate: the dashboard's reads and single-checkbox toggles
  cross the tailnet, and its launch routes stay loopback only. Chat itself already
  runs Claude over the tailnet behind the passkey, and this record does not change
  that.
- The dashboard views move into Helm Chat's Svelte 5 app. Both are Svelte 5, so it
  is a move, not a rewrite.
- On the Mac the dashboard stays its own page at `127.0.0.1:8642` until the postponed
  HUD merge decides the desktop (ADR 0031).
