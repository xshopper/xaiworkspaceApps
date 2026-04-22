# Audiobook TTS worker

Kokoro-82M CPU-friendly neural TTS. Spoken from Node via stdin/stdout JSON.

## Install

```bash
pip install -r requirements.txt
```

Download model assets (once):

```bash
mkdir -p /opt/kokoro
curl -L -o /opt/kokoro/kokoro-v0_19.onnx \
  https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/kokoro-v0_19.onnx
curl -L -o /opt/kokoro/voices.bin \
  https://huggingface.co/hexgrad/Kokoro-82M/resolve/main/voices.bin
```

Override locations via `KOKORO_MODEL` / `KOKORO_VOICES` env vars.

## Voices

54 voices, `af_*` (female), `am_*` (male), `bf_*` (British female), `bm_*` (British male), plus single-speaker packs. See model card for full list.

## Manual test

```bash
echo '{"jobId":"t1","text":"Hello world.","voice":"af_sky","speed":1.0,"outPath":"/tmp/out.wav"}' \
  | python3 tts_worker.py
```

## Convert to mp3

```bash
ffmpeg -y -i out.wav -codec:a libmp3lame -qscale:a 5 out.mp3
```

Node wrapper does this automatically via `lib/tts.js`.
