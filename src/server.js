import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import gracefulShutdown from 'fastify-graceful-shutdown';

import { config } from './config.js';
import { connectTranslator } from './openai-translator.js';
import * as store from './transcript-store.js';
import * as auth from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Served with an explicit 403 for invalid/expired viewer links.
const FORBIDDEN_HTML = readFileSync(join(PUBLIC_DIR, 'forbidden.html'), 'utf8');

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

// Capture/control sockets. Several clients may be connected at once (e.g. the
// same login open on two devices); they all see the live transcript and can
// stop the session, but only ONE — the speaker — streams audio to the model.
const captureSockets = new Set();

// The single, server-wide translation session.
let translator = null;
let speakerSocket = null; // whose binary audio is forwarded to the model
// Bumped on every start/take-over. Each translator's callbacks capture the id
// they were created with and no-op if it's no longer current — this defeats the
// take-over race where a terminated session's async onClose would otherwise
// clobber the session that replaced it.
let sessionId = 0;

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
app.log.info(
  auth.authEnabled()
    ? 'Login is ENABLED for the capture page.'
    : 'Login is disabled (set AUTH_USERNAME and AUTH_PASSWORD to enable it).'
);

await app.register(fastifyCookie);
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, { root: PUBLIC_DIR });

// Close the server cleanly on SIGINT/SIGTERM (e.g. Fly autostop) so WebSocket
// connections close and the Pino file logger flushes before the process exits.
await app.register(gracefulShutdown);

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

// Page guard: the capture/control page requires a valid session when auth is on.
function isLoggedIn(req) {
  return Boolean(auth.getSession(req.cookies?.session));
}

// Route guard for the read-only viewer/source pages. When auth is on they're
// reachable only via ?token=<viewerToken> from a live login session.
function requireViewerToken(req, reply) {
  if (!auth.authEnabled()) return true;
  if (auth.getSessionByViewerToken(req.query?.token)) return true;
  reply.code(403).type('text/html').send(FORBIDDEN_HTML);
  return false;
}

// preValidation hooks for the WebSocket upgrades. The upgrade request runs the
// full Fastify lifecycle, so req.cookies / req.query are populated here; sending
// a reply refuses the upgrade.
async function wsRequireSession(req, reply) {
  if (!auth.authEnabled()) return;
  if (!isLoggedIn(req)) return reply.code(401).send('unauthorized');
}
async function wsRequireViewerToken(req, reply) {
  if (!auth.authEnabled()) return;
  if (!auth.getSessionByViewerToken(req.query?.token)) {
    return reply.code(401).send('unauthorized');
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get('/', (req, reply) => {
  if (auth.authEnabled() && !isLoggedIn(req)) return reply.redirect('/login');
  return reply.sendFile('index.html');
});

app.get('/login', (req, reply) => {
  if (!auth.authEnabled()) return reply.redirect('/');
  if (isLoggedIn(req)) return reply.redirect('/');
  return reply.sendFile('login.html');
});

app.get('/viewer', (req, reply) => {
  if (requireViewerToken(req, reply)) return reply.sendFile('viewer.html');
});
app.get('/source', (req, reply) => {
  if (requireViewerToken(req, reply)) return reply.sendFile('source.html');
});

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------
app.post('/login', (req, reply) => {
  if (!auth.authEnabled()) return reply.code(404).send({ ok: false });
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(username, password)) {
    return reply.code(401).send({ ok: false });
  }
  const { token } = auth.createSession();
  reply.setCookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days, in seconds
    secure: config.cookieSecure,
  });
  return { ok: true };
});

app.post('/logout', (req, reply) => {
  auth.deleteSession(req.cookies?.session);
  reply.clearCookie('session', { path: '/' });
  return { ok: true };
});

// Lets the (already-authenticated) capture page learn its viewer token so it can
// build the /viewer & /source links. With auth off there's no token to hand out.
app.get('/api/session', (req, reply) => {
  if (!auth.authEnabled()) return { authEnabled: false, viewerToken: null };
  const sess = auth.getSession(req.cookies?.session);
  if (!sess) return reply.code(401).send({ authEnabled: true });
  return { authEnabled: true, viewerToken: sess.viewerToken };
});

// ---------------------------------------------------------------------------
// Capture socket: receives control messages + binary PCM16 audio, relays to
// OpenAI, and streams transcripts back. Several may connect; only the speaker's
// audio is forwarded. Any client can start (take over) or stop the session.
// ---------------------------------------------------------------------------
app.get('/ws', { websocket: true, preValidation: wsRequireSession }, (conn) => {
  const socket = conn.socket || conn; // works across @fastify/websocket versions
  captureSockets.add(socket);

  // Bring this control screen up to date, then tell it its role.
  send(socket, { type: 'sync', text: state.translation });
  send(socket, { type: 'status', running: Boolean(translator), isSpeaker: false });

  socket.on('message', (data, isBinary) => {
    // Binary frames are raw little-endian PCM16 @ 24 kHz audio chunks. Only the
    // active speaker's audio reaches the model.
    if (isBinary) {
      if (translator && socket === speakerSocket) translator.sendAudio(data.toString('base64'));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      if (!config.apiKey) {
        send(socket, { type: 'error', message: 'OPENAI_API_KEY is not set on the server.' });
        return;
      }
      startTranslator(socket); // start fresh, or take over an existing session
    } else if (msg.type === 'stop') {
      stopTranslator();
    }
  });

  socket.on('close', () => {
    captureSockets.delete(socket);
    if (socket === speakerSocket) {
      // The streamer disconnected — end the shared session.
      stopTranslator();
    } else {
      broadcastStatus();
    }
  });
  socket.on('error', () => captureSockets.delete(socket));
});

