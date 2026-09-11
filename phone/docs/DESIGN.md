# Helm 2.0 — synthesized design

Status: sketch (types and boundaries only, bodies unimplemented)
Date: 2026-09-11
Supersedes: the chat feature inside `~/Projects/helm`, which stays as-is and is not modified.

Produced by the `architect` skill: three independent candidate designs (Opus, Fable, Sonnet)
in `docs/candidates/`, synthesized here. Phase A grounding is `docs/GROUNDING.md`; the SDK
capability probe that settled every candidate's largest open question is `docs/SDK-FINDINGS.md`.

## Problem

Drive Claude Code on an always-on Mac from an iPhone, and have it feel like a terminal left
open rather than a form being submitted. Helm 1.0's chat spawned `claude -p` per turn, blocked
up to five minutes with no output, and kept conversational memory in a sidecar JSON that could
tear and silently fork the session. It also ran on a Fly VM against a Syncthing copy of the
vault, which meant two copies of the source of truth.

The shape is non-obvious because four things all want to be "the truth" about a thread: the
live Claude process, the SSE stream the phone is watching, the phone's own rendered state, and
whatever is on disk. Every bug in the old design came from having more than one of those.

## Shape

**The append-only log is the thread. Everything else is a projection.** One
`~/.helm2/threads/<id>/events.jsonl`, one JSON event per line. Thread state is a pure fold over
it. The resumable Claude session id lives only in the log (carried on every `turn.ended`), so
Helm 1.0's torn-sidecar bug is unrepresentable rather than fixed.

**`Seq` is branded, dense, monotone, and server-assigned.** `append()` takes an event body with
no seq and no timestamp and returns a stamped event; a caller cannot forge a position. That one
type decision makes a cursor an integer, replay a comparison, and dedupe a comparison.

**Subscribe before you replay.** The one race that matters on reconnect is the gap between
finishing the file read and attaching to the live tail. `subscribe()` attaches the listener
first and buffers, then replays from the cursor up to the head seq observed at attach, then
flushes the buffer dropping anything already sent. Gaps become impossible and duplicates
become harmless. This is stated as an invariant on the method, not left to callers.

**The SSE `id:` field is the seq**, so a plain `EventSource` gets `Last-Event-ID` resume for
free. First load, lock-screen wake, tunnel, and app relaunch are all the same code path.

**A crash seals the turn.** `open()` performs two idempotent repairs: truncate a torn trailing
line (the only event ever dropped is one no subscriber was told about, guaranteed by emitting
only after the write lands), and append `turn.ended {orphaned}` if the log ends inside a turn.
Without the second, a replaying phone folds to "running" and spins on a spinner forever.
Queued-but-unstarted inputs become `input.dropped {restart}`, and the client offers "tap to
resend", so nothing executes that the user did not watch get sent.

**Two clients are not a conflict.** Viewers are unbounded; one turn is in flight. `send` never
returns 409. The SDK folds a message sent mid-turn into the running turn (verified, see below),
so phone and laptop on one thread converge because they fold the same bytes.

**Text deltas are logged**, coalesced over a 40 ms window. There is deliberately no separate
"live format" and "stored format", so a reconnecting client cannot observe a different
conversation than a connected one.

**Session state is memory-only** (`cold | warming | idle | running | parked`). After a crash
every thread is `cold`, which is the truthful state. Helm 1.0's `busy` lock becomes structural:
`running` cannot accept a second spawn and there is no lock to release. Threads park after 30
minutes idle (process killed, session id kept, next send resumes).

**Security is two layers and no third.** Tailscale-only bind fronted by `tailscale serve` for
real HTTPS on `*.ts.net`, plus a WebAuthn passkey (Face ID) minting a 12 hour cookie, with a
timing-safe static key as the curl floor. No capability sandbox, no path allowlist, no
read-only mode. That is an explicit product decision, not an oversight.

## Synthesis decision

**Base: the Fable candidate.** It was the only one whose sketch typechecked clean under strict,
and its log module states the gap-free/duplicate-free handoff as two named invariants (emit
only after the write lands; subscribe before read) rather than as prose. All three candidates
independently converged on the core (log-as-truth, dense server-assigned seq,
subscribe-before-replay, no 409, crash seals the turn, JSONL over SQLite, SSE over WebSocket),
which is the strongest signal available that the core is right.

Grafted in:

- **Instance lock** (from Opus): `helm.lock`, a pidfile that refuses to boot when another
  process holds it. Seq allocation is in-memory, so two server processes would corrupt every
  log. Fable and Sonnet both left this implicit. Refusing to boot beats degrading.
