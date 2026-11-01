# The tailnet can add ideas and drive routines

Extends the reach table in ADR 0016, and supersedes the remote write lockout in ADR 0004
for the endpoints below. The owner wants to throw an idea in from the phone and restart
a failed routine without walking to the Mac. Both need writes over the tailnet, behind
the passkey door of ADR 0025.

| Endpoint class | Reach | Why |
|---|---|---|
| Read any tab | tailnet, passkey-gated | unchanged from ADR 0016 |
| Add an idea, change its status | tailnet, passkey-gated | a new file in a folder only ideas live in, committed with a subject that carries no idea text |
| Promote an idea to an issue | tailnet, passkey-gated | the owner writing to their own tracker; the idea text is the issue body |
| Run now, pause, resume a routine | tailnet, passkey-gated | a fixed list of named routines from `models.json`, no arguments, no free text |
| Run anything else | **loopback only, permanently** | unchanged from ADR 0016 |

Running a named routine is not "run anything". The phone picks a name from a list the
engine already holds and launchd already runs on a schedule; it cannot change what the
routine does or pass it text.

## Consequences

- Idea text never appears in a commit subject or a log line. The vault history had
  already leaked an amount and a phone number through todo subjects.
- A pause parks the routine's plist in `~/.helm/disabled/` and unloads it, the way the
  job search was stopped by hand on 2026-11-01. Resume reverses it. Both converge when
  run twice.
- Promotion to a GitHub repo that other people read is the one outward-facing write.
  The interface asks once before it does it.
