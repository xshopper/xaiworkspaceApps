#!/usr/bin/env python3
"""
Kokoro TTS worker. Reads JSON jobs from stdin, emits JSON progress to stdout.

Protocol (line-delimited JSON):

  Request:  {"jobId": "...", "text": "...", "voice": "af_sky", "speed": 1.0,
             "outPath": "/abs/path.wav"}
  Progress: {"jobId": "...", "event": "progress", "chunk": 3, "chunks": 10}
  Done:     {"jobId": "...", "event": "done", "outPath": "...", "durationSec": 123.4}
  Error:    {"jobId": "...", "event": "error", "message": "..."}
  Shutdown: {"action": "shutdown"}

The worker outputs WAV (Kokoro native). Node side converts to mp3 via ffmpeg.

Model assets:
  KOKORO_MODEL  (default: /opt/kokoro/kokoro-v0_19.onnx)
  KOKORO_VOICES (default: /opt/kokoro/voices.bin)

Chunking: text split at sentence boundaries; chunk target ~500 chars to bound
memory and allow incremental progress reporting. Chunks written sequentially
to a single WAV file.
"""

import json
import os
import re
import sys
import traceback
import wave

import numpy as np

try:
    from kokoro_onnx import Kokoro
except ImportError:
    print(json.dumps({"event": "fatal", "message": "kokoro_onnx not installed"}), flush=True)
    sys.exit(1)


MODEL_PATH = os.environ.get("KOKORO_MODEL", "/opt/kokoro/kokoro-v0_19.onnx")
VOICES_PATH = os.environ.get("KOKORO_VOICES", "/opt/kokoro/voices.bin")
CHUNK_CHARS = 500


def emit(obj):
    print(json.dumps(obj), flush=True)


def split_text(text):
    # Split on sentence-like boundaries keeping delimiters
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks, buf = [], ""
    for s in sentences:
        if not s:
            continue
        if len(buf) + len(s) + 1 <= CHUNK_CHARS:
            buf = f"{buf} {s}".strip()
        else:
            if buf:
                chunks.append(buf)
            if len(s) > CHUNK_CHARS:
                # Hard split long "sentence"
                for i in range(0, len(s), CHUNK_CHARS):
                    chunks.append(s[i:i + CHUNK_CHARS])
                buf = ""
            else:
                buf = s
    if buf:
        chunks.append(buf)
    return chunks


def run_job(kokoro, job):
    job_id = job["jobId"]
    text = job.get("text", "") or ""
    voice = job.get("voice", "af_sky")
    speed = float(job.get("speed", 1.0))
    out_path = job["outPath"]

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    chunks = split_text(text)
    if not chunks:
        emit({"jobId": job_id, "event": "error", "message": "empty text"})
        return

    sample_rate = 24000
    total_samples = 0

    with wave.open(out_path, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)  # int16
        wav.setframerate(sample_rate)

        for idx, chunk in enumerate(chunks):
            try:
                samples, sr = kokoro.create(chunk, voice=voice, speed=speed)
            except Exception as e:
                emit({"jobId": job_id, "event": "error", "message": f"chunk {idx}: {e}"})
                return
            sample_rate = sr
            wav.setframerate(sample_rate)
            arr = np.asarray(samples, dtype=np.float32)
            arr = np.clip(arr, -1.0, 1.0)
            int16 = (arr * 32767).astype(np.int16)
            wav.writeframes(int16.tobytes())
            total_samples += int16.shape[0]
            emit({
                "jobId": job_id,
                "event": "progress",
                "chunk": idx + 1,
                "chunks": len(chunks),
            })

    duration = total_samples / float(sample_rate) if sample_rate else 0.0
    emit({
        "jobId": job_id,
        "event": "done",
        "outPath": out_path,
        "durationSec": round(duration, 2),
    })


def main():
    try:
        kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
    except Exception as e:
        emit({"event": "fatal", "message": f"kokoro load failed: {e}"})
        sys.exit(1)

    emit({"event": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            emit({"event": "error", "message": "invalid json"})
            continue
        if msg.get("action") == "shutdown":
            break
        try:
            run_job(kokoro, msg)
        except Exception as e:
            emit({
                "jobId": msg.get("jobId"),
                "event": "error",
                "message": f"{e}\n{traceback.format_exc()}",
            })


if __name__ == "__main__":
    main()
