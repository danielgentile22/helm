# The dashboard owns nothing

Every fact the dashboard shows has a file behind it that exists whether or not the
dashboard is running. The dashboard renders and launches; it is not a system of
record for anything.

This is what makes it disposable, which is the property it needs most, since it is
the piece that will be redesigned visually for years. It is also what removes the
sync problem outright: nothing syncs because nothing is duplicated.

| Layer | Holds | Written by |
|---|---|---|
| `Vault/` | durable knowledge, all sensitive material | Claude turns only, through the vault's canon bar |
| `~/Projects/*` | work state: branches, commits, issues, plan documents | Daniel and Claude, while working |
| `runner/` | everything that changes because something ran | routines, and the dashboard |
| the dashboard | nothing | nobody |

Two rules already in the repo enforce the split and were written before this record:
`PROJECTS.md` says the repo owns status, and Helm 2.0's save-to-vault prompt records
only what *"a repo or its git history does not already hold."*

## Consequences

- **The dashboard's only write into the vault is toggling one checkbox** on a line it
  already read, in a department note. No free text crosses the wire and no path comes
  from the client. Anything cheaper or more frequent goes to `runner/` instead.
- Promoting a conversation to durable knowledge reuses Helm 2.0's mechanism, a
  server-owned prompt spawning a Claude turn, rather than inventing a second one.
- **Notion is deferred, and when it arrives it is the surface other people see.** Not
  a readable mirror of the vault: that would be a data-classification job with no undo,
  running daily, over legal and medical material, introduced for aesthetics.
  Bidirectional sync with Notion is refused outright.
- A panel derives its state from artifacts on disk, never from a status file that
  claims to summarise them. On 2026-09-16 `status/integrity-check.json` reported a
  pass at 13:00 while a failure report sat beside it, written at 13:40.
