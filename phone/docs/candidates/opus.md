# Helm 2.0 design candidate (opus)

## Problem

Helm 2.0 puts Claude Code on Daniel's phone with full machine reach and no capability
sandbox, which means the interesting engineering is not security and not UI: it is
**durability of a conversation whose two halves live on different sides of a flaky
cellular link**. The Mac holds a long-running agent process; the phone holds a view that
gets suspended by iOS, loses signal in an elevator, and cold-opens hours later. Helm 1.0
failed because it made the HTTP request the unit of work: a turn was a five minute blocking
`claude -p`, its only durable state was a sidecar JSON file whose torn write silently forked
a new session, and a dropped connection was a lost turn.

The constraints Phase A fixed, which this design must honor rather than revisit: the server
owns sessions and the phone is a reconnectable viewer; streaming via the Agent SDK rather
than per-turn `claude -p`; `--dangerously-skip-permissions` with the thread's own cwd and
`--add-dir` reach; Tailscale plus WebAuthn as the entire security story; per-thread model and
reasoning effort; the vault is cwd-by-default and never leaves the Mac. Four salvage pieces
carry over: the process-group `killTree` and settle-exactly-once discipline, atomic write,
the timing-safe fail-closed key check with the pre-buffer body cap, and `resolveThreadId`.
The `busy` set carries over in spirit but not in shape, for reasons in [Shape](#shape).

The non-obvious part is that almost every requirement above collapses into one question:
**what is the durable representation of a thread?** Answer that wrong and reconnect,
restart, two-client, and push all become special cases bolted onto a state file. Answer it
right and they are all the same operation.

## Usage (caller's view)

### Quickstart (README)

```bash
git clone ~/Projects/helm2 && cd helm2 && pnpm install
cp .env.example .env          # HELM_API_KEY, HELM_HOME, VAULT_ROOT, VAPID keys
pnpm helm doctor              # checks tailscale serve, claude binary, HELM_HOME writability
pnpm helm start               # binds 127.0.0.1:3107; `tailscale serve` fronts it with HTTPS
```

State lives under `HELM_HOME` (default `~/.helm2`), never in the vault:

```
~/.helm2/
  helm.lock                    # instance lock; exactly one writer process, ever
  threads/<threadId>/
    log.jsonl                  # THE thread. append-only, one JSON event per line
    log.idx                    # derived: 8-byte LE byte offset per seq. rebuildable
    snapshot.json              # derived: cached fold as of seq N. rebuildable
  blobs/<sha256>               # content-addressed uploads (photos, files)
  push.json                    # web push subscriptions, atomically written
```

The vault gets exactly one thing, a projection: `inbox/chats/<threadId>.md`.

### Call site 1: the server boots and recovers

```ts
import { acquireInstanceLock } from "./log/instanceLock";
import { openThreadStore } from "./storage/threads";
import { createSupervisor } from "./session/supervisor";

const lock = await acquireInstanceLock(HELM_HOME);   // throws if another helm is alive
const store = await openThreadStore(HELM_HOME);      // repairs every torn log tail
const sup = createSupervisor({ store, vaultRoot: VAULT_ROOT, addDirs: ADD_DIRS });

// Seals every turn that was in flight when we died. Idempotent: running it twice
// on an already-sealed log appends nothing.
const sealed = await sup.recover();
console.log(`helm2 up. sealed ${sealed.length} interrupted turn(s).`);
```

### Call site 2: the phone submits, then loses signal, then comes back

```ts
// POST /api/threads/:id/messages
const { turnId, seq } = await sup.submit(threadId, {
  text: "check the metrics feed, uscf rating tile looks stale",
  attachments: [],          // blob refs, already uploaded
  model: "opus",
  effort: "high",
});
// returns as soon as the user_message event is durable. Does NOT wait for the turn.
```

```ts
// GET /api/threads/:id/events?cursor=412   (EventSource sets Last-Event-ID)
const sub = await sup.subscribe(threadId, cursor);   // cursor 0 = from the beginning
for await (const ev of sub.events) {                  // replay then live, no gap, no dupes
  res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
}
```

Client side, the whole phone app is a fold. There is no other client state:

```ts
const store = new ThreadStore(threadId);        // restores cursor from localStorage
store.connect();                                // EventSource with Last-Event-ID
store.onChange((s: ThreadState) => render(s));  // s.turn.status drives the spinner
```

### Call site 3: Daniel taps stop, or types a follow-up while it is thinking

```ts
await sup.interrupt(threadId);                  // SIGTERM the group, then seal the turn
await sup.submit(threadId, { text: "actually, skip the feed, just show me the csv" });
// if a turn is running, this queues. It is never rejected and never dropped.
```

### Call site 4: uploading a photo from the camera roll

```ts
// POST /api/blobs  (multipart)
const ref = await blobs.put(stream, { filename: "IMG_4821.HEIC", mime: "image/heic" });
// -> { sha256, path: "/Users/.../.helm2/blobs/ab12...", bytes, mime }
// idempotent: uploading the same bytes twice returns the same ref and writes nothing.
await sup.submit(threadId, { text: "what's wrong with this lease page?", attachments: [ref] });
```

## Shape

### The log is the thread. Everything else is derived.

`threads/<id>/log.jsonl` is the only authoritative state in the system. `ThreadState` is
`events.reduce(reduceThread, initialThread(id))` and nothing else. The resumable Claude
session id is a field of that fold, recovered from a `session_ready` event, so Helm 1.0's
worst bug (a torn sidecar silently forking the session and losing the thread's memory) is
not fixed here, it is unrepresentable. `snapshot.json` and `log.idx` are caches carrying the
seq they were taken at; on any mismatch they are discarded and rebuilt by replay. Per
single-source-of-truth: derive, never sync.

**Seq is dense, monotone, and server-assigned.** `append()` takes an `EventInput` with no
`seq` and no `ts` and returns a stamped `HelmEvent`. A caller cannot forge a position in the
log. Dense seq is what makes cursors trivial: the cursor is the last seq the client rendered,
replay is "everything greater than that," and dedupe is `seq <= lastSent`. Per
encode-lessons-in-structure, the ordering invariant lives in the type of `append`, not in a
comment asking callers to behave.

**Replay is a seek, not a scan.** The dominant read is "phone reconnects at seq 412 of 900."
`log.idx` is a fixed-width array of 8-byte little-endian byte offsets, record `i` holding the
offset of the line for seq `i+1`. Replay is one `pread` of 8 bytes, then a streaming read of
`log.jsonl` from that offset. The index is appended strictly **after** the log line it points
at, so it can lag the log but never lead it; a short index means "scan forward from the last
indexed offset," which is also the rebuild path. This is the access pattern traced through the
structure rather than a map added later.

**Torn tails are repaired once, at open, by the writer.** `openThreadLog` scans back from EOF
for the last newline, discards a trailing partial line, and re-validates the last complete line
parses. Readers never see an unrepaired log because the only way to get a `ThreadLog` handle is
through `openThreadLog`. Per boundary-discipline: parse at the edge, trust the types inside.

### The turn is a span, and a crash seals it

Every event inside a turn carries its `turnId`. A turn opens with `turn_started` and closes
with exactly one of `turn_ended` / `turn_failed` / `turn_aborted`. `recover()` walks each
thread's tail; an open span means the process died mid-turn, so it appends
`turn_aborted{reason:"server_restart"}`. Running `recover()` twice appends nothing the second
time, per make-operations-idempotent. The payoff is on the phone: a client that replays a
sealed log never hangs on a spinner, because "thinking forever" is not a state the fold can
reach. `ThreadState.turn` is a discriminated union, so "running with no turnId" is likewise
unrepresentable.

### Two clients are not a conflict, they are two folds of one log

Helm 1.0's `busy` set rejected the second caller with a 409. That was right for a design where
the HTTP request was the turn and wrong here. The correct distinction is **viewers versus the
turn**: viewers are unbounded and read-only, and exactly one turn per thread is in flight. So
`submit()` never 409s. If the thread is idle it starts a turn; if a turn is running it appends
`user_message{queued:true}` and the supervisor drains the queue at turn end (or, if the SDK's
streaming input mode proves usable, pushes it into the live session). Both clients see the same
event and converge, because they are folding the same bytes. Per
separate-before-serializing-shared-state, the sharing that remains (one append-only log) is a
genuine invariant, and it is serialized structurally by a single writer process, enforced by
`helm.lock` rather than by hope.

### Subscribe before you replay

The one race that matters on reconnect is the gap between "finished reading the file" and
"attached to the live tail." `subscribe()` therefore attaches the in-memory listener **first**,
buffering live events, then replays from the cursor up to the seq observed at attach time, then
flushes the buffer dropping anything `<= lastSent`. Monotone dense seq makes that dedupe a
single comparison. This ordering is the load-bearing detail of the whole streaming design and
is stated as an invariant on `Supervisor.subscribe`.

### Text is coalesced once, not twice

The log stores text in ~100ms coalesced chunks, and live subscribers receive the identical
chunk events. There is deliberately no "live format" separate from a "stored format," so a
reconnecting client cannot observe a different conversation than a connected one. Per-token
deltas are dropped at the SDK adapter boundary.

### Deliberate non-goals

No capability sandbox, no path allowlist, no read-only mode (explicitly rejected). No log
compaction in v1. No multi-user model: `Principal` exists so auth is a boundary with a type,
not because anyone else logs in. The vault transcript is best-effort and regenerable; if
writing it fails the turn still succeeds, because the log is canon and the markdown is a
projection for Obsidian search.

## Synthesis decision

*(left for the orchestrator)*

## Tradeoffs accepted

- We accept an unbounded, never-compacted JSONL log per thread in exchange for replay being a
  pure function of bytes on disk with no compaction bug class. A year of phone chat is tens of
  megabytes; the offset index keeps replay cost proportional to what is replayed, not to log
  size.
- We accept a derived offset index (a second artifact that can disagree with the log) in
  exchange for O(replayed bytes) reconnect instead of O(log). The disagreement is one-sided by
  construction and the repair is a forward scan.
- We accept a hard single-writer-process constraint, enforced by a pidfile lock that refuses to
  boot rather than degrading, in exchange for seq allocation and append ordering needing no
  cross-process coordination at all.
- We accept ~100ms of streaming granularity in exchange for one text representation shared by
  live and replayed readers.
- We accept queueing a follow-up sent during a running turn rather than rejecting it, in
  exchange for never losing something Daniel typed on a phone. Interrupt stays a separate,
  explicit action so the queue is never a surprise.
- We accept that uploads are injected as absolute paths for the agent to read itself, rather
  than embedded in the prompt, in exchange for idempotent content-addressed storage and no
  size ceiling. This looks like an omission; it is not. The agent has full filesystem reach, so
  handing it a path is strictly more capable than handing it base64.
- We accept storing Helm state outside the vault in `~/.helm2` in exchange for honoring "never
  write application state into the vault," at the cost of the log not being in the vault's git
  history.

## Alternatives considered

- **SQLite instead of JSONL.** Real transactions, cheap range queries by seq, no torn-tail
  repair, no index sidecar. It loses because the log stops being greppable and tail-able while
  a turn runs, which is how this thing will actually be debugged at 11pm, and because
  `WAL`-mode concurrency invites exactly the multi-writer design the single-process constraint
  is meant to forbid. Worth revisiting if per-thread logs ever need cross-thread search.
- **Keep a mutable `thread.json` state file alongside the log.** Faster boot, simpler reads.
  It loses on principle and on history: it reintroduces two homes for the session id, which is
  precisely the fault that made Helm 1.0 lose conversations. `snapshot.json` gets the speed
  without the authority, because it is discarded on any seq mismatch.
- **Per-token event rows, coalescing at read time.** Perfect fidelity replay. It loses because
  it makes the log ten to fifty times larger for zero visible benefit on a 6 inch screen, and
  because read-time coalescing means live and replayed clients run different code paths.
- **WebSocket instead of SSE.** Bidirectional, no reconnect-cursor ceremony. It loses because
  the cursor ceremony is the feature: SSE's `Last-Event-ID` is exactly the resume semantics we
  need, it survives iOS suspension and proxies better, and the return channel is already HTTP
  POST. Interrupt does not need a socket.
- **Reject the second driver with 409, as Helm 1.0 did.** Simplest possible answer to
  concurrency. It loses because on a phone the second driver is usually the same human on a
  second tab, and dropping their message to protect an invariant they cannot see is hostile.

## Open questions and risks

- Does the Agent SDK expose streaming input into a live session, and a first-class interrupt
  that leaves the session resumable? The supervisor's `submit`-while-busy and `interrupt` both
  degrade to "seal the turn, start a new one with `resume`" if not, which is correct but loses
  in-flight context. This is the single largest unverified assumption in the design and should
  be spiked before anything else is built.
- `inbox/chats/` retention: the markdown projection is regenerable from the log, so pruning it
  is lossless. Should Helm prune it on a schedule (30 days, matching morning reports) and offer
  a rebuild command, or keep chat transcripts indefinitely like research?
- If the log is canon and lives at `~/.helm2`, it is outside the vault's git history and
  outside whatever backup the vault gets. Does `~/.helm2` need its own backup story before you
  rely on threads persisting across a machine migration to the always-on desktop?
- Push fires on `turn_ended` when a thread has had no live subscriber for N seconds. What is
  N, and is a duplicate notification (phone reattaches just as the timer expires) acceptable,
  or should the client be able to acknowledge a seq to suppress it?
- Per-thread cwd determines which `CLAUDE.md` loads. Should the directory picker default to the
  vault for a new thread every time, or remember the last used directory per model or per
  recent-threads list?

## Next implementation step

Build `src/log/threadLog.ts` plus `src/log/offsetIndex.ts` with a test that appends ten
thousand events, truncates the file mid-line at a random byte, reopens, and asserts that the
repaired log replays identically from every cursor. Everything else in this design assumes that
one module is correct.