- **Uploads as paths, not base64** (Opus's framing, Fable's per-thread layout). The agent has
  full filesystem reach, so handing it an absolute path is strictly more capable than
  embedding bytes, and it removes the size ceiling.
- **Best-effort vault mirror** (Opus): a failed markdown write must not fail the turn, because
  the log is canon and `inbox/chats/<id>.md` is a regenerable projection for Obsidian search.

Rejected:

- **Opus's `log.idx` offset index.** It buys O(replayed) instead of O(log) reconnect, and it is
  the only place in any candidate where a cache can serve misaligned data to a client. For a
  dozen personal threads that is a failure mode bought with no observable win. Dense seq means
  it stays addable later without touching the event model. Per laziness-protocol.
- **Sonnet's block-level-only text.** Simpler log, but it gives up the typing feel that is the
  entire product goal, and it is the one candidate choice that made the thing read as a form
  again.
- **Opus's `snapshot.json`.** A boot-speed cache for a personal tool with tens of threads. Fold
  the log.

Kept from Fable against Opus's objection: **`thread.json` as a separate config file.** Opus
argued all state belongs in the log. Config is an input, not a projection, and the user changes
model between turns; the change is *also* appended as a `thread.config` event so the transcript
shows it. The session id, which is what actually caused Helm 1.0's data loss, stays log-only.

## What the SDK probe changed

`docs/SDK-FINDINGS.md`. All three candidates named "does the SDK support streaming input and a
resumable interrupt" as their largest unverified assumption, and two designed fallbacks for it.
Probed against the installed `@anthropic-ai/claude-agent-sdk@0.3.268`, every capability exists,
so all the fallbacks were deleted:

- `Query.streamInput()` plus documented mid-turn fold-in. The two-devices-one-thread story is
  real, and reply frames carry the folded message's uuid so a reply binds to its send.
- `Query.interrupt({ cancel_queued: true })`, which the SDK documents for exactly "a remote
  UI's Stop button".
- `Options.spawnClaudeCodeProcess`, so we spawn the child `detached` ourselves and `killTree`
  keeps its process-group guarantee over MCP servers and shell tools. No pid-sweep fallback.
- `Query.supportedModels()`, which removes the hardcoded model allowlist entirely. Helm 1.0's
  allowlist rotted to `claude-sonnet-4-6` / `claude-opus-4-8`; the replacement asks the CLI and
  filters by policy (`MODEL_POLICY_DENY = [/haiku/i]`, effort clamped to `high`). Per
  encode-lessons-in-structure, the rule is a call, not a comment.

## Tradeoffs accepted

- We accept a larger `events.jsonl` from logging deltas in exchange for one reconnect path.
- We accept a memory-only session state that resets to `cold` on crash in exchange for never
  having a durable lock to clean up.
- We accept dropping queued-but-unstarted inputs on restart in exchange for never executing a
  message the user did not watch get sent.
- We accept `thread.json` as a second file in exchange for editable config; the log still
  records every change.
- We accept a 30 minute idle park (one resume spawn on wake, a couple of seconds) in exchange
  for bounded memory across a dozen open threads.
- We accept push firing only when no SSE viewer is attached, which under-notifies against a
  zombie connection, in exchange for never double-notifying an open screen. The 15 s heartbeat
  bounds the window to about 30 s.
- We accept that state lives at `~/.helm2`, outside the vault's git history, in exchange for
  honoring "never write application state into the vault".
- We accept no log compaction and no blob GC in v1. Non-goals, not gaps.

## Open questions

1. `~/.helm2` is canon for thread history and sits outside the vault's backup story. Does it
   need its own backup before the migration to the always-on desktop?
2. `inbox/chats/` has no retention policy. The mirror is regenerable from the log, so pruning
   is lossless. Prune at 30 days like morning reports, or keep indefinitely like research?
   alternative: flag a turn in the UI when its tool calls touched that path. Visibility, not a
   wall. Worth the noise?
4. Should uploads stage under the thread's cwd instead of `~/.helm2`, so moving one into the
   vault is a same-filesystem rename rather than a copy?
5. One passkey set, or per-device revocation in the UI from day one?

## Next implementation step

`src/server/core/log.ts` (`open` / `append` / `read` / `subscribe`, with torn-tail and
orphaned-turn repair) plus a test that kills the writer mid-line and asserts replay from every
cursor is gap-free and duplicate-free. Every other module in this design assumes that one is
correct.
