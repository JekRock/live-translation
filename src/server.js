import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { config } from './config.js';
import { connectTranslator } from './openai-translator.js';
import * as store from './transcript-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Keep a generous tail of the transcript so a late-joining viewer can scroll
// back through recent history. Clients accumulate the full live stream via
// deltas; this only bounds what a fresh connection is sent on sync.
const MAX_TRANSCRIPT_CHARS = 20000;

// Shared live state for the single active broadcast. This is a play/test app
// with one speaker, so a single shared transcript is plenty.
const state = { translation: '', source: '' };

// Receive-only sockets that mirror a stream.
const viewers = new Set(); // translated (English) subtitles
const sourceViewers = new Set(); // original-language (Ukrainian) transcript

// Track which upstream event types we've seen, so the console shows (once each)
// exactly what the model emits — handy for confirming the source transcript.
const seenEventTypes = new Set();

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport: {
      targets: [
        // Pretty, human-readable output to the console.
        {
          target: 'pino-pretty',
          level: config.logLevel,
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
        // Structured JSON appended to a single fixed file (never rotated).
        {
          target: 'pino/file',
          level: config.logLevel,
          options: { destination: config.logFile, mkdir: true, append: true },
        },
      ],
    },
  },
});

// Route transcript-store write errors through the same logger.
store.setLogger(app.log);

if (!config.apiKey) {
  app.log.warn('OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
}

await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: PUBLIC_DIR });

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', (req, reply) => reply.sendFile('index.html'));
app.get('/viewer', (req, reply) => reply.sendFile('viewer.html'));
app.get('/source', (req, reply) => reply.sendFile('source.html'));

// ---------------------------------------------------------------------------
// Capture socket: receives control messages + binary PCM16 audio, relays to
// OpenAI, and streams transcripts back. Also drives the viewer broadcast.
// ---------------------------------------------------------------------------
app.get('/ws', { websocket: true }, (conn) => {
  const socket = conn.socket || conn; // works across @fastify/websocket versions
  let translator = null;

  const stop = () => {
    if (translator) {
      translator.close();
      translator = null;
    }
  };

  socket.on('message', (data, isBinary) => {
    // Binary frames are raw little-endian PCM16 @ 24 kHz audio chunks.
    if (isBinary) {
      if (translator) translator.sendAudio(data.toString('base64'));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (translator) return; // already running
      if (!config.apiKey) {
        send(socket, { type: 'error', message: 'OPENAI_API_KEY is not set on the server.' });
        return;
      }

      state.translation = '';
      state.source = '';
      seenEventTypes.clear();
      // Timestamp this session in the on-disk transcripts.
      store.startSession();
      send(socket, { type: 'reset' });
      broadcast(viewers, { type: 'reset' });
      broadcast(sourceViewers, { type: 'reset' });

      translator = connectTranslator({
        apiKey: config.apiKey,
        language: config.targetLanguage,
        inputTranscriptionModel: config.inputTranscriptionModel,
        safetyIdentifier: config.safetyIdentifier,
        onReady: () => send(socket, { type: 'ready', language: config.targetLanguage }),
        onEvent: (evt) => {
          if (!seenEventTypes.has(evt.type)) {
            seenEventTypes.add(evt.type);
            let sample = '';
            try {
              sample = JSON.stringify(evt);
              if (sample.length > 300) sample = `${sample.slice(0, 300)}…`;
            } catch {
              /* ignore */
            }
            app.log.info(`[openai] first event: ${evt.type}  ${sample}`);
          }
        },
        onTranslation: (delta) => {
          state.translation = appendCapped(state.translation, delta);
          store.appendTranslation(delta);
          // Stream just the new text; clients append and keep their own history.
          send(socket, { type: 'delta', text: delta });
          broadcast(viewers, { type: 'delta', text: delta });
        },
        onSource: (delta) => {
          // Original-language (Ukrainian) transcript. Only the /source mirrors
          // care about it; the capture page and /viewer ignore it.
          state.source = appendCapped(state.source, delta);
          store.appendSource(delta);
          broadcast(sourceViewers, { type: 'delta', text: delta });
        },
        onAudio: (data) => {
          // Translated speech (base64 24 kHz PCM16). Clients play it only if the
          // user has enabled audio; not buffered, so late joiners just hear from
          // when they connect.
          send(socket, { type: 'audio', data });
          broadcast(viewers, { type: 'audio', data });
        },
        onError: (message) => send(socket, { type: 'error', message }),
        onClose: () => {
          send(socket, { type: 'stopped' });
          translator = null;
        },
      });
    } else if (msg.type === 'stop') {
      stop();
    }
  });

  socket.on('close', () => {
    if (translator) {
      translator.terminate();
      translator = null;
    }
  });
});

// ---------------------------------------------------------------------------
// Viewer socket: receive-only mirror of the subtitles.
// ---------------------------------------------------------------------------
app.get('/ws/viewer', { websocket: true }, (conn) => {
  const socket = conn.socket || conn;
  viewers.add(socket);
  // Bring a late joiner up to date with the full transcript so far.
  send(socket, { type: 'sync', text: state.translation });
  socket.on('close', () => viewers.delete(socket));
  socket.on('error', () => viewers.delete(socket));
});

// ---------------------------------------------------------------------------
// Source socket: receive-only mirror of the original-language transcript.
// ---------------------------------------------------------------------------
app.get('/ws/source', { websocket: true }, (conn) => {
  const socket = conn.socket || conn;
  sourceViewers.add(socket);
  send(socket, { type: 'sync', text: state.source });
  socket.on('close', () => sourceViewers.delete(socket));
  socket.on('error', () => sourceViewers.delete(socket));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(socket, obj) {
  try {
    if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function broadcast(targets, obj) {
  const msg = JSON.stringify(obj);
  for (const v of targets) {
    try {
      if (v.readyState === 1) v.send(msg);
    } catch {
      /* ignore */
    }
  }
}

function appendCapped(text, delta) {
  const next = text + delta;
  return next.length > MAX_TRANSCRIPT_CHARS
    ? next.slice(next.length - MAX_TRANSCRIPT_CHARS)
    : next;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Capture page:  http://${config.host}:${config.port}/`);
  app.log.info(`Viewer page:   http://${config.host}:${config.port}/viewer`);
  app.log.info(`Source page:   http://${config.host}:${config.port}/source`);
  app.log.info(`Transcripts:   ${store.TRANSCRIPT_DIR}`);
  app.log.info(`Log file:      ${config.logFile}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
