# Setup reference

The operator manual: every environment variable, the Google Calendar OAuth
bootstrap, and the voice-server install. For what HELM *is*, start at the
[README](../README.md).

## Configuration

All env vars are read from your shell or `~/.claude/.env` (a plain
`KEY=value` file; process env wins). `NEXT_PUBLIC_*` vars go in `.env.local`
in the repo root instead (they're inlined into the client at build).

| Var | Purpose | Default |
|---|---|---|
| `VAULT_ROOT` | vault folder | **required** (no default) |
| `CLAUDE_PROJECTS_DIR` | transcript root the token feed scans | `~/.claude/projects` |
| `JOBS_DIR` | folder holding `applications.jsonl` (job feed) | `$VAULT_ROOT/jobs` |
| `AGENDA_SYNC_MIN` | calendar-agenda refresh cadence (minutes) | `30` |
| `PYTHON_BIN` | interpreter the runner spawns the calendar feed with | `/usr/local/bin/python3` |
| `GCAL_CLIENT_SECRET` | Desktop OAuth client JSON (calendar feed) | `~/.claude/helm-gcal-client.json` |
| `GCAL_TOKEN` | stored Google refresh token (calendar feed) | `~/.claude/helm-gcal-token.json` |
| `HUD_TZ` | IANA timezone for "today" (HUD + runner) | `America/New_York` |
| `HUD_USER_NAME` | how voice notes refer to you | `User` |
| `HELM_MODEL` | model for background `claude -p` runs | `claude-opus-4-8` |
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

## Calendar agenda feed

The HUD's agenda tile is fed by `feeds/calendar-agenda.py`, a deterministic
Google Calendar API call the runner spawns on boot and every `AGENDA_SYNC_MIN`
minutes (it writes `system/agenda.json`; the HUD only ever reads that cache).
It replaced the headless `claude -p` agenda agent — no LLM, no MCP
([ADR 0008](decisions/0008-deterministic-feeds-over-llm.md)). One-time
setup:

1. Install the Google client libraries into the interpreter the runner uses
   (the same `PYTHON_BIN` the other feeds run under):

   ```
   /usr/local/bin/python3 -m pip install google-auth google-auth-oauthlib google-api-python-client
   ```

2. In [Google Cloud Console](https://console.cloud.google.com/): create a
   project, **enable the Google Calendar API**, then create an **OAuth client
   ID of type "Desktop app"** and download its JSON. Save it to
   `~/.claude/helm-gcal-client.json` (outside the vault — credentials never
   live in the vault, the repo, or transcripts).

3. Run the one-time consent (opens a browser, asks for read-only calendar
   access, stores a refresh token at `~/.claude/helm-gcal-token.json`):

   ```
   python3 feeds/calendar-agenda.py --auth
   ```

Every sync after that is headless. A `python3 feeds/calendar-agenda.py` with no
flag runs one sync by hand. If a sync writes `ok:false` with an `auth:` reason
(refresh token revoked/expired), re-run the `--auth` bootstrap — the reason
string names that command.

## Voice server setup

Fully local TTS + STT. One-time setup:

```bash
cd voice-server
python -m venv .venv
.venv/bin/pip install kokoro-onnx fastapi uvicorn websockets soundfile faster-whisper onnxruntime
# NVIDIA GPU: swap plain onnxruntime for onnxruntime-gpu + the matching
# nvidia-cudnn-cu12 / nvidia-cublas-cu12 / nvidia-cufft-cu12 wheels.
```

Download `kokoro-v1.0.onnx` (~325MB) and `voices-v1.0.bin` (~28MB) from the
[kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases)
into `voice-server/`. Start: `.venv/bin/python server.py`. GPU gives
~250ms/sentence TTS and ~130ms STT; CPU (e.g. Apple Silicon) works at ~4x
slower — use plain `onnxruntime` or set `KOKORO_DEVICE=cpu`/`WHISPER_DEVICE=cpu`.

**Pick your voice**: `python make_samples.py` regenerates `samples/` +
open `audition.html`, pick, set `KOKORO_VOICE`/`KOKORO_SPEED`, restart.

**Input is push-to-talk** (hold Space). Hands-free wake is off by default
and intentionally unbundled — without headphones the wake mic hears the
HUD's own speech. To opt in, `pip install --no-deps openwakeword` (the
`--no-deps` is LOAD-BEARING — a bare install overwrites onnxruntime-gpu
with the CPU build), point `WAKE_MODEL` at an openWakeWord model name, and
set `WAKE_WORD=on`.
