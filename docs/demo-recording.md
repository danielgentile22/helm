# Re-recording the demo GIF

The README GIF (`docs/demo.gif`) is recorded against the demo vault with a
real voice pipeline (voice server + local router). Fully scripted — no
screen-recording permission, no microphone: Playwright records the page
video, and Chromium's fake media stream plays a WAV as the mic.

## Prerequisites

- Voice server up (`http://127.0.0.1:3108/health`)
- Ollama up with the router model pulled (`ollama serve`; `VOICE_ROUTER=local`)
- HUD built and serving the demo vault on :3107 (stop the real HUD first —
  `launchctl bootout gui/$(id -u)/com.helm.hud`):
  `npx next build && VAULT_ROOT=$PWD/demo-vault npx next start -p 3107 -H 127.0.0.1`
- `npm i --no-save playwright && npx playwright install chromium`
- Reset demo voice state: `rm -rf demo-vault/system/voice demo-vault/system/queue`

## Record

Generate each spoken question as a WAV, **padded with trailing silence** —
Chromium loops the fake-mic file, so an unpadded clip gets transcribed as
"run the morning briefing, run the morning briefing, …":

```bash
say -o q1.wav --file-format=WAVE --data-format=LEI16@22050 -r 170 "How's the job search going?"
ffmpeg -i q1.wav -af "apad=pad_dur=15" -c:a pcm_s16le q1pad.wav   # same for q2
```

One segment per question (the fake-mic file is fixed per launch):

```bash
node scripts/record-demo.js q1pad.wav out/seg1 6000 2000 17000     # tier-2 question
node scripts/record-demo.js q2pad.wav out/seg2 5000 3000 12000 1   # tier-1 dispatch, ends on the Transcript overlay
```

Args: wav, output dir, hold-Space ms, wait-before-scroll ms, tail ms,
`1` = click Transcript at the end. **After each segment, check
`curl -s localhost:3107/api/transcript`** — capture is racy (a lost keyup
can transcribe the loop repeatedly and queue a stray intent). On a bad
take: restore `demo-vault/system/voice/memory.jsonl`, clear
`demo-vault/system/queue/`, re-run.

## Assemble

Concat both segments, 1.5× speedup (hides CPU STT/TTS latency; lands
~42s), 640px/7fps/96 colors to stay under GitHub's 10MB image proxy limit.
Captions are PNG overlays (Pillow-rendered; this ffmpeg lacks drawtext) —
timed on the sped-up timeline. Keep the full-quality source video local
(`~/Projects/helm-demo-recording/`), don't commit it.

## Cleanup

`git checkout demo-vault && rm -rf demo-vault/system/voice
demo-vault/system/queue`, stop the demo HUD, re-bootstrap `com.helm.hud`.
