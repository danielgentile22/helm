"""
helm local voice, Kokoro-82M TTS + faster-whisper STT behind FastAPI
on :3108.

A standalone local process that holds the warm models. Callers detect it
via /health; there is no cloud fallback.

GET  /health         -> {"ok": true, "voice": "...", "stt": {...}}
GET  /speak?text=... -> audio/wav, streamed sentence-by-sentence so the
                        browser starts playback after the FIRST sentence
                        is generated, not the whole reply.
POST /stt            -> raw audio body (webm/opus/wav) -> {"text": "..."}
                        faster-whisper on CPU int8 (M1 Pro, no CUDA).

Run: .venv/bin/python server.py
"""

import asyncio
import io
import json
import os
import threading
import time

import numpy as np
import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from faster_whisper import WhisperModel
from kokoro_onnx import Kokoro

from wakeword import WakeListener, WAKE_MODEL
from wav_utils import chunks_of, wav_header

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = 3108
VOICE = os.environ.get("KOKORO_VOICE", "bm_george")  # calm British male
SPEED = float(os.environ.get("KOKORO_SPEED", "1.0"))
SAMPLE_RATE = 24000  # kokoro output rate
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small.en")
# Vocabulary bias for the recognizer. The words that matter are personal (project names,
# people), so they live in state, not here: WHISPER_PROMPT, else the text of
# ~/.helm/voice/whisper-prompt.txt, else a generic prompt.
_PROMPT_FILE = os.path.join(os.environ.get("HELM_STATE") or os.path.expanduser("~/.helm"), "voice", "whisper-prompt.txt")
WHISPER_PROMPT = os.environ.get("WHISPER_PROMPT") or (
    open(_PROMPT_FILE).read().strip() if os.path.isfile(_PROMPT_FILE) else
    "helm voice commands across the Work, Projects, Chess and Life departments: "
    "routines, todos, directives."
)

app = FastAPI()

# CPU is the only path on this machine (M1 Pro, no CUDA), so both devices are
# constants rather than probes. /health still reports them.
KOKORO_DEVICE = "cpu"
kokoro = Kokoro(os.path.join(HERE, "kokoro-v1.0.onnx"), os.path.join(HERE, "voices-v1.0.bin"))

WHISPER_DEVICE = "cpu"
whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

# one whisper model, two callers (/stt route + wake-word thread) — serialize
whisper_lock = threading.Lock()

# :3108 bounds its own memory: a caller can stream any size it likes
MAX_STT_BYTES = 8 * 1024 * 1024


def transcribe_locked(audio):
    """audio: float32 mono 16k array (wake path) or a file-like of
    webm/opus/wav bytes (/stt) -> text. Serializes on whisper_lock."""
    with whisper_lock:
        segments, _info = whisper.transcribe(
            audio, beam_size=1, language="en", vad_filter=False,
            initial_prompt=WHISPER_PROMPT,
        )
        # segments is a lazy generator — consume INSIDE the lock or the
        # actual decode runs unguarded
        return " ".join(s.text.strip() for s in segments).strip()


# --- wake word + event stream ---------------------------------------------
# Clients connect to ws://:3108/events. The wake thread emits through
# emit_event() which hops onto the uvicorn event loop thread-safely.

# Push-to-talk is the default. Hands-free wake is opt-in and needs BOTH the
# switch on (WAKE_WORD=on) AND a wake model (WAKE_MODEL, none ships with
# helm). Either one missing ⇒ the listener never starts and /health reports
# wake disabled.
_wake_requested = os.environ.get("WAKE_WORD", "off").lower() not in ("off", "0", "false")
WAKE_ENABLED = _wake_requested and bool(WAKE_MODEL)
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))

ws_clients: set = set()
main_loop = None


def emit_event(payload: dict):
    if main_loop is None:
        return
    msg = json.dumps(payload)

    async def _send():
        for ws in list(ws_clients):
            try:
                await ws.send_text(msg)
            except Exception:
                ws_clients.discard(ws)

    asyncio.run_coroutine_threadsafe(_send(), main_loop)


wake = WakeListener(transcribe_locked, emit_event, threshold=WAKE_THRESHOLD) if WAKE_ENABLED else None


@app.websocket("/events")
async def events(ws: WebSocket):
    await ws.accept()
    # hello tells the client whether hands-free is actually armed. It can't
    # read /health cross-origin, and "wake word armed" must not lie
    await ws.send_text(json.dumps({"type": "hello", "wake": bool(wake and wake.ok)}))
    ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # client pings — content ignored
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


@app.on_event("startup")
async def _startup():
    global main_loop
    main_loop = asyncio.get_running_loop()
    if wake is not None:
        wake.start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "kokoro",
        "voice": VOICE,
        "device": KOKORO_DEVICE,
        "stt": {"ok": True, "model": WHISPER_MODEL, "device": WHISPER_DEVICE},
        "wake": {
            "enabled": WAKE_ENABLED,
            "ok": bool(wake and wake.ok),
            "model": WAKE_MODEL,
            "threshold": WAKE_THRESHOLD,
            "error": wake.error if wake else None,
        },
    }


@app.post("/stt")
async def stt(req: Request):
    cl = req.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_STT_BYTES:
        return Response(status_code=413, content="clip too large")
    audio = await req.body()
    if len(audio) > MAX_STT_BYTES:  # chunked upload with no content-length
        return Response(status_code=413, content="clip too large")
    if len(audio) < 1000:
        return Response(status_code=400, content="clip too short")
    t0 = time.time()
    # faster-whisper decodes webm/opus/wav via PyAV from a file-like object.
    # CPU decode takes ~1s — run it (and the lock wait, which the wake thread
    # may hold) off the event loop so /health, /events and /speak stay alive.
    text = await asyncio.to_thread(transcribe_locked, io.BytesIO(audio))
    return {"text": text, "ms": int((time.time() - t0) * 1000)}


@app.get("/speak")
def speak(text: str = ""):
    text = text.strip()[:900]
    if not text:
        return Response(status_code=400, content="empty text")

    def gen():
        yield wav_header(SAMPLE_RATE)
        for chunk in chunks_of(text):
            samples, sr = kokoro.create(chunk, voice=VOICE, speed=SPEED, lang="en-gb")
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
            yield pcm.tobytes()
            # short breath between sentences
            yield b"\x00" * int(SAMPLE_RATE * 0.12) * 2

    return StreamingResponse(gen(), media_type="audio/wav",
                             headers={"Cache-Control": "no-store"})


if __name__ == "__main__":
    # warm both models so the first real request doesn't pay init cost.
    # whisper loads and unpacks its int8 weights on the first transcribe,
    # so feed it kokoro's warmup audio and the whole pipeline is hot
    samples, _ = kokoro.create("Systems online.", voice=VOICE, speed=SPEED, lang="en-gb")
    warm = io.BytesIO()
    import soundfile as sf
    sf.write(warm, samples, SAMPLE_RATE, format="WAV")
    warm.seek(0)
    list(whisper.transcribe(warm, beam_size=1, language="en")[0])
    print(f"kokoro({KOKORO_DEVICE}) + whisper({WHISPER_MODEL}/{WHISPER_DEVICE}) warm, serving :{PORT} voice={VOICE}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
