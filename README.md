# Live Translation — Ukrainian → English subtitles

A tiny playground for the **OpenAI Realtime Translation API**
(`gpt-realtime-translate`). Open a local web page, press **Start listening**,
speak Ukrainian, and watch the English translation stream in like live
subtitles. The transcript keeps the full history: it autoscrolls while you're at
the bottom, and if you scroll up to read back it pauses following until you
return (or tap the **scroll-to-latest** button). A separate **viewer** page
shows clean, full-screen subtitles only — handy for a second screen or a
projector. A **source** page mirrors that view but shows the original Ukrainian
transcript instead of the English translation.

Built with **Node.js** and **Fastify**.

```
🎤  Browser (mic → 24 kHz PCM16)
      │  WebSocket (binary audio + control)
      ▼
🟢  Fastify server  ──────────────►  OpenAI Realtime Translation API
      │   (relays audio, keeps your API key private)   (gpt-realtime-translate)
      │  ◄──────────────  transcript deltas  ──────────────┘
      ▼
🖥️  Capture page  +  /viewer page (broadcast subtitles)
```

## How it works

- The **browser** captures the microphone, resamples it to 24 kHz mono PCM16 in
  an `AudioWorklet`, and streams it to the server over a WebSocket.
- The **Fastify server** relays that audio to OpenAI's
  `wss://api.openai.com/v1/realtime/translations` endpoint and configures the
  target language with a `session.update` event. Your API key never reaches the
  browser.
- OpenAI streams back `session.output_transcript.delta` (translated text),
  `session.output_audio.delta` (translated speech), and
  `session.input_transcript.delta` (the original-language transcript). The
  server forwards the translation to the capture page and `/viewer`, the source
  transcript to `/source`, and keeps a recent tail of each so late joiners can
  be synced.
- Both pages **append** incoming text to a scrollable transcript and autoscroll
  while pinned to the bottom — nothing is discarded, so you can scroll up to
  re-read at any time.

## Requirements

- **Node.js 20+** (developed on Node 24).
- An **OpenAI API key** with access to the `gpt-realtime-translate` model.
- A modern browser. **Chrome is recommended** (solid `AudioWorklet` +
  `getUserMedia` support). `http://localhost` is treated as a secure origin, so
  the microphone works without HTTPS.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure your key
cp .env.example .env
#   then edit .env and set OPENAI_API_KEY=sk-...

