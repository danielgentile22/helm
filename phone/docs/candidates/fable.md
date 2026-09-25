# Helm 2.0 candidate: the log is the product

## Problem

Daniel wants to drive Claude Code on his always-on Mac from his phone and have it feel like a terminal he left open, not a form he submits. The old HELM chat spawned `claude -p` per turn, blocked for up to five minutes with no output, and kept conversational memory in a sidecar JSON that could tear. The agreed constraints (GROUNDING.md) fix the outer shape: server owns long-lived sessions, the phone is a reconnectable viewer over SSE with a cursor, Tailscale plus WebAuthn is the whole security story, no capability sandbox, multiple parallel threads each with its own cwd and its own Claude Code process, web push when a turn finishes in the background, and a markdown mirror of every conversation under `inbox/chats/` in the vault.

What makes the shape non-obvious is that four things all want to be "the truth" about a thread: the live Claude process, the SSE stream a phone is watching, the phone's own rendered state, and whatever is on disk. Every bug in the old design came from having more than one of those. This candidate collapses them: the per-thread append-only event log is the single truth, the process only produces events, clients only fold events, and everything else (the thread list, the markdown mirror, push decisions, crash recovery) is a projection of the log or a query against it.

Constraints carried over from the salvage: the in-process busy lock (`acquireThread`) because `--resume` is not safe to run twice concurrently; write-temp-then-rename for any state file a second reader might catch mid-write; `killTree` on a detached process group plus settle-exactly-once; `checkHelmKey` fail-closed and `bodyTooLarge` reject-before-buffer; the markdown mirror seeded with frontmatter.

## Usage (caller's view)

There are three callers: the phone client, a curl user (Daniel debugging from a laptop), and a future automation that wants to open a thread and watch it. All three speak the same small HTTP surface. The shared vocabulary lives in `src/shared/protocol.ts`.

### Quickstart (what the README says)

```
helm2 runs on the Mac, bound to the tailnet, fronted by `tailscale serve` for HTTPS.

Threads live at ~/.helm2/threads/<threadId>/:
  thread.json      user-set config (cwd, model, effort, title)      atomic-write
  events.jsonl     append-only event log, one JSON event per line   the truth
  uploads/         files staged from the phone for this thread

Every event has a `seq` (1, 2, 3, ... per thread, no gaps). A cursor is just
a seq. `GET /api/threads/:id/events?after=<seq>` replays everything after the
cursor from disk, then goes live. Reconnect with the last seq you saw and you
miss nothing, including a turn that was mid-stream when you lost signal.

One turn runs at a time per thread. Sending while a turn runs queues the
message (you see it queued; it starts when the turn ends). Interrupt is
idempotent. Two phones on the same thread see identical streams because they
are both reading the same log.
```

### Call site 1: the phone sends a message and watches (client/api.ts consumer)

```ts
import { HelmClient } from "./api";
import { fold, emptyView } from "./fold";

const helm = new HelmClient({ baseUrl: location.origin }); // cookie auth, set by Face ID
let view = emptyView(threadId);

// Attach at cursor 0 the first time, at view.headSeq every time after.
// The same call handles first load, lock-screen wake, and app relaunch.
const stop = helm.attach(threadId, view.headSeq, (ev) => {
  view = fold(view, ev); // pure; ev.seq is guaranteed === view.headSeq + 1
  render(view);
});

// Send is idempotent on clientMsgId: a retry after a dropped request cannot
// double-send. The response tells you whether it started or queued.
const r = await helm.send(threadId, {
  clientMsgId: crypto.randomUUID(),
  text: "Look at the photo and add the ingredients to recipes/",
  uploadIds: [uploaded.uploadId],
});
// r: { accepted: true, turnId, state: "running" | "queued" }

await helm.interrupt(threadId); // 204 whether or not a turn was running
```

### Call site 2: creating a thread with a directory picker

```ts
const dirs = await helm.browseDirs("~/Projects"); // { entries: [{name, path, hasClaudeMd}] }
const t = await helm.createThread({
  threadId: crypto.randomUUID(),   // client-minted so create + first send can be retried safely
  cwd: "/Users/danielgentile/Projects/Vault",
  model: "opus",
  effort: "high",
  title: null,                     // server titles it from the first turn
});
```

### Call site 3: curl from the laptop with the static key

```sh
curl -s -H "X-Helm-Key: $HELM_API_KEY" \
  -X POST https://mac.tailnet.ts.net/api/threads/$T/send \
  -d '{"clientMsgId":"'$(uuidgen)'","text":"what did we decide about the LTD plan?"}'

curl -N -H "X-Helm-Key: $HELM_API_KEY" \
  "https://mac.tailnet.ts.net/api/threads/$T/events?after=0"
```

