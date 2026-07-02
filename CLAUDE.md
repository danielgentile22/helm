# HELM — Claude Code instructions

This is Daniel's personal HELM project — a voice-controlled, file-backed
heads-up display. Treat `.helm-config.json` as the record of how this
machine is wired (vault path, timezone, voice, router, launchd agents).

## Platform

Runs on macOS (Apple Silicon). Voice runs in CPU mode (plain
`onnxruntime`): slower than GPU but fully functional. The `.vbs` files in
the repo are leftover Windows launchers — on this machine, use the direct
commands or the `com.helm.*` launchd agents.

## "Spin up HELM" — the start-everything playbook

When the user asks to start/spin up/boot HELM (any phrasing), do this, in
order, skipping anything already running. The fastest path is the launchd
agents (`launchctl kickstart -k gui/$(id -u)/com.helm.<name>`); the direct
commands below are the fallback.

1. Voice server: probe `http://127.0.0.1:3108/health`. Down → kickstart
   `com.helm.voice`, or launch `voice-server/.venv/bin/python
   voice-server/server.py` detached (`nohup … &`). If the venv doesn't
   exist, say voice isn't set up yet (README has the section) and continue
   — the HUD runs fine silent.
2. Runner: check the heartbeat file `<vault>/system/runner-status.json`
   (stale > 2 min = down). Down → kickstart `com.helm.runner`, or
   `node runner/runner.js` detached.
3. HUD: probe `http://localhost:3107`. Down → kickstart `com.helm.hud`, or
   `npx next build && npx next start -p 3107 -H 127.0.0.1` detached
   (loopback-only on purpose — see Security perimeter).
   IMPORTANT: launch DETACHED — a plain background shell command dies when
   this Claude session closes.
4. Tell the user: open `http://localhost:3107`, hold Space to talk. Remind
   them the first audio needs one click/keypress in the tab (browser
   autoplay policy).

The `com.helm.*` launchd agents live in `~/Library/LaunchAgents/` and
start everything at login — the authoritative inventory (services, feed
schedules, and scheduled skills like the Sunday 17:00 weekly-review) is
the `launchdAgents` list in `.helm-config.json`; canonical plists are
versioned in `scripts/`.

## Project facts

- Next.js 15 HUD on **:3107** (`npx next dev -p 3107`), Python voice-server
  on **:3108** (Kokoro TTS + faster-whisper STT), Node runner daemon in
  `runner/` that executes skills via headless `claude -p`.
- Voice input is **push-to-talk only** (hold Space). There is no wake word
  bundled; hands-free is opt-in via `WAKE_MODEL` + `WAKE_WORD=on`.
- All state lives as plain files under the vault (`VAULT_ROOT`). No
  database. The architecture one-pager is `docs/architecture.html`; the
  README has the short version.
- Quality gates: `npm test` (runner syntax check + TS suites — router
  sweep, skill/tab contract, security, feeds, chat — plus python3
  voice-server/feed suites; needs `python3` on PATH; no API spend) and
  `npx tsc --noEmit`. Run both after touching `lib/`.

## Security perimeter (issue #36 — don't quietly widen it)

- **`HELM_API_KEY`** (in `~/.claude/.env`) is the shared secret behind every
  state-changing route (`/api/queue`, `/api/voice`, `/api/voice/text`,
  `/api/chat`, `/api/transcript` DELETE). Requests must send it
  as `X-HELM-KEY`; the HUD's own pages fetch it from `/api/key`
  (lib/helmKey.ts). Server check lives in lib/auth.ts — fail-closed: no key
  configured means 503 on writes. Curl example:
  `curl -X POST localhost:3107/api/queue -H "X-HELM-KEY: $(sed -n 's/^HELM_API_KEY=//p' ~/.claude/.env)" …`
- The Mac HUD binds **127.0.0.1 only** (`-H 127.0.0.1` in com.helm.hud.plist
  and the manual command above). Never bind 0.0.0.0 — /api/queue feeds the
  runner's `claude -p --dangerously-skip-permissions`.
- The vault's `.stignore` (Mac vault root + written by entrypoint.sh on the
  Fly VM) keeps `system/queue/` and `system/runs/` OUT of Syncthing — synced
  peers must never be able to enqueue runner work. Don't delete it.
- The Fly image sets `CHAT_ONLY=1`: middleware.ts 404s every API route except
  `/api/chat` + `/api/key`.

## Load-bearing couplings (break one and voice quietly misroutes)

- `ALLOWED_SKILLS` in `lib/skills.ts` ⟷ `buildPrompt()` cases in
  `runner/runner.js` ⟷ `DECK_SKILLS` + `SKILL_TAB` in `lib/tabs.ts` — all
  three must list the same skills (union guarded by scripts/test-tabs.ts
  and scripts/test-skill-contract.ts).
- Offer wording in `briefingOffer()` (lib/router.ts) ⟷ `OFFER_SKILLS` keys
  ⟷ the regex in `pendingOffer()` — the spoken offer is parsed back out of
  conversation memory verbatim when the user answers "yes".
- `HUD_TZ` (lib/config.ts) ⟷ the runner's `HUD_TZ` — both default
  America/New_York (matching .helm-config.json); change them TOGETHER or
  "today" splits across two dates. test-skill-contract.ts asserts they match.

## Editing gotchas

- After editing `runner/runner.js`, ALWAYS `node --check runner/runner.js`
  — the runner fails silently on syntax errors (stale heartbeat, no log).
- Testing `/api/voice` with a command phrase queues a REAL intent the
  runner will execute. Use tier-2 questions ("what's in the queue") for
  pipeline tests.
- Two HUD tabs = double audio. Browser autoplay needs one click/keypress.
- Next dev can hang after webpack cache corruption: kill node on 3107,
  delete `.next/`, restart.
