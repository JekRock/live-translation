import { createTranscript } from './transcript.js';
import { createAudioPlayer } from './audio-player.js';
import { wireAudioToggle } from './audio-toggle.js';

const TARGET_SAMPLE_RATE = 24000;

const els = {
  toggle: document.getElementById('toggle'),
  takeover: document.getElementById('takeover'),
  logout: document.getElementById('logout'),
  status: document.getElementById('status'),
  dot: document.getElementById('status-dot'),
  transcript: document.getElementById('transcript'),
  scrollBtn: document.getElementById('scroll-bottom'),
  audioToggle: document.getElementById('audio-toggle'),
};

const transcript = createTranscript({
  container: els.transcript,
  button: els.scrollBtn,
});

const audio = createAudioPlayer();
wireAudioToggle(els.audioToggle, audio);

// Persistent control socket (opened on load, auto-reconnecting). The mic chain
// is separate and only runs while this client is the speaker.
let ws = null;
let reconnectTimer = null;

// Mic chain — built only when we become the speaker.
let mediaStream = null;
let audioCtx = null;
let workletNode = null;
let sourceNode = null;
let micActive = false;

// Shared session state, driven by the server's `status` messages.
let running = false; // is a translation live anywhere?
let isSpeaker = false; // are we the one streaming audio?
let starting = false; // local: awaiting `ready` after we asked to start

function setStatus(text, mode) {
  els.status.textContent = text;
  els.dot.dataset.mode = mode || 'idle';
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

// ---------------------------------------------------------------------------
// Control socket
// ---------------------------------------------------------------------------
function connect() {
  ws = new WebSocket(wsUrl('/ws'));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => setStatus('Connecting…', 'connecting');
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };
  ws.onerror = () => {
    /* surfaced via onclose */
  };
  ws.onclose = () => {
    // Lost the control channel: any session we were driving is gone server-side.
    stopMic();
    running = false;
    isSpeaker = false;
    starting = false;
    renderControls();
    setStatus('Reconnecting…', 'connecting');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  };
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'status':
      applyStatus(msg);
      break;
    case 'ready':
      // We're the speaker — bring the mic up.
      beginAudio().catch((err) => setStatus(`Audio error: ${err.message}`, 'error'));
      break;
    case 'sync':
      transcript.setFull(msg.text);
      break;
    case 'delta':
      transcript.append(msg.text);
      break;
    case 'audio':
      audio.push(msg.data);
      break;
    case 'reset':
      transcript.reset();
      audio.reset();
      break;
    case 'error':
      starting = false;
      setStatus(`Error: ${msg.message}`, 'error');
      renderControls();
      break;
    case 'stopped':
      stopMic();
      break;
    default:
      break;
  }
}

function applyStatus({ running: r, isSpeaker: s }) {
  running = Boolean(r);
  isSpeaker = Boolean(s);

  if (!running) {
    if (micActive) stopMic();
    starting = false;
    setStatus('Idle', 'idle');
  } else if (isSpeaker) {
    if (micActive) setStatus('Listening — speak Ukrainian', 'live');
    else setStatus('Starting…', 'connecting'); // awaiting `ready`
  } else {
    // A session is live but another client owns the mic.
    if (micActive) stopMic(); // we were taken over
    starting = false;
    setStatus('Live — streaming from another device', 'live');
  }
  renderControls();
}

function renderControls() {
  els.toggle.textContent = running ? 'Stop' : 'Start listening';
  els.toggle.disabled = starting;
  // "Take over" only when a session is live and we're not the one streaming.
  els.takeover.hidden = !(running && !isSpeaker);
  els.takeover.disabled = starting;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function startSpeaking() {
  if (isSpeaker || starting) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Not connected — reconnecting…', 'error');
    return;
  }

  starting = true;
  renderControls();
  setStatus('Requesting microphone…', 'connecting');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    starting = false;
    renderControls();
    setStatus(`Microphone error: ${err.message}`, 'error');
    return;
  }

  setStatus('Connecting…', 'connecting');
  // Become the speaker (taking over any current session). The mic starts when
  // the server replies with `ready`.
  ws.send(JSON.stringify({ type: 'start' }));
}

function stopSession() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'stop' }));
}

async function beginAudio() {
  if (!mediaStream) return; // not the speaker / mic not granted
  if (micActive) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule('/js/pcm-worklet.js');

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-worklet', {
    processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE },
  });

  workletNode.port.onmessage = (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(event.data); // ArrayBuffer of PCM16 -> binary frame
    }
  };

  sourceNode.connect(workletNode);
  // The worklet emits no audio; connecting to destination keeps the graph live
  // in some browsers without producing sound.
  workletNode.connect(audioCtx.destination);

  micActive = true;
  starting = false;
  setStatus('Listening — speak Ukrainian', 'live');
  renderControls();
}

function stopMic() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  micActive = false;
}

// ---------------------------------------------------------------------------
// Auth-aware UI: viewer links carry the session's viewer token; show logout.
// ---------------------------------------------------------------------------
async function setupAuthUI() {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return;
    const { authEnabled, viewerToken } = await res.json();
    if (!authEnabled || !viewerToken) return;

    const q = `?token=${encodeURIComponent(viewerToken)}`;
    document.querySelectorAll('a[href="/viewer"]').forEach((a) => {
      a.href = `/viewer${q}`;
    });
    document.querySelectorAll('a[href="/source"]').forEach((a) => {
      a.href = `/source${q}`;
    });
    if (els.logout) els.logout.hidden = false;
  } catch {
    /* ignore — links stay as plain paths */
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------
els.toggle.addEventListener('click', () => {
  if (running) stopSession();
  else startSpeaking();
});

els.takeover.addEventListener('click', () => startSpeaking());

els.logout?.addEventListener('click', async () => {
  try {
    await fetch('/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  window.location = '/login';
});

setStatus('Connecting…', 'connecting');
renderControls();
setupAuthUI();
connect();
