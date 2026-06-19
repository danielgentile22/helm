# HELM

A voice-controlled heads-up display for my own life — **local-first**,
file-backed, with a background Claude agent doing the heavy thinking. Hold
Space, talk; it answers in under a second, dispatches real work to a queue,
and speaks the results when they land. Every glyph on screen traces to a
real file. No theater.

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
2. **Voice** (optional, fully local): see [Voice server setup](#voice-server-setup).

**Day-to-day**: open `claude` in this folder and say **"spin up HELM"** —
it starts whatever isn't running (voice server, runner, HUD) detached, so
everything survives closing the terminal. To make it automatic at login,
the launchd agents under `~/Library/LaunchAgents/com.helm.*` handle it on
this machine (HUD, runner, voice, the USCF rating feed, the hourly
Claude-token feed, and the daily job-application feed).

## How it works

**Full visual explainer: [`docs/architecture.html`](docs/architecture.html)**
— open in any browser, works offline. The short version:

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

## Vault structure

```
VAULT_ROOT/                       (required — set via env, no default)
├── system/
│   ├── queue/                    intents written by HUD, claimed by runner
│   ├── runs/                     run records + logs (*.json, *.md)
│   ├── metrics/
│   │   ├── metrics.csv           timestamp,source,metric,value,status,error
│   │   └── latest-video.json     newest upload stats (optional)
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
(total) and `jobs/applied_7d` (last 7 days) to `metrics.csv`. **How records
get *captured* — voice command, inbox-scan, or manual edit — is deliberately
left open**; for now, append a line by hand or seed a sample to demo the tile.

## Configuration

All env vars are read from your shell or `~/.claude/.env` (a plain
`KEY=value` file; process env wins). `NEXT_PUBLIC_*` vars go in `.env.local`
in the repo root instead (they're inlined into the client at build).

| Var | Purpose | Default |
|---|---|---|
| `VAULT_ROOT` | vault folder | **required** (no default) |
| `CLAUDE_PROJECTS_DIR` | transcript root the token feed scans | `~/.claude/projects` |
| `JOBS_DIR` | folder holding `applications.jsonl` (job feed) | `$VAULT_ROOT/jobs` |
| `HUD_TZ` | IANA timezone for "today" (HUD + runner) | `America/Chicago` |
| `HUD_USER_NAME` | how voice notes refer to you | `User` |
| `AGENTIC_OS_MODEL` | model for background `claude -p` runs | `claude-opus-4-8` |
| `ANTHROPIC_API_KEY` | enables Haiku intent routing (~$0.002/ask) | unset (optional) |
| `VOICE_ROUTER` | force router engine: `auto`/`rules`/`haiku`/`local` | `auto` |
| `VOICE_ROUTER_MODEL` / `OLLAMA_URL` | local routing fallback | `qwen3:4b` / `:11434` |
| `VOICE_SERVER_URL` | TTS/STT server | `http://127.0.0.1:3108` |
| `KOKORO_VOICE` / `KOKORO_SPEED` | TTS voice + speed | `bm_george` / `1.0` |
| `WHISPER_MODEL` / `WHISPER_PROMPT` | STT model + vocab bias | `small.en` / built-in |
| `KOKORO_DEVICE` / `WHISPER_DEVICE` | force `cpu` if CUDA misbehaves | auto |
| `WAKE_WORD` / `WAKE_MODEL` | opt-in hands-free wake (`on`/`off`) + openWakeWord model name | `off` / unset (push-to-talk) |
| `NEXT_PUBLIC_OBSIDIAN_VAULT` | Obsidian vault name for deep links | unset (link hidden) |
| `NEXT_PUBLIC_VOICE_WS` | wake-event websocket | `ws://127.0.0.1:3108/events` |

⚠️ `ANTHROPIC_API_KEY` belongs in the `~/.claude/.env` FILE only — set as a
system-wide env var it flips your interactive `claude` CLI from
subscription to API billing.

## Voice server setup

Fully local TTS + STT. One-time setup:

```bash
cd voice-server
python -m venv .venv
.venv/bin/pip install kokoro-onnx fastapi uvicorn soundfile faster-whisper onnxruntime
# NVIDIA GPU: swap plain onnxruntime for onnxruntime-gpu + the matching
# nvidia-cudnn-cu12 / nvidia-cublas-cu12 / nvidia-cufft-cu12 wheels.
```

Download `kokoro-v1.0.onnx` (~325MB) and `voices-v1.0.bin` (~28MB) from the
[kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases)
into `voice-server/`. Start: `.venv/bin/python server.py`. GPU gives
~250ms/sentence TTS and ~130ms STT; CPU works at ~4x slower.

**Pick your voice**: `python make_samples.py` regenerates `samples/` +
open `audition.html`, pick, set `KOKORO_VOICE`/`KOKORO_SPEED`, restart.

**Input is push-to-talk** (hold Space). Hands-free wake is off by default
and intentionally unbundled — without headphones the wake mic hears the
HUD's own speech. To opt in, `pip install --no-deps openwakeword` (the
`--no-deps` is LOAD-BEARING — a bare install overwrites onnxruntime-gpu
with the CPU build), point `WAKE_MODEL` at an openWakeWord model name, and
set `WAKE_WORD=on`.

## Using it

- **Hold Space** — push-to-talk. "Brief me" / "good morning" = the spoken
  rundown. "What's in the queue", "how many subscribers do I have" =
  instant answers. "Run the inbox brief" = dispatch. Anything open-ended =
  background ask, spoken when ready.
- **Esc** stops speech; clicking a Documents row opens the report overlay;
  Directives checkboxes are clickable (today's note only).
- **TRANSCRIPT** (bottom-left) shows the voice conversation ring; RESET
  clears it.
- **Demo modes** (no data needed): `?demo=callouts` seeds doc callout
  cards, `?demo=taskwork` plays the full task-callout lifecycle. Keys 1–5
  force core modes, B cycles backgrounds.

## Security

This is a localhost app with **no authentication by design** — the API can
queue real work and read vault markdown. Never bind it to `0.0.0.0`, never
port-forward 3107/3108, never run it on a shared machine you don't trust.

## Platform notes

Everything is Node/Python and runs cross-platform. On Apple Silicon use
plain `onnxruntime` (CPU) or set `KOKORO_DEVICE=cpu`/`WHISPER_DEVICE=cpu`.
The `.vbs` files are Windows launcher conveniences; on Mac/Linux use `node
runner/runner.js &` and `python voice-server/server.py &` (or launchd /
systemd).

## Quality gates

After any `lib/` change: `npm test` (16-case router sweep, no API spend) +
`npx tsc --noEmit`. After any `runner/runner.js` edit, `node --check
runner/runner.js` — the runner fails silently on syntax errors.
