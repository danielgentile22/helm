#!/usr/bin/env python3
"""Fixture sweep for the voice-server's pure audio-framing helpers —
wav_header (RIFF framing for the streamed TTS response) and chunks_of
(the chunker that decides whether replies speak whole or clipped).

No models, no FastAPI, no network: the helpers live in wav_utils.py
precisely so this imports without onnxruntime. Mirrors the feeds tests
(PASS/FAIL lines, nonzero exit on any failure).

Run: python3 voice-server/test_server.py   (also wired into `npm test`)
"""
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from wav_utils import chunks_of, wav_header

passed = 0
failed = 0


def check(name, ok, got=None, want=None):
    global passed, failed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failed += 1
        print(f"FAIL  {name}\n      got:  {got!r}\n      want: {want!r}")


# --- wav_header --------------------------------------------------------------
h = wav_header(24000)
check("header is exactly 44 bytes", len(h) == 44, len(h), 44)
check("RIFF magic", h[0:4] == b"RIFF", h[0:4], b"RIFF")
check("WAVE magic", h[8:12] == b"WAVE", h[8:12], b"WAVE")
check("fmt chunk id", h[12:16] == b"fmt ", h[12:16], b"fmt ")
check("data chunk id", h[36:40] == b"data", h[36:40], b"data")

fmt_size, audio_fmt, channels, rate, byte_rate, block_align, bits = struct.unpack(
    "<IHHIIHH", h[16:36]
)
check("fmt chunk size 16 (PCM)", fmt_size == 16, fmt_size, 16)
check("format 1 = PCM", audio_fmt == 1, audio_fmt, 1)
check("mono", channels == 1, channels, 1)
check("sample rate little-endian", rate == 24000, rate, 24000)
check("byte rate = rate * 2 (16-bit mono)", byte_rate == 48000, byte_rate, 48000)
check("block align 2", block_align == 2, block_align, 2)
check("16 bits per sample", bits == 16, bits, 16)

riff_size = struct.unpack("<I", h[4:8])[0]
data_size = struct.unpack("<I", h[40:44])[0]
check("riff size = data size + 36", riff_size == data_size + 36, riff_size, data_size + 36)
check("streaming sentinel data size", data_size == 0x7FFFFFFF - 36, data_size, 0x7FFFFFFF - 36)

h48 = wav_header(48000)
check("rate field follows the argument", struct.unpack("<I", h48[24:28])[0] == 48000)
check("byte rate follows the argument", struct.unpack("<I", h48[28:32])[0] == 96000)

# --- chunks_of ----------------------------------------------------------------
one = chunks_of("Systems online.")
check("single sentence ships alone", one == ["Systems online."], one, ["Systems online."])

TEXT = (
    "Good morning. Revenue is up four percent this week. "
    "The runner finished two jobs overnight. Chess puzzle accuracy hit ninety. "
    "Nothing needs your attention before ten."
)
chunks = chunks_of(TEXT)
check("first sentence ships alone", chunks[0] == "Good morning.", chunks[0], "Good morning.")
check(
    "round-trips every word in order",
    " ".join(chunks).split() == TEXT.split(),
    " ".join(chunks).split(),
    TEXT.split(),
)
check(
    "glued chunks reach 60 chars (short tail excepted)",
    all(len(c) >= 60 for c in chunks[1:-1]),
    [len(c) for c in chunks],
)
check("no empty chunks", all(c for c in chunks), chunks)

TAIL = "First. Second one here. Tiny."
tail = chunks_of(TAIL)
check(
    "a sub-60-char tail still ships",
    " ".join(tail).split() == TAIL.split(),
    " ".join(tail).split(),
    TAIL.split(),
)

# --- summary -------------------------------------------------------------------
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
