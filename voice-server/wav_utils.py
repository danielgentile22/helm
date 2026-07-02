"""Pure audio-framing helpers for the /speak stream — no models, no FastAPI,
so test_server.py can import this without onnxruntime installed."""

import re
import struct


def wav_header(sample_rate: int) -> bytes:
    """Streaming WAV header with unknown length (0x7FFFFFFF) — browsers
    play it progressively and stop at end-of-stream."""
    data_size = 0x7FFFFFFF - 36
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_size, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16,
        b"data", data_size,
    )


SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+")


def chunks_of(text: str):
    """First sentence ships alone so playback starts ASAP; the rest glue
    into >=60-char chunks so tiny fragments don't chop the prosody."""
    parts = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()]
    if not parts:
        return [text]
    out, cur = [parts[0]], ""
    for p in parts[1:]:
        cur = f"{cur} {p}".strip()
        if len(cur) >= 60:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out