# 3. Start the server
npm start
```

Then open:

- **Capture / control page:** http://127.0.0.1:3000/
- **Viewer (English subtitles only):** http://127.0.0.1:3000/viewer
- **Transcript (original Ukrainian):** http://127.0.0.1:3000/source

Press **Start listening**, allow microphone access, and speak Ukrainian.

> Tip: open the viewer page in a separate window (or on a second monitor) and
> press <kbd>F11</kbd> for full-screen subtitles.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable                   | Default     | Description                                                       |
| -------------------------- | ----------- | ---------------------------------------------------------------- |
| `OPENAI_API_KEY`             | _(required)_ | Your OpenAI API key.                                            |
| `TARGET_LANGUAGE`            | `en`         | Output language code passed to `session.audio.output.language`. |
| `INPUT_TRANSCRIPTION_MODEL`  | `gpt-4o-transcribe` | Transcription model that enables the `/source` transcript. Empty = off. |
| `OPENAI_SAFETY_IDENTIFIER`   | _(empty)_    | Optional hashed user id (`OpenAI-Safety-Identifier` header).     |
| `TRANSCRIPT_DIR`             | `./transcripts` | Where the on-disk transcripts are written.                  |
| `LOG_LEVEL`                  | `info`       | pino log level (`trace`…`fatal`).                              |
| `LOG_FILE`                   | `./logs/app.log` | Single JSON log file, always appended, never rotated.      |
| `PORT`                       | `3000`       | Local server port.                                              |
| `HOST`                       | `127.0.0.1`  | Bind address.                                                   |
| `AUTH_USERNAME`              | _(empty)_    | Username for the optional login. Set with `AUTH_PASSWORD` to enable it. |
| `AUTH_PASSWORD`              | _(empty)_    | Password for the optional login. Both must be set to enable login. |
| `DB_PATH`                    | `./data/app.db` | SQLite file storing login sessions (only used when login is on). |
| `COOKIE_SECURE`             | `false`      | Mark the session cookie `Secure`. Set `true` **only** behind HTTPS. |

The source language (Ukrainian) is **auto-detected** by the model — you only
specify the target. To translate into another language, change
`TARGET_LANGUAGE` (e.g. `es`, `de`, `fr`).

`npm run dev` starts the server with `--watch` for auto-reload during edits.

## Optional login

By default the app is **fully open** — anyone who can reach the server can use
the capture page and the viewer/source pages. To put the capture/control page
behind a login, set **both** `AUTH_USERNAME` and `AUTH_PASSWORD` in `.env` (if
either is blank, login stays off).

When login is enabled:

- Visiting `/` redirects to a sign-in page. A successful login issues a
  **persistent session that lasts ~1 month** via an HTTP-only cookie. Sessions
  are stored in a local **SQLite** database (`DB_PATH`) using **Drizzle**.
- The **viewer** and **source** pages become private. They're reachable only via
  a unique link (`/viewer?token=<uuid>` / `/source?token=<uuid>`) — and the only
  way to get those links is the **Viewer / Transcript buttons on the main
  screen**. The token is a UUID generated once per login session (so it's stable
  for the life of that month-long session).
- You can be **logged in from several devices at once** with the same
  credentials. Every logged-in client sees the same live transcript and can
  **Stop** the session, but **only one client streams audio** to the model at a
  time. Pressing **Start** (or **Take over** on a client that isn't the current
  streamer) makes that client the sole streamer.

> **HTTPS note:** the session cookie is sent without the `Secure` flag by default
> so it works on plain-HTTP `localhost`. If you serve this over HTTPS, set
> `COOKIE_SECURE=true`.
>
> **Native module:** login uses `better-sqlite3`, a native addon. `npm install`
> normally downloads a prebuilt binary; it is tied to the Node major version, so
> reinstall (`npm rebuild better-sqlite3`) after upgrading Node.

## Saved transcripts

Every session is written to disk under `transcripts/` (configurable via
`TRANSCRIPT_DIR`), with **one file per day per stream**:

```
transcripts/
├── 2026-06-09-source.txt        # original Ukrainian
└── 2026-06-09-translation.txt   # English translation
```

- Files are **only appended to** — never overwritten or deleted.
- Each time you press **Start listening**, a timestamp marker is written to both
  files, separated from any earlier content by a blank line:

  ```
  ===== Session started 2026-06-09 15:35:33 =====
  ```

- The day's text from each session is appended under its marker as it streams,
  so a single day's file can accumulate many sessions in order. (The
  `transcripts/` directory is git-ignored.)

## Logs

Logging uses **pino** with two outputs at once:

- **Console** — pretty, colorized, human-readable (via `pino-pretty`).
- **File** — structured JSON, written to a single file (`LOG_FILE`, default
  `logs/app.log`). It is **always appended and never rotated**, so it grows
  across restarts; manage/truncate it yourself if needed. (`logs/` is
  git-ignored.)

The first upstream event of each type from OpenAI is logged (with a truncated
payload) as `[openai] first event: …`, which is handy for inspecting what the
translation model emits.

## Project layout

```
live-translation/
├── src/
│   ├── server.js            Fastify server: static files, auth, /ws relay, /ws/viewer + /ws/source broadcast
│   ├── openai-translator.js WebSocket client for the OpenAI Realtime Translation API
│   ├── transcript-store.js  Appends both streams to per-day files on disk
│   ├── auth.js              Optional login: credential check + session store helpers
│   ├── db/
│   │   ├── index.js         SQLite (better-sqlite3) + Drizzle connection
│   │   └── schema.js        Drizzle `sessions` table
│   └── config.js            Environment configuration
├── public/
│   ├── index.html           Capture / control page
│   ├── viewer.html          English subtitles-only viewer
│   ├── source.html          Original-language transcript viewer
│   ├── login.html           Sign-in page (when login is enabled)
│   ├── forbidden.html       Shown for invalid/expired viewer links
│   ├── css/styles.css
│   └── js/
│       ├── capture.js          Control socket + mic capture + transcript rendering
│       ├── login.js            Sign-in form
│       ├── viewer.js           Translated stream (+ audio) page
│       ├── source.js           Original-language stream page
│       ├── subtitle-stream.js  Shared read-only stream → transcript wiring
│       ├── transcript.js       Shared append-only transcript with smart autoscroll
│       ├── audio-player.js     Shared Web Audio playback of translated speech
│       ├── audio-toggle.js     Shared "Audio on/off" button wiring
│       └── pcm-worklet.js      AudioWorklet: resample to 24 kHz PCM16
├── .env.example
├── package.json
└── README.md
```

## Notes & limitations

- This is a **single-speaker playground**: the server keeps one shared live
  transcript and a single upstream translation session. Several control screens
  can be open at once, but only one streams audio — pressing **Start** / **Take
  over** transfers streaming to that client. Whoever is streaming drives every
  viewer.
- Translated **audio** is off by default. Click **Audio** (on either page) to
  hear the translation spoken — the server streams OpenAI's
  `session.output_audio.delta` (24 kHz PCM16) and the browser plays it back
  gaplessly via Web Audio. Text keeps updating regardless. On the **capture**
  page, wear headphones so the microphone doesn't pick up the playback and feed
  it back into the translation.
- The server keeps the most recent ~20,000 characters of each stream for syncing
  late joiners; during a live session clients receive every delta and keep the
  full history locally (cleared when you press **Start** again).
- The **source** (`/source`) page needs input transcription enabled — the
  session defaults to `audio.input.transcription: null`, so we set it in
  `session.update` (via `INPUT_TRANSCRIPTION_MODEL`) to make the model emit
  `session.input_transcript.delta`. If the page stays blank, check the server
  console: it logs the first occurrence of every upstream event type with a
  truncated payload (`[openai] first event: …`). If you see an error about the
  transcription model, try `gpt-4o-mini-transcribe` or `whisper-1`, or set
  `INPUT_TRANSCRIPTION_MODEL=` to turn the feature off.
- Microphone capture requires a secure context. `localhost` qualifies; if you
  serve this from another host, put it behind HTTPS.

## Troubleshooting

- **"OPENAI_API_KEY is not set on the server."** — Create `.env` from
  `.env.example` and restart `npm start`.
- **No microphone prompt / no audio** — Use Chrome, and make sure you opened the
  page via `http://127.0.0.1:3000` or `http://localhost:3000` (not a `file://`
  URL).
- **Nothing appears** — Check the server console; connection/auth errors from
  OpenAI are logged there and surfaced as a status message on the page.
