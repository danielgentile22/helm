# Helm 2.0 — Phase A grounding

## What we're building
A standalone self-hosted web app (installed to the iPhone home screen as a PWA) that lets
Daniel drive **Claude Code** on his always-on Mac from his phone. Target feel: "I opened a
terminal on my Mac," not "I filled in a web form."

New repo at `~/Projects/helm2`. The existing `~/Projects/helm` stays untouched and is
largely abandoned; we salvage four small pieces from it (below) and rebuild the engine.

## Hard requirements (from the user, verbatim intent)
1. **Vault is the default cwd.** `~/Projects/Vault` is the single source of truth and never
   leaves the Mac. No copy on the phone, no upload, no cloud mirror, no git remote (the vault
   is a local-only git repo and must never get a remote, ever).
2. **Full machine access.** The session must be able to leave the vault: sibling repos under
   `~/Projects`, plus `~/Desktop` and `~/Documents`. Same reach as Claude Code in a local
   terminal.
3. **Claude Code capability parity**, not UI parity. Includes uploading photos and files from
   the phone, either to be inspected or to be written into the vault.
4. **No capability sandbox.** Explicit user position: "If I tell it to delete my desktop and
   it does, that's on me." Security is (a) device-level lock on the phone and (b) an encrypted
   network path from phone to Mac over untrusted wifi. Nothing else. Do NOT reintroduce
   allowlists, read-only modes, or mutation walls — those are a rejected design.
5. **Multiple parallel threads**, each a continuous conversation with its own working
   directory and its own live Claude Code session. Context economy matters to him: a thread
   should NOT preload the vault, it should be told the task and find what is relevant.
6. **Web push notifications** when a turn finishes while the app is closed.

## Decided architecture constraints (already agreed with the user, do not relitigate)
- **Server owns sessions; the phone is a reconnectable viewer.** Each thread has a long-lived
  Claude Code process and an append-only event log on disk. The phone connects over SSE with a
  cursor and replays from it. Losing signal, locking the screen, or backgrounding the app must
  never kill a running turn; rejoining mid-turn must work.
- **Streaming, not per-turn `claude -p`.** The old HELM chat blocked up to 5 minutes with zero
  output. The new engine streams assistant text and tool calls live and supports interrupt.
  Prefer the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) over hand-rolled stream-json
  framing; verify the current package name/version at implementation time.
- **Flags:** `--dangerously-skip-permissions`, cwd = the thread's working directory,
  `--add-dir ~/Projects ~/Desktop ~/Documents`. Note that CLAUDE.md discovery is cwd-rooted,
  so the thread's chosen cwd determines which project instructions load. A directory picker at
  thread creation is part of the design.
- **Network:** Tailscale only. Bind to the tailnet interface, no public route, no port
  forwarding. Front it with `tailscale serve` for real HTTPS on `<machine>.<tailnet>.ts.net`.
  The HTTPS/secure-context requirement is load-bearing: PWA service workers, web push, and
  WebAuthn all require it.
- **Device lock:** WebAuthn passkey (Face ID on iOS) gating app open, short-lived session
  cookie after, re-prompt on cold open. Keep a static API key as a floor for curl/debugging.
- **Liveness:** server + Tailscale as launchd KeepAlive jobs, `caffeinate -dims`.
- Today the host is Daniel's MacBook, but design as if it is a permanently-on desktop; he will
  migrate the whole setup to a real always-on desktop soon. Nothing should assume "laptop."

## Salvage from ~/Projects/helm (read these; reuse the idea, not necessarily the code)
- `lib/chat.ts` — `resolveThreadId` (accept a client thread id matching `/^[a-f0-9-]{8,40}$/i`
  else mint a UUID), and the in-process `busy: Set<string>` lock with `acquireThread` /
  `releaseThread`. The lock's comment is the useful part: `claude --resume` is NOT safe to run
  twice concurrently against one session, so the second caller must be rejected; the lock
  living in process memory is correct because a crashed turn should free it on restart.
  DISCARD from this file: the model allowlist (stale: lists claude-sonnet-4-6 / claude-opus-4-8
  / haiku), `chatSystem()`, and the whole `DISPATCH` sentinel + `CHAT_SKILLS` machinery.
- `lib/atomicWrite.ts` — write-to-temp-then-rename, same directory so the rename stays on one
  filesystem. Matters for any state file a second reader might catch mid-write.
- `app/api/chat/route.ts` — `killTree()`: spawn the child `detached` so it leads its own
  process group, then `process.kill(-pid, sig)` so grandchildren (MCP servers, shell tools)
  die too. Also its settle-exactly-once discipline: a grandchild holding the stdio pipes open
  means `close` may never fire, so `exit` plus a short drain window guarantees settlement.
  These are hard-won and worth carrying over.
- `lib/auth.ts` — `checkHelmKey` (timing-safe compare, fails CLOSED when unconfigured) and
  `bodyTooLarge` (reject on Content-Length before buffering; absent header = chunked = reject).
- **Transcript mirroring** (from the old route body): every turn is appended to a human-readable
  markdown file under the vault at `inbox/chats/<threadId>.md`, seeded with frontmatter
  (`thread`, `type: chat`, `created`, `tags: [chat]`). This is deliberate and should survive:
  it makes phone conversations searchable in Obsidian. The machine-owned session sidecar lived
  separately at `system/chats/<threadId>.json` and was written atomically, because a torn
  sidecar silently forks a new Claude session and loses the thread's memory.
- DISCARD entirely: `middleware.ts` (`CHAT_ONLY`), `fly.toml`, `Dockerfile`, Syncthing
  assumptions, the read-only-tabs concept, `lib/skills.ts` dispatch.

## Vault conventions the design must not violate
- Never write application code into the vault; code lives in `~/Projects/*`.
- The vault has machine-owned areas that must not be hand-edited:
  `Atlas/Projects/Morphy/_board-snapshot.md`, `system/morphy-state.json`, and `system/`
  caches generally.
  reach it (no sandbox, by explicit choice). Flag in "Open questions" whether a path-level
  deny rule is wanted; do not unilaterally add one, and do not let it become a capability wall.
- Inbox retention: research kept indefinitely, morning reports 30 days. `inbox/chats/` has no
  stated retention policy yet — worth raising.

## Model choice
The user's model policy: Haiku is never used. Available aliases are sonnet, opus, fable.
The old allowlist is stale and must be replaced with current models (Opus 5, Sonnet 5,
Fable 5.1, Haiku 4.5 exists but is excluded by policy). Per-thread model selection and
per-thread reasoning-effort selection are both wanted in the UI.

## Deliverable
A candidate design package per `references/rationale-template.md`: caller's usage FIRST, then
the type sketch, function signatures, module map, and prose rationale. Concretely this needs
to answer: the Thread and Event types, the event-log format and cursor semantics, the
session-supervisor boundary, how SSE replay/resume works, how uploads are staged and injected
into a turn, how push subscriptions are stored and fired, and the auth boundary.
