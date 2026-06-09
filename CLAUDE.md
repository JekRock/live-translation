# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm start          # run the server (node src/server.js)
npm run dev        # run with --watch for auto-reload during edits
```

There is no test suite, linter, or build step. Requires Node.js 20+ and an
`OPENAI_API_KEY` in `.env` (copy from `.env.example`). The app serves three
pages: `/` (capture/control), `/viewer` (English subtitles), `/source`
(original-language transcript).

## Architecture

This relays browser microphone audio to the **OpenAI Realtime Translation API**
(`gpt-realtime-translate`) and streams the translation back as live subtitles.
The Fastify server is the trust boundary: **the browser never talks to OpenAI
directly**, so the API key stays server-side.

### Audio + transcript flow

1. **`public/js/pcm-worklet.js`** — an `AudioWorkletProcessor` resamples the mic
   (typically 44.1/48 kHz) to **24 kHz mono PCM16** via linear interpolation,
   posting ~100 ms chunks to the main thread.
2. **`public/js/capture.js`** — sends those chunks as **binary** WebSocket frames
   to `/ws`, and renders/plays the JSON messages that come back.
3. **`src/server.js`** (`/ws` handler) — binary frames are forwarded to OpenAI as
   base64; the first JSON `{type:'start'}` message opens an upstream session.
4. **`src/openai-translator.js`** — the `ws` client to
   `wss://api.openai.com/v1/realtime/translations`. On open it sends one
   `session.update` to set the output language (and optionally enable input
   transcription). It maps the three upstream delta events to callbacks:
   - `session.output_transcript.delta` → `onTranslation` (English)
   - `session.input_transcript.delta` → `onSource` (original Ukrainian)
   - `session.output_audio.delta` → `onAudio` (base64 24 kHz PCM16 speech)
5. Back in `src/server.js`, those callbacks **fan out**: translation deltas go to
   the capture socket + `viewers`; source deltas go to `sourceViewers`; audio
   goes to the capture socket + `viewers`. Every delta is also appended to disk
   via **`src/transcript-store.js`**.

### Single shared broadcast

There is **one** live `state = { translation, source }` for the whole server —
this is a single-speaker playground. Whoever is on the capture page drives every
viewer. `/ws/viewer` and `/ws/source` are receive-only mirrors; on connect they
get a `{type:'sync'}` with the recent tail (capped at `MAX_TRANSCRIPT_CHARS`,
20 000 chars). Pressing **Start** broadcasts a `reset` to all clients and writes
a new session marker to disk.

### Client message protocol (server → browser, JSON)

`ready` (session configured — capture page then starts the mic), `sync` (full
tail for a late joiner), `delta` (new text to append), `audio` (base64 PCM16),
`reset`, `error`, `stopped`. Browser → server: `{type:'start'}`,
`{type:'stop'}`, and raw binary audio frames.

### Shared frontend modules

The viewer and source pages are nearly identical — both use
`public/js/subtitle-stream.js` (read-only WS → transcript wiring, with
auto-reconnect) and differ only in the socket path and whether they wire up
audio. `transcript.js` is the shared append-only transcript with smart
autoscroll (pauses following when the user scrolls up); `audio-player.js` /
`audio-toggle.js` handle gapless Web Audio playback of the translated speech.

## Key constraints & gotchas

- **The `/source` page depends on `INPUT_TRANSCRIPTION_MODEL`.** Input
  transcription defaults to `null` on the OpenAI session, so the original-language
  transcript only appears when that env var is set (default `gpt-4o-transcribe`).
  Set it empty to disable `/source`.
- **Source language is auto-detected**; only `TARGET_LANGUAGE` is configured.
- `transcript-store.js` **serializes all writes through one Promise chain** so the
  two streams never interleave a partial write. Files are append-only, one per
  day per stream (`YYYY-MM-DD-source.txt`, `YYYY-MM-DD-translation.txt`).
- On the capture page, **wear headphones** if you enable translated audio —
  otherwise the mic feeds the playback back into the translation.
- The first occurrence of each upstream OpenAI event type is logged once as
  `[openai] first event: …` (truncated payload) — the primary tool for inspecting
  what the model emits. Logs go to the console (pretty) and `LOG_FILE` (JSON,
  appended, never rotated).
