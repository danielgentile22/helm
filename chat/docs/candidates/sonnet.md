# Helm 2.0 — candidate design (sonnet)

## Problem

Daniel wants to drive Claude Code from his phone the way he drives it from a terminal: multiple
long-running threads, full machine access, live streaming output, and a turn that survives the
phone going to sleep, losing wifi, or the browser tab closing mid-stream. The server, not the
phone, owns the Claude Code process; the phone is a thin reconnectable viewer over SSE with a
cursor. The hard part is the event log and supervisor: it must survive process crashes and
restarts, let a reconnecting client replay exactly what it missed, refuse to double-drive a
`--resume` session, and do all of this without becoming a database. Everything else (uploads,
push, auth) is comparatively mechanical once the log and supervisor are right.

## Usage (caller's view)

```ts
import { ThreadStore } from "@helm2/core/thread-store";
import { SessionSupervisor } from "@helm2/core/session-supervisor";
import { EventLog } from "@helm2/core/event-log";

const store = new ThreadStore({ root: "~/.helm2/state" });
const supervisor = new SessionSupervisor({ store });

// create a thread (directory picker on the phone supplies cwd)
const thread = await store.createThread({ cwd: "/Users/you/Vault", model: "sonnet" });

// send a turn — returns immediately, the turn runs in the background
await supervisor.sendMessage(thread.id, { text: "summarize today's meetings", attachments: [] });

// phone opens SSE, optionally resuming from a cursor it already has
const log = store.openLog(thread.id);
for await (const event of log.replay({ from: lastSeenCursor })) {
  send(event); // event.cursor is monotonic within the thread, safe to persist client-side
}
// after replay catches up, log.subscribe() yields new events live until the client disconnects

// interrupt a running turn
await supervisor.interrupt(thread.id);
```

`GET /api/threads/:id/events?cursor=123` is the SSE route: it calls `log.replay({from:123})`
then `log.subscribe()`, writing both to the response with no code path difference between "replay"
and "live" from the client's perspective — same event shape, same cursor field.

## Shape

### Core types

The event log is the source of truth; everything else (thread metadata, "is a turn running")
is a *projection* derived by folding the log, never a second thing that must stay in sync
(per single-source-of-truth). See `event-log.ts` and `thread.ts`.

- `ThreadId`, `EventSeq` (branded `number`, monotonic per thread starting at 1) — encodes
  "cursors are per-thread integers, not global, not timestamps" in the type instead of a comment.
- `ThreadEvent` — a discriminated union tagged `type`. Kinds: `user_message`, `assistant_text`,
  `assistant_tool_call`, `assistant_tool_result`, `turn_started`, `turn_completed`,
  `turn_interrupted`, `turn_error`, `thread_created`. No `partial_text` delta events in v1 — see
  Tradeoffs.
- `Thread` — id, cwd, model, reasoning effort, sdk `agentSessionId` (for `--resume`), `status`
  (`idle | running`), timestamps. `status` and `agentSessionId` are folded from the log at load
  time by `foldThreadState`, not stored independently, so a torn metadata file can never disagree
  with the log (per single-source-of-truth; this directly fixes the old sidecar-tear failure
  mode by deleting the second copy instead of writing it more carefully).

### Event log: append-only file + in-memory tail

One file per thread: `state/threads/<id>/events.jsonl`, one JSON object per line, written with
`appendFileSync` (an OS-level atomic append for a single write() under ~4KB, which every event
line is). No `atomicWrite.ts` write-temp-then-rename here — that pattern protects a
whole-file-replace against a torn read; JSONL append needs the opposite property (partial trailing
writes are recoverable by truncating to the last newline), so `EventLog.open()` scans backward
from EOF for a trailing incomplete line and truncates it before assigning the next seq. This is
the load-bearing crash-recovery primitive: an append that dies mid-`write()` (kill -9, power
loss) leaves at most one broken trailing line, which `open()` discards. This is idempotent to
apply repeatedly (per make-operations-idempotent): opening the same log twice always converges to
"greatest fully-written seq."

`EventLog` keeps the last N events (default 500) in an in-memory ring alongside a byte-offset
index for the rest, so `replay({from})` for a recent cursor never touches disk, and a full replay
from 0 (a fresh phone) streams the file directly. Cursor is `EventSeq`, assigned by the log itself
at append time (callers never choose a seq), so two writers can never collide on one — this is
also why only the supervisor is allowed to hold a log's append handle (see below).

```ts
class EventLog {
  static open(threadId: ThreadId, dir: string): EventLog; // truncates a torn trailing line
  append(event: Omit<ThreadEvent, "seq" | "ts">): ThreadEvent; // assigns seq + ts, returns it
  async *replay(opts: { from: EventSeq }): AsyncIterable<ThreadEvent>;
  subscribe(): AsyncIterable<ThreadEvent>; // live events from "now", ends on unsubscribe
  close(): void;
}
```