The SSE stream carries exactly one JSON event per `data:` line and sets `id:` to the seq, so a plain `EventSource` gets `Last-Event-ID` resume for free.

## Shape

### Data structures

**`ThreadEvent`** (`src/shared/protocol.ts`) is a discriminated union on `kind`, wrapped in an envelope `{ seq, ts, ...event }`. The kinds are the whole vocabulary of the system: `thread.created`, `thread.config`, `session.bound`, `input.queued`, `input.dropped`, `turn.started`, `assistant.text`, `assistant.thinking`, `tool.started`, `tool.finished`, `turn.ended`, `upload.staged`, `thread.archived`. Text deltas are logged, not just completed blocks, because the mid-turn reconnect story must be "replay from cursor" and nothing else. The writer coalesces deltas over a 40 ms window so a chatty turn produces hundreds of lines, not tens of thousands.

**`Seq`** is a branded integer, contiguous from 1 per thread. **`Cursor`** is `Seq | 0`. This is the only shared coordinate between server and client and it is exposed as the SSE `id`.

**`ThreadConfig`** (`thread.json`) is the user-set part of a thread: `cwd`, `model`, `effort`, `title`, `createdAt`. It is not in the log because a user can change model between turns and the config is the *current* setting, not history; the change is also recorded as a `thread.config` event so the transcript shows it. Config is the one place where "derive instead of sync" is deliberately not followed, because config is an input, not a projection.

**`ThreadHead`** is the derived state the supervisor needs to act: `{ lastSeq, sessionId, openTurn, queued[] }`. It is computed by `ThreadLog.open()` from the tail of the log (every `turn.ended` carries the `sessionId`, so the scan stops at the first `turn.*` boundary walking backward). No head file exists to tear.

**`SessionState`** is the per-thread process state machine in the supervisor: `cold | warming | idle | running | parked`. It lives in memory only. On restart every thread is `cold`, which is the correct meaning of "the process is gone." This is the salvage lock made structural: a thread in `running` cannot accept a second turn, and there is nothing to release on crash.

### Flow

`POST /send` → `Supervisor.send()` → `ThreadLog.append(input.queued)` → if state is `idle|cold|parked`, start a turn now, else leave it queued. Starting a turn: `append(turn.started)`, ensure a live `AgentSession` (spawn with `resume: head.sessionId` if we have one), push the user message, and map every SDK message to zero or more `ThreadEvent`s with the pure function `agentMessageToEvents`. When the SDK yields `result`, `append(turn.ended)` with outcome and usage, then drain the queue. Push fires from a log subscriber, not from the supervisor: `push.ts` watches for `turn.ended` on threads with zero live SSE subscribers.

`GET /events?after=N` → `sse.ts` calls `log.subscribe()` first (live events buffer), then `log.read(after)` streams the file, then flushes the buffer minus anything already sent (dedupe by seq), then goes live. Subscribe-before-read is what makes the handoff gap-free; dedupe by seq makes it duplicate-free. Heartbeat comment every 15 s so iOS can detect a dead socket.

Uploads are staged by `POST /uploads` (multipart, capped by `bodyTooLarge` on Content-Length) into the thread's `uploads/` directory with the original filename made safe, and logged as `upload.staged`. `send` references `uploadIds`; `buildPrompt` turns the user text plus staged files into the SDK user message: images become image content blocks (the model sees them), everything else becomes a trailing "Attached files (absolute paths)" line so Claude can `Read` or `mv` them. Writing an upload into the vault is Claude's job, driven by the user's instruction, not a special API. Full-machine access means there is nothing to special-case.

Auth is one middleware with two doors: `helm_session` cookie (HttpOnly, Secure, SameSite=Strict, 12 h) minted by a WebAuthn assertion, or `X-Helm-Key` timing-safe compared, fail closed if unconfigured. Enrollment of a new passkey requires the static key. Everything under `/api` and the SSE route goes through it; static assets and the two WebAuthn ceremony endpoints do not.

### Invariants encoded in types

- `Seq` is branded; only `ThreadLog.append` mints one. Nothing else can fabricate a cursor.
- A `Turn` cannot exist without a `turn.started` in the log; `TurnId` is branded and minted at that append.
- `SessionState` is a union with the process handle only present in `idle|running`, so "interrupt a cold thread" is unrepresentable and becomes a no-op at the boundary.
- `ModelAlias` is `'sonnet' | 'opus' | 'fable'`; haiku is not in the type. `Effort` is `'low' | 'medium' | 'high'`, the user's ceiling.
- The SDK adapter is an interface (`AgentSession`) with a single pure mapper; the SDK's message shape is parsed at that boundary and never leaks into the log.

