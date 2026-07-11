# HELM

[![CI](https://github.com/danielgentile22/helm/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/danielgentile22/helm/actions/workflows/ci.yml)

![HELM demo — hold Space, ask a question, get an instant answer from vault files, then dispatch a real skill to the queue](docs/demo.gif)

*Recorded against the committed demo vault: a tier-2 question answered
instantly by the local router, then a tier-1 command dispatching a skill
to the runner queue, with the spoken reply. ~42s.*

A voice-controlled heads-up display for my own life — **local-first**,
file-backed, with a background Claude agent doing the heavy thinking. Hold
Space, talk; it answers in under a second, dispatches real work to a queue,
and speaks the results when they land. Every glyph on screen traces to a
real file. No theater.

It is built for exactly one user on one machine (~18k lines), and that
constraint is load-bearing: with a single writer and a human-paced workload,
plain files beat a database as the message bus
([ADR 0001](docs/decisions/0001-files-as-the-message-bus.md)), and the
security model reduces to keeping an AI agent with broad permissions
reachable by exactly one person
([the decision records](docs/decisions/)).

## Try it in 60 seconds (demo vault)

No credentials, no Claude CLI, no voice stack — just the HUD against the
committed demo vault of fictional data:

```bash
npm install && npm run demo               # → http://localhost:3107
```

Every tab, tile, and feed panel renders populated (daily note, job
applications, USCF rating with a weekly delta, morning-report headlines in
the AI Wire, completed run records, Morphy board, agenda). `npm run demo`
first runs `scripts/demo-freshen.mjs`, which shifts the demo vault's dates
so its "today" is your today — the only thing it touches is data under
`demo-vault/` (that dirties the working tree; `git checkout demo-vault`
restores it); there are no demo flags or code branches in the HUD.

**Non-functional in demo mode** (by design): voice (no voice server),
runner-dispatched skills (the runner status honestly shows OFFLINE — the
graceful degradation is part of the demo), and live feeds (metrics are
canned, not fetched).

## How it works

**Full visual explainer: [danielgentile22.github.io/helm/architecture.html](https://danielgentile22.github.io/helm/architecture.html)**
(also [`docs/architecture.html`](docs/architecture.html) — open in any browser, works offline).
For the *why* behind the interesting parts — the security perimeter, files as
the message bus, router tiers, contract tests — see the
[architecture decision records](docs/decisions/).

[![HELM architecture explainer](docs/architecture-screenshot.png)](https://danielgentile22.github.io/helm/architecture.html)

The short version:

```
┌──────────────────────────── YOUR MACHINE ────────────────────────────┐   ┌─ CLOUD (opt) ─┐
│                                                                      │   │               │
│  Browser HUD ──── Next.js server ──── THE VAULT ──── Runner daemon ──┼───┼─ Anthropic    │
│  :3107 orb/PTT    :3107 router        plain files    polls queue,    │   │  API          │
│       │           rules→Haiku→qwen    md/json/csv    spawns headless │   │  · Haiku route│
│       │                │                             claude -p       │   │  · claude -p  │
│  Voice server :3108 ───┘              Ollama :11434                  │   │    (tier 3 +  │
│  Kokoro TTS · whisper STT             offline router fallback        │   │     skills)   │
└──────────────────────────────────────────────────────────────────────┘   └───────────────┘
```

- **Voice never leaves your machine** — STT (faster-whisper) and TTS
  (Kokoro) run locally; push-to-talk round trip is 175–500ms on a GPU.
- **Three router tiers**: 1 = dispatch a skill (intent JSON → queue),
  2 = instant answer from the vault snapshot (~25ms), 3 = background
  headless-Claude ask, answer spoken when it lands.
- **Mental model**: the voice layer is a dispatcher, not a worker. Files
  are the message bus — every step of every job is inspectable on disk.

## Quickstart

```bash
npm install
export VAULT_ROOT=/path/to/your/vault   # required — no default
npx next dev -p 3107                     # → http://localhost:3107
```

`VAULT_ROOT` points at the folder of plain files the HUD reads and writes
(set it in your shell or `~/.claude/.env`; see [Vault structure](#vault-structure)
for the layout). It's required — start without it and the HUD and runner
both fail fast with a message naming the setting rather than rendering demo
data. Two more pieces make it real:

1. **The runner** (background skill executor): `node runner/runner.js` in a
   second terminal. Needs the `claude` CLI installed and logged in.
2. **Voice** (optional, fully local): see the
   [voice server setup](docs/setup.md#voice-server-setup).

Every environment variable, the Google Calendar OAuth bootstrap, and the
full voice install live in [`docs/setup.md`](docs/setup.md).

**Day-to-day**: open `claude` in this folder and say **"spin up HELM"** —
it starts whatever isn't running (voice server, runner, HUD) detached, so
everything survives closing the terminal. For automatic start at login,
install the `com.helm.*` launchd agents with `scripts/install-launchd.sh`
(plist templates and the full service inventory live in `scripts/` and
`.helm-config.json`).

## Vault structure

```
VAULT_ROOT/                       (required — set via env, no default)
├── system/
│   ├── queue/                    intents written by HUD, claimed by runner
│   ├── runs/                     run records + logs (*.json, *.md)
│   ├── metrics/
│   │   └── metrics.csv           timestamp,source,metric,value,status,error
│   ├── schemas/daily-note.md     frozen daily-note contract
│   └── runner-status.json        runner heartbeat (written by runner)
├── daily-notes/YYYY-MM-DD.md     priorities, schedule, focus
├── jobs/applications.jsonl       job applications — one JSON record per line
└── inbox/
    ├── reports/morning/          morning briefings (feeds the AI Wire)
    └── voice/                    voice-ask answers
```

Everything degrades gracefully: missing files render as empty panels, a
dead runner shows RUNNER OFFLINE, missing voice-server returns a clean 503.

**Job applications** (`jobs/applications.jsonl`) back the "Job Applications"
vitals tile. Each line is one application — greppable, hand-editable, and
append-only, so the data is yours independent of the HUD:

```json
{"company":"Acme","role":"Backend Engineer","applied":"2026-06-15","status":"applied","link":"https://..."}
```

`company` or `role` is required; `applied` (YYYY-MM-DD) drives the
"this week" count; `id` (optional) is the de-dup handle. The daily
`feeds/job-applications.py` reads this store and writes `jobs/applications`
(total) and `jobs/applied_7d` (last 7 days) to `metrics.csv`. Append a line
by hand, or seed a sample to demo the tile.

## Using it

- **Tabs** — the shell is organized by project: Today / Morphy / Job
  Search / Chess / Chat. Each tab carries its own panels and deck
  buttons; on a phone the tabs become a bottom tab bar.
- **Hold Space** — push-to-talk (desktop). "Brief me" / "good morning" =
  the spoken rundown. "What's in the queue", "what's my chess rating" =
  instant answers. "Run the inbox brief" = dispatch. Anything open-ended =
  background ask, spoken when ready.
- **Esc** closes an open overlay, else stops speech; clicking a Documents
  row opens the report overlay.
- **Chat tab** — typed conversation with the same router/brain; the voice
  transcript is a Documents row (open it to read, "reset transcript ×" to
  clear). For chat from your phone anywhere, see `docs/fly-deploy.md`.

## Security

The HUD binds **127.0.0.1 only**, and every state-changing route requires
the `HELM_API_KEY` shared secret (from `~/.claude/.env`) sent as
`X-HELM-KEY` — no key configured means writes fail closed (503). It still
assumes a trusted machine: never bind it to `0.0.0.0`, never port-forward
3107/3108 — `/api/queue` feeds the runner's headless Claude. The full
perimeter, including why the remote deployment can't write and why Syncthing
can't enqueue work, is in [ADRs 0002–0005 and 0009](docs/decisions/).

## Quality gates

`npm test` runs every suite via `scripts/run-tests.mjs` — the runner syntax
checks, the TS suites (router sweep, skill/tab contract, security, feeds
glue, chat), then the Python voice-server and feed suites — continuing past
failures and summarizing per suite. Needs `python3` on PATH; spends no API
tokens. Run one suite directly: `npx tsx scripts/test-router.ts`. After any
`lib/` change also run `npx tsc --noEmit`; after any `runner/runner.js`
edit, `node --check runner/runner.js` — the runner fails silently on syntax
errors.

## Known limitations

- **Single-user, single-machine by design.** There is no auth beyond one
  shared secret and no user model; a multi-user HELM would need a different
  security architecture, not a bigger allowlist
  ([ADR 0009](docs/decisions/0009-prompt-injection-threat-model.md)).
- **Polling, not push.** The file-based queue means seconds of latency and
  no transactions; atomic-rename writes are the only concurrency control
  ([ADR 0001](docs/decisions/0001-files-as-the-message-bus.md)).
- **The rules router is a pile of regexes.** It only knows the phrasings in
  its patterns; anything else needs a model engine up. The utterance sweep
  in `scripts/test-router.ts` is what keeps it honest
  ([ADR 0006](docs/decisions/0006-three-router-tiers.md)).
- **Run history doesn't sync** — the price of keeping the queue out of
  Syncthing ([ADR 0005](docs/decisions/0005-syncthing-cannot-enqueue-work.md)).
- **Injected content can bias reports.** Internet text summarized into the
  vault re-enters model context unfiltered; accepted, with the blast radius
  bounded ([ADR 0009](docs/decisions/0009-prompt-injection-threat-model.md)).

## Lessons learned

- **Measure before you agentify.** The agenda tile ran as a headless Claude
  agent for months; logging showed 689 of 712 runs produced identical
  output. A 200-line Python script replaced it — faster, free, testable
  ([ADR 0008](docs/decisions/0008-deterministic-feeds-over-llm.md)).
- **Perimeters should gate on invariants, not inventories.** The first
  remote write-lockout was a route allowlist; it broke the read-only tabs
  and still missed the point. Gating on HTTP method covered every future
  route for free ([ADR 0004](docs/decisions/0004-method-based-remote-write-lockout.md)).
- **When three files must agree and can't import each other, test the
  agreement.** Contract tests turned "voice quietly misroutes" into a named
  failing assertion ([ADR 0007](docs/decisions/0007-contract-tests-for-triplicated-lists.md)).

## AI usage

Most of this implementation was written by Claude Code (Claude Opus 4.x and
Claude Fable 5), working from specs I wrote and reviewed; the runner's
background skills execute through the same tool headlessly. The
architecture, the data model, the security perimeter, and every decision in
[docs/decisions/](docs/decisions/) are mine — including the ones where I
overrode the agent's working version: the agenda tile shipped as a headless
`claude -p` agent and I replaced it with a deterministic Python feed after
689/712 runs produced identical output (ADR 0008), and the remote
write-lockout shipped as a route allowlist that I had rewritten as a
method-based gate after it left the phone's tabs hollow without actually
removing the write surface (ADR 0004). The `Co-Authored-By: Claude` commit
trailers are accurate and stay.

## License

[MIT](LICENSE).
