# voice

helm's local voice process. Kokoro-82M for text to speech, faster-whisper for
speech to text, both behind FastAPI on `127.0.0.1:3108`. Everything runs on this
machine. No cloud, no API keys, no network calls once the models are on disk.

Ported from the archived Helm project, stripped of its Windows and CUDA paths.
This runs CPU only.

## Running it

launchd keeps it alive as the `voice` service in `models.json`, started at login and
restarted if it exits, so normally nothing has to be done. `runner/install-routines.sh`
installs it, and `launchctl kickstart -k gui/$(id -u)/com.helm.voice` restarts it by
hand. Its output is in `~/.helm/logs/com.helm.voice.out` and `.err`. To run it in a
terminal instead, stop the service first or the two fight over the port:

```
voice/.venv/bin/python voice/server.py
```

It loads both models, warms the pipeline with one synthesis and one
transcription, prints a ready line, and only then opens the port. A successful
`GET /health` means the whole pipeline is hot, so the first real request pays no
init cost.

First-time setup:

```
python3 -m venv voice/.venv
voice/.venv/bin/pip install -r voice/requirements.txt
```

Python 3.11 is what this was built and measured against.

## The model binaries

Two files sit next to `server.py` and are gitignored, because they are 337 MB of
upstream weights rather than source:

| File | Size | Where it comes from |
|---|---|---|
| `kokoro-v1.0.onnx` | 310 MB | [kokoro-onnx GitHub releases](https://github.com/thewh1teagle/kokoro-onnx/releases) |
| `voices-v1.0.bin` | 27 MB | same release |

Download both from that releases page and drop them in this directory.
The whisper weights are different: faster-whisper pulls `small.en` from Hugging
Face on first run and caches it under `~/.cache/huggingface`, so there is nothing
to place by hand.

## The HTTP surface

| Route | What it does |
|---|---|
| `GET /health` | engine, voice, device, STT model, and whether wake word is armed |
| `GET /speak?text=...` | `audio/wav`, streamed sentence by sentence so playback can start on the first sentence |
| `POST /stt` | raw webm, opus or wav body, capped at 8 MB, returns `{"text": ..., "ms": ...}` |
| `WS /events` | wake word and transcript events, only interesting when wake word is on |

Configuration is all environment variables: `KOKORO_VOICE` (default `bm_george`),
`KOKORO_SPEED`, `WHISPER_MODEL` (default `small.en`), and `WHISPER_PROMPT`, which
biases the recognizer toward your vocabulary so names and project words come back
spelled right. Without it the server reads `~/.helm/voice/whisper-prompt.txt`, which
keeps personal names out of the repo.

Hands-free wake is opt-in and off. It needs both `WAKE_WORD=on` and a
`WAKE_MODEL` naming an openWakeWord model, and no wake model ships with helm.
`wakeword.py` imports `openwakeword` and `sounddevice` lazily inside the listener
thread, so neither is in `requirements.txt` and neither is needed while wake is
off.

## Measured on M1 Pro, 2026-09-22

Apple M1 Pro, 16 GB, macOS. CPU only, no CUDA, no CoreML. Every number below
came from `curl` against the live server on loopback, one run, models already
warm.

| Measurement | Value | Notes |
|---|---|---|
| Cold start until `/health` answers | 3 s | loads both models and warms the pipeline before the port opens, with the weights already in page cache |
| `/speak` time to first byte | 1 ms | the 44-byte WAV header, which the generator yields before synthesizing anything |
| `/speak` time to first audio | 0.87 s | first sentence synthesized, playback can start here |
| `/speak` total | 1.61 s | two sentences, 6.2 s of audio, 292 KB |
| `/speak` realtime factor | 0.26x | synthesis outruns playback by about 3.8 to 1 |
| `/stt` on that 6.2 s reply | 1.24 s | server self-reported 1238 ms |
| `/stt` on a 3.9 s `say` clip | 0.89 s | server self-reported 889 ms |
| Resident memory, idle | 1649 MB | kokoro plus whisper `small.en` int8, both resident |
| CPU over 10 s idle | 1.2% | no polling loop, and the wake listener is off |

The `/speak` text was "Three todos are open in the Chess department. Nothing in
Work needs you before ten." Its WAV reads back through `soundfile` at 24000 Hz,
1 channel, 6.2 s.

Two transcription round trips, both clean:

- The synthesized reply above came back as "Three todos are open in the Chess
  department. Nothing in Work needs you before 10."
- A clip from `say -o clip.aiff "add a todo to the chess department, review the
  game from Saturday"`, converted with `afconvert -f WAVE -d LEI16@16000 -c 1`,
  came back as "Add a todo to the chess department. Review the game from
  Saturday."

Both differ from the input only in punctuation and in "ten" being normalized to
"10", which is whisper's number formatting rather than a recognition error.

Read that memory figure before wiring this into anything that runs all day. 1.6
GB resident on a 16 GB laptop is a real cost, and the process holds it whether or
not anyone is talking to it.

## Tests

```
voice/.venv/bin/python voice/test_server.py
```

22 assertions over the pure audio-framing helpers in `wav_utils.py`: the RIFF
header the streamed response opens with, and the chunker that decides where
sentences break. No models, no FastAPI, no network, so it runs in milliseconds.
Nothing in it was device-specific, so there was nothing CUDA-only to skip.