### Session supervisor: one writer per thread, ever

`claude --resume` (and the Agent SDK's equivalent session resume) is not safe to drive from two
concurrent callers — this is the one fact from the old `lib/chat.ts` comment that this design
treats as load-bearing, generalized from "one HTTP request in flight" to "one live SDK query loop
per thread, period." The supervisor is a process-wide singleton map `ThreadId -> RunningTurn`,
in-memory only (per the old design's own reasoning: a crashed process should free the lock, so
persisting it would be wrong). Two clients (phone + laptop tab) hitting the same thread do NOT
get two Claude processes — `sendMessage` on a thread with a turn already running enqueues the
message into that turn's *input queue* (the Agent SDK's streaming input supports mid-turn
messages) rather than rejecting with 409. This is a deliberate change from the old design: a
phone and a laptop driving one thread is a real use case here ("multiple parallel threads" is
about topics, not about locking Daniel out of his own thread from a second device), and the SDK's
streaming-input mode makes queuing safe where `claude --resume` twice was not.

```ts
class SessionSupervisor {
  async sendMessage(id: ThreadId, input: TurnInput): Promise<void>;
  // TODO: if RunningTurn exists for id, push input onto its queue and return;
  // else start a new SDK query() with resume=thread.agentSessionId, register
  // the RunningTurn, and drive it (see runTurn below).
  async interrupt(id: ThreadId): Promise<void>;
  // TODO: if RunningTurn exists, call its AbortController; append turn_interrupted.
  restoreOnBoot(store: ThreadStore): Promise<void>;
  // TODO: for every thread whose folded status is "running" (a turn_started with
  // no matching turn_completed/interrupted/error after it), append a synthetic
  // turn_interrupted event with reason "server_restart" — the SDK process died
  // with the server, so there is no live turn to resume; the log must not keep
  // claiming one is running. This is the crash-recovery contract: restart makes
  // the log consistent again, it does not try to resurrect the child process.
}

type RunningTurn = { queue: AsyncQueue<TurnInput>; abort: AbortController };
```

`runTurn` (private) is the only thing that calls into the Agent SDK. It appends `turn_started`,
then for each SDK stream chunk appends the matching event kind (`assistant_text`,
`assistant_tool_call`, ...) as it arrives — this is what makes the log genuinely append-only and
streamed rather than "buffer the SDK response, write one event at the end," which would silently
reintroduce the old blocking-`claude -p`problem behind a different API. When the SDK's turn
generator ends, append `turn_completed` (or `turn_error` on throw) and pop the next queued input
if any, otherwise delete the `RunningTurn` from the map. `killTree`-equivalent process-group
teardown from the old route carries over verbatim for the child process the SDK spawns
underneath, since the SDK still shells out to the CLI's tool-execution model — same
settle-exactly-once discipline (`exit` + drain timer) so `RunningTurn` cleanup always runs.

### SSE replay/resume and the reconnect-mid-turn case

The phone reconnecting mid-turn is not a special case in this design; it is the *only* case the
log format supports, because replay and live-tail are the same `AsyncIterable<ThreadEvent>`
interface with no seam between them. A client that was streaming `assistant_text` deltas... no —
see Tradeoffs: there are no deltas, so "reconnect mid-turn" means "replay from cursor picks up
one or more complete `assistant_text` events the client already fully has, plus whatever
happened after disconnect, plus (if the turn is still running) live events as they land." The
client's own cursor bookkeeping (store the highest `seq` seen, in `localStorage`) is what makes
this safe to get slightly wrong: replaying an already-seen event is harmless if the client
de-dupes by `seq`, which it must do anyway to survive its own reconnect race (SSE natively
retries and may replay the last event depending on `Last-Event-ID`, so de-dupe-by-seq is required
regardless of server behavior, not an extra feature).

### Uploads

`POST /api/threads/:id/uploads` accepts a multipart body, stages the file under
`state/uploads/<threadId>/<uuid>-<original-name>` (never inside the vault — the SDK's `cwd` and
`--add-dir` roots are where the model can *choose* to move it), and returns the staged path. The
caller includes that path in the next `sendMessage` call's `attachments` field, which `runTurn`
folds into the SDK prompt as a reference the model can read via its normal file tools — no special
upload-to-prompt image encoding needed, since the model already has filesystem access to
`~/Projects`, `~/Desktop`, `~/Documents`, and staged uploads live in a sibling of those. Staged
files are swept on a TTL (24h) by a cron-like sweep in the server boot path, not by the client,
because "did the model actually consume it" isn't reliably knowable and TTL is simpler than
tracking references (per laziness-protocol).

### Push notifications

`PushSubscription` rows live in `state/push-subscriptions.json` (small, rarely written, so plain
atomic-write-temp-then-rename from the old `atomicWrite.ts` is exactly right here — this is a
whole-file replace, unlike the event log). `runTurn` fires a push on `turn_completed` /
`turn_error` only if no SSE client is currently subscribed to that thread's log (`EventLog`
exposes `subscriberCount()`), so a client watching live never gets a redundant push.

