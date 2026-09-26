# Agent SDK capability probe — @anthropic-ai/claude-agent-sdk@0.3.268
Probed against the installed d.ts, not from memory. Resolves sonnet candidate risk #1.

## Mid-turn message injection: SUPPORTED
- `Query.streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>` (sdk.d.ts:2941)
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, ... })` (sdk.d.ts:2973)
- sdk.d.ts:3351 documents fold-in explicitly: a queued user message sent while a turn is
  running is "folded in mid-turn", and "the first reply frame after that fold carries the
  folded message's uuid". So a second client's message joins the running turn rather than
  being rejected, and the reply can be bound back to the send that caused it via
  `user_message_uuid`.
=> The two-clients-one-thread design is viable. Do NOT rebuild the old 409 busy-reject.
   Keep a lock only as a one-writer-per-thread guard on the supervisor map, not on sends.

## Interrupt: SUPPORTED, with receipts
- `Query.interrupt(): Promise<SDKControlInterruptResponse | undefined>` (sdk.d.ts:2625)
- Capability flags on system/init: `interrupt_receipt_v1` (response carries `still_queued`),
  `interrupt_cancel_queued_v1` (honors `cancel_queued: true`, which also cancels queued
  commands and lists them under `cancelled`).
- sdk.d.ts:4126 names our exact case: "A Stop-means-stop-everything client (a remote UI's
  Stop button) sets this true so one round-trip halts the session."
=> The phone's Stop button sets `cancel_queued: true`. Feature-detect via the capabilities
   array on the init message; older CLIs ignore the field.

## Model list: QUERY IT, DO NOT HARDCODE
- `Query.supportedModels(): Promise<ModelInfo[]>` (sdk.d.ts:2763)
=> Kills the stale-allowlist bug class outright. The old helm lib/chat.ts hardcoded
   claude-sonnet-4-6 / claude-opus-4-8 / haiku and rotted. The model picker should render
   supportedModels() minus a policy exclusion list (Haiku, per user policy), so it can
   never go stale again. Per encode-lessons-in-structure: the rule becomes a call, not a
   comment.

## Permission mode: RUNTIME-SWITCHABLE
- `Query.setPermissionMode(mode: PermissionMode): Promise<void>` (sdk.d.ts:2632)
=> Not needed for v1 (bypass throughout, by explicit user decision), but it means a future
   per-thread "ask me first" toggle is a UI affordance, not a re-architecture. Worth noting
   so nobody designs around its absence.

## Restart recovery: THE CLI HAS A NOTION OF THIS ALREADY
- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` / `CLAUDE_CODE_RESUME_REASON`, and reply frames
  carry a `resume_reason` when a turn is an automatic re-run of one a worker restart
  interrupted (sdk.d.ts:3359, 5074).
=> Relevant to the sonnet candidate's "declarative, not resurrective" restart handling.
   Check whether this applies to a locally-spawned SDK session or only to hosted workers
   before relying on it; the synthetic `turn_interrupted` event is the safe floor either way.
