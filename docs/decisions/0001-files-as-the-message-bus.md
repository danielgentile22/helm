# Files as the message bus

## Context and Problem Statement

HELM's components — a Next.js HUD, a Node runner daemon, Python feed
scripts, and headless Claude sessions — need to share state: queue intents,
run records, reports, feed caches. What carries that state between them, and
where does it live?

## Considered Options

* Plain files in the Obsidian vault
* SQLite (one file, real transactions, SQL queries)
* A message broker / IPC sockets between components

## Decision Outcome

Chosen: **plain files**. All state is files in the vault — the HUD writes
`system/queue/<id>.json` ([lib/skills.ts](../../lib/skills.ts)); the runner
polls the directory and executes ([runner/runner.js](../../runner/runner.js)).
No database, no broker, no sockets between components.

Every component (HUD, runner, feeds, Claude itself) can read and write state
with nothing but the filesystem; the user can too, in any text editor or in
Obsidian. Debugging is `cat`. Sync to other machines is Syncthing on the
vault directory — no replication logic written here.

## Consequences

* Polling latency measured in seconds — fine for a personal HUD.
* No transactions; writes must be atomic so readers never see torn JSON —
  hence [lib/atomicWrite.ts](../../lib/atomicWrite.ts) (write temp, rename).
* A file-based queue synced by Syncthing is a real attack surface, closed by
  [ADR 0005](0005-syncthing-cannot-enqueue-work.md).

## Pros and Cons of the Options

### Plain files

* Good: universally readable/writable — including by the AI agent and the
  human, with zero client code.
* Good: sync is someone else's solved problem (Syncthing).
* Bad: polling, no transactions, atomicity is on you.

### SQLite

* Good: transactions, queries, one file.
* Bad: every component (Python feeds, plain-Node runner, Claude in a shell)
  now needs a SQL client; the human loses `cat` and Obsidian; the single-user,
  low-write workload never needs the transactional strength.

### Message broker / sockets

* Good: push instead of poll.
* Bad: a running service to babysit for one user on one machine, and state
  becomes invisible in flight instead of inspectable on disk.