// ---------------------------------------------------------------------------
// Viewer socket: receive-only mirror of the subtitles.
// ---------------------------------------------------------------------------
app.get('/ws/viewer', { websocket: true, preValidation: wsRequireViewerToken }, (conn) => {
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
app.get('/ws/source', { websocket: true, preValidation: wsRequireViewerToken }, (conn) => {
  const socket = conn.socket || conn;
  sourceViewers.add(socket);
  send(socket, { type: 'sync', text: state.source });
  socket.on('close', () => sourceViewers.delete(socket));
  socket.on('error', () => sourceViewers.delete(socket));
});

// ---------------------------------------------------------------------------
// Translation session management (single shared translator)
// ---------------------------------------------------------------------------
function startTranslator(socket) {
  // Take over any session already running.
  if (translator) {
    translator.terminate();
    translator = null;
  }
  // Bump BEFORE wiring callbacks so the just-terminated session's async onClose
  // is already stale and won't touch the new one.
  const mySession = ++sessionId;

  state.translation = '';
  state.source = '';
  seenEventTypes.clear();
  // Timestamp this session in the on-disk transcripts.
  store.startSession();
  speakerSocket = socket;

  // Clear every screen for the fresh session.
  broadcast(viewers, { type: 'reset' });
  broadcast(sourceViewers, { type: 'reset' });
  broadcast(captureSockets, { type: 'reset' });

  translator = connectTranslator({
    apiKey: config.apiKey,
    language: config.targetLanguage,
    inputTranscriptionModel: config.inputTranscriptionModel,
    safetyIdentifier: config.safetyIdentifier,
    onReady: () => {
      if (mySession !== sessionId) return;
      // Only the speaker is told to start its mic.
      send(speakerSocket, { type: 'ready', language: config.targetLanguage });
    },
    onEvent: (evt) => {
      if (mySession !== sessionId) return;
      logFirstEvent(evt);
    },
    onTranslation: (delta) => {
      if (mySession !== sessionId) return;
      state.translation = appendCapped(state.translation, delta);
      store.appendTranslation(delta);
      // Stream just the new text; clients append and keep their own history.
      broadcast(viewers, { type: 'delta', text: delta });
      broadcast(captureSockets, { type: 'delta', text: delta });
    },
    onSource: (delta) => {
      if (mySession !== sessionId) return;
      // Original-language (Ukrainian) transcript. Only the /source mirrors care.
      state.source = appendCapped(state.source, delta);
      store.appendSource(delta);
      broadcast(sourceViewers, { type: 'delta', text: delta });
    },
    onAudio: (data) => {
      if (mySession !== sessionId) return;
      // Translated speech (base64 24 kHz PCM16). The speaker hears it locally;
      // viewers play it if they've enabled audio. Not buffered for late joiners.
      send(speakerSocket, { type: 'audio', data });
      broadcast(viewers, { type: 'audio', data });
    },
    onError: (message) => {
      if (mySession !== sessionId) return;
      send(speakerSocket, { type: 'error', message });
    },
    onClose: () => {
      if (mySession !== sessionId) return; // stale session — ignore
      translator = null;
      speakerSocket = null;
      broadcast(captureSockets, { type: 'stopped' });
      broadcastStatus();
    },
  });

  broadcastStatus();
}

function stopTranslator() {
  if (translator) translator.terminate();
  // The guarded onClose nulls translator/speakerSocket and fans out stopped+status.
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(socket, obj) {
  try {
    if (socket && socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(obj));
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

// Tell every control screen whether a session is live and whether it's the one
// streaming. isSpeaker differs per socket, so this is a per-socket send.
function broadcastStatus() {
  const running = Boolean(translator);
  for (const s of captureSockets) {
    send(s, { type: 'status', running, isSpeaker: s === speakerSocket });
  }
}

function logFirstEvent(evt) {
  if (seenEventTypes.has(evt.type)) return;
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

function appendCapped(text, delta) {
  const next = text + delta;
  return next.length > MAX_TRANSCRIPT_CHARS
    ? next.slice(next.length - MAX_TRANSCRIPT_CHARS)
    : next;
}

// Periodically drop expired login sessions (no-op when auth is off).
const sweepTimer = setInterval(() => {
  try {
    auth.sweep();
  } catch (err) {
    app.log.warn(err, 'session sweep failed');
  }
}, 6 * 60 * 60 * 1000);
sweepTimer.unref();

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