### What the system deliberately does not do

- No permission checks, allowlists, or path walls on the session (rejected design).
- No message history is sent to Claude by us; the SDK `resume` carries the memory. We never re-feed the transcript, which is how thread context stays cheap.
- No vault preload. The thread's only system-prompt addition is a short "you are being driven from a phone; answer tightly, prefer doing over narrating" appendix; CLAUDE.md discovery stays cwd-rooted as Claude Code does it.
- No server-side rendered chat state. The client fold is the only renderer, and it is a pure function, so the web view and a future terminal client agree by construction.

## Synthesis decision

(left for the orchestrator)

## Tradeoffs accepted

- We accept logging text deltas (larger `events.jsonl`) in exchange for a reconnect story with a single code path: replay from cursor. A 40 ms coalescing window bounds the cost.
- We accept an in-memory session state machine that resets to `cold` on crash in exchange for never having a durable lock to clean up. Recovery on boot is one idempotent append (`turn.ended {outcome: "orphaned"}`) per thread whose log ends inside a turn.
- We accept that queued inputs are dropped (with a visible `input.dropped` event) on server restart, in exchange for never executing a message the user did not watch get sent. The client re-offers dropped inputs as "tap to resend."
- We accept `thread.json` as a second file next to the log, in exchange for config being editable without replaying history. The log still records every change for the transcript.
- We accept that the SDK owns process spawning (so `killTree` becomes a best-effort process-group sweep keyed on the child's pid, obtained through the SDK's spawn hook if it exists, or `pkill -P` otherwise) in exchange for not hand-rolling stream-json framing.
- We accept a 30-minute idle park (process killed, `sessionId` kept, next turn resumes) in exchange for bounded memory with a dozen threads open. Parking costs one resume spawn on wake, which is a couple of seconds.
- We accept that push fires only when no SSE viewer is attached, which under-notifies if the phone has a zombie connection, in exchange for never double-notifying an active viewer. Heartbeats bound the zombie window to ~30 s.

## Alternatives considered

- **Per-turn `claude -p --resume` with streaming output** (the old shape, made streaming). Lost because a fresh process per turn pays startup and MCP boot every turn, interrupt has no clean target between turns, and the sidecar-torn-session-fork bug class returns. Streaming input mode on one long-lived `query()` per thread is exactly the "terminal left open" feel.
- **Log completed blocks only; keep in-flight deltas in memory and send a synthetic `snapshot` on attach.** Smaller log, but replay now has two sources (file plus in-memory scratch) and an unsequenced event that the client must special-case. The whole point of the cursor is that there is one kind of event and one coordinate. Rejected.
- **SQLite for the log** instead of JSONL. Cleaner reads, but the log must stay greppable and human-recoverable from a terminal, the write pattern is pure append with one writer, and the torn-tail recovery is a one-line rule. JSONL wins on reader load. Revisit only if thread counts get into the hundreds.
- **WebSocket instead of SSE.** Bidirectional, but the client only needs one command channel (plain POSTs) and one ordered event stream, and `EventSource` gives cursor resume, auto-reconnect, and service-worker friendliness with zero code. Rejected.

## Open questions and risks

- Does the current `@anthropic-ai/claude-agent-sdk` expose `setModel` and a reasoning-effort option on a live streaming-input `query()`? If not, a model or effort change must park and respawn with `resume`, which the supervisor already supports; confirm at implementation and delete the `setModel` branch if it does not exist.
- Does the SDK offer a spawn hook that lets us set `detached: true`? If not, `killTree` degrades to a pid-tree sweep. Is best-effort acceptable, or should the adapter spawn the CLI itself with stream-json to keep the process-group guarantee?
- `inbox/chats/` has no retention policy. Should mirrored transcripts be kept indefinitely like research, or pruned with the thread when it is archived?
- Push fires on `turn.ended` when no viewer is attached. Do you also want a push when Claude asks a question mid-turn (the SDK surfaces `AskUserQuestion` tool use), given that the turn is technically still open?
- Does "uploads staged under `~/.helm2`" satisfy the "never leaves the Mac" rule for you, or do you want uploads staged under the thread's cwd so `mv` into the vault is a same-filesystem rename?
- Is one WebAuthn credential set (your iPhone plus a laptop passkey) enough, or do you want per-device revocation in the UI from day one?

## Next implementation step

Build `src/server/core/log.ts` (`ThreadLog.open/append/read/subscribe` with torn-tail recovery and the orphaned-turn rule) with a test that kills the writer mid-line and asserts replay from every cursor is gap-free and duplicate-free.