### Auth

WebAuthn passkey gates app open and issues a short-lived signed session cookie (per the grounding
doc); the static API key (`checkHelmKey`'s timing-safe-compare-fails-closed logic, carried over
unchanged) remains the floor for curl/debugging, checked as an alternative to the cookie rather
than in addition to it, on every mutating route. `bodyTooLarge` also carries over unchanged for
the upload and message routes.

### Module map

```
packages/core/
  thread.ts            Thread, ThreadId, EventSeq types + foldThreadState
  event-log.ts          EventLog class
  session-supervisor.ts SessionSupervisor, RunningTurn
  thread-store.ts        ThreadStore (createThread, listThreads, openLog, paths)
  transcript-mirror.ts   markdown mirror writer (vault-side, unchanged idea from old chat route)
  push.ts                PushSubscription store + send
  auth.ts                checkHelmKey, bodyTooLarge, passkey session verify (ports old lib/auth.ts)
apps/server/
  routes/threads.ts       POST /threads, GET /threads
  routes/messages.ts      POST /threads/:id/messages
  routes/events.ts        GET /threads/:id/events (SSE)
  routes/uploads.ts       POST /threads/:id/uploads
  routes/push.ts          POST /push/subscribe
  boot.ts                 restoreOnBoot, upload sweep, launchd-friendly signal handling
```

## Synthesis decision

*(left for the orchestrator)*

## Tradeoffs accepted

- We accept coarse per-event granularity (no token-level streaming deltas inside `assistant_text`)
  in exchange for a much simpler log format and trivial replay semantics. The SDK still gives
  live-feeling output because tool calls and completed text blocks stream as they finish; the
  phone sees "typing" progress at message-chunk granularity, not per-token. If per-token feel
  turns out to matter, deltas can be added as a new event kind additively later without changing
  the log format.
- We accept that two devices driving one thread serialize through a single input queue (one
  reply in flight at a time) in exchange for never needing a CRDT or lock-negotiation UI; this
  matches how a single terminal actually behaves, which is the target feel.
- We accept in-memory-only supervisor state (no persisted "turn N was running when we died") in
  exchange for a trivially correct restart story: every boot declares all previously-running
  turns interrupted and starts clean, rather than attempting to resurrect a child process that
  can't safely be resurrected anyway (the SDK's session resume already handles conversational
  continuity; we don't need to also resume the OS process).
- We accept that uploads live outside the vault (in `state/uploads/`) even though the model may
  write vault content referencing them, in exchange for keeping "what's in the vault" meaning
  "what the model deliberately put there," not "everything anyone ever sent from a phone."

## Alternatives considered

- **SQLite for the event log** instead of JSONL: gives free indexing and transactions, but adds a
  binary dependency and a migration story for a single-writer, append-mostly, one-reader-replay
  workload that JSONL already serves with `O(1)` append and trivial forensic readability (a
  human can `tail -f` it). Rejected because the access pattern never needs SQL, only "append" and
  "read forward from offset," per laziness-protocol.
- **Two-writer locking with a lease file** (persist which process owns a thread, for future
  multi-server deployment): rejected because there is exactly one server process by design (a
  single always-on Mac), so the coordination problem doesn't exist yet; adding it now is solving
  a problem Daniel doesn't have (per subtract-before-you-add).
- **Rejecting a second sender with 409 instead of queuing**, matching the old `busy` set exactly:
  this was the safer-looking middle ground, but it contradicts the "phone and laptop both drive
  my Mac" use case implied by "Claude Code capability parity"; queuing costs one `AsyncQueue`
  and removes a real annoyance.

## Open questions and risks

- Is 500 in-memory ring events per thread the right retention for "resume after being away a
  while," or should replay-from-0 be the common case for a phone that reopens after days? The
  file-backed path handles it either way, but it changes SSE route sizing assumptions.
- `inbox/chats/<threadId>.md` mirroring: should the mirror write happen on every event (chatty,
  matches "as it happens") or once per completed turn (matches the old route's behavior)? This
  sketch assumes once per completed turn, per the old code, but the grounding doc's "stream live"
  requirement makes the chattier option newly plausible.
- Does the Agent SDK's streaming-input mode actually support injecting a new user message into an
  in-flight turn the way `RunningTurn.queue` assumes, or does "queued" really mean "runs after the
  current turn ends"? This needs verifying against the SDK's current API before `runTurn` is
  implemented; if it can't inject mid-turn, `sendMessage` still queues correctly, it just means
  "queued" behaves like "queued for the next turn," which is still correct, just less impressive.

## Next implementation step

Implement `EventLog` (open/append/replay with the torn-trailing-line recovery) and a
crash-recovery test that kills the process mid-append and asserts `open()` recovers a clean log,
since every other module's correctness depends on this primitive holding.
