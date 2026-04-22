# Audiobook

Mini-app that turns public-domain books (Project Gutenberg, Standard Ebooks, Librivox) into narrated audiobooks using on-device Kokoro-82M TTS and `ffmpeg`. Runs inside an OpenClaw workspace as a pm2 process.

Slug: `audiobook` / identifier: `com.xaiworkspace.audiobook`.

## Architecture

```
chat command  ->  scripts/*.sh  ->  server.js (Node, port 3210)
                                    |
                                    +--  lib/*.js    (EPUB/PDF ingest, chapter detection, storage)
                                    +--  tts/tts.py  (Python stdin/stdout Kokoro sidecar)
                                    +--  ffmpeg      (wav -> mp3)
                                    +--  xai SDK     (audio playback via AudioPlayerService)
```

- **Node HTTP server** (`server.js`) — REST API consumed by chat scripts and the UI panel.
- **Python TTS sidecar** (`tts/tts.py`) — long-running process, stdin JSON prompts, stdout MP3 frames. Keeps the Kokoro model warm between chapters.
- **pm2** — supervisor, defined by the manifest `startup`/`cleanup` hooks; one process per install.

## Lazy install

`python3` and `ffmpeg` are baked into workspace image `v1.2.0+`, so the mini-app container boots with no extra system packages to fetch. The Kokoro model + voice pack are downloaded on first `@audiobook generate` call into `$APP_DATA_DIR/kokoro/` (~350 MB) and cached for subsequent generations. See `tts/README.md` for the model manifest.

## Key files

- `server.js` — HTTP + JSON API
- `lib/` — ingest (EPUB/PDF), chapter detection, storage, sharing client
- `scripts/` — shell entry points invoked by the persona's chat commands:
  - `status.sh`, `search.sh`, `import.sh`, `list.sh`, `chapters.sh`, `generate.sh`, `play.sh`, `voices.sh`
- `tts/` — Python TTS sidecar + requirements
- `ui/` — sandbox panel UI (served as the app's `ui: panel`)
- `manifest.yml` — permissions, commands, persona, parameters

## Chat commands

| Command | Purpose |
|---|---|
| `@audiobook status` | Health + disk usage |
| `@audiobook search <query>` | Search Project Gutenberg |
| `@audiobook import <url\|gutenberg-id>` | Ingest EPUB/PDF, detect chapters |
| `@audiobook list` | Show library |
| `@audiobook chapters <bookId>` | List chapters for a book |
| `@audiobook generate <bookId> [voice] [speed]` | Synthesise narration (skips already-rendered chapters) |
| `@audiobook play <bookId> [chapterIdx]` | Stream chapter audio via `xai.audio` |
| `@audiobook voices` | List recorded voice samples |

Chapter detection order: EPUB TOC -> PDF outline -> `^CHAPTER` regex -> 5000-char chunks.

## Environment variables

| Variable | Purpose |
|---|---|
| `APP_PORT` | Server listen port (manifest sets `3210`) |
| `APP_DATA_DIR` | Persistent storage root — books, chapter MP3s, Kokoro cache |
| `ROUTER_URL` | Router base URL used for Phase 7 sharing + callbacks |
| `APP_CALLBACK_TOKEN` | Bearer token for router callbacks (`X-App-Callback-Token`) |
| `BRIDGE_URL` | Local bridge base URL for sandbox proxy operations |
| `AUDIOBOOK_STRICT_VERIFY` | When `true`, fail generation if the Kokoro model checksum does not match the pinned manifest |

All variables are injected by the bridge at pm2 start; users do not set them manually.

## Phase 7 sharing

A book + its rendered chapters can be published to a public, read-only URL (`share.xaiworkspace.com/<shareId>`). The app posts to the router's `POST /api/audiobooks/share` endpoint, authenticating with `Authorization: Bearer <APP_CALLBACK_TOKEN>` plus the `X-App-Callback-Token` header. The router uploads chapter MP3s to S3 (`PUBLIC_AUDIOBOOKS_BUCKET`), serves them via CloudFront, and persists the share record. Unshare deletes the S3 objects.

## Deploy checklist

- [ ] Workspace image `v1.2.0` or newer pushed to ECR (python3 + ffmpeg baked in)
- [ ] `PUBLIC_AUDIOBOOKS_BUCKET`, `PUBLIC_AUDIOBOOKS_REGION`, `PUBLIC_AUDIOBOOKS_HOST` set on the router task
- [ ] S3 bucket + CloudFront distribution provisioned; `share.xaiworkspace.com` alias in place
- [ ] Migration `024_audiobook_shares.sql` run against the target database
- [ ] Router task role has `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the bucket
