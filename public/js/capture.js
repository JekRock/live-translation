import { createTranscript } from './transcript.js';
import { createAudioPlayer } from './audio-player.js';
import { wireAudioToggle } from './audio-toggle.js';

const TARGET_SAMPLE_RATE = 24000;

const els = {
  toggle: document.getElementById('toggle'),
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

let ws = null;
let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let sourceNode = null;
let running = false;

function setStatus(text, mode) {
  els.status.textContent = text;
  els.dot.dataset.mode = mode || 'idle';
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

async function start() {
  if (running) return;
  running = true;
  els.toggle.disabled = true;
  transcript.reset();
  setStatus('Requesting microphone…', 'connecting');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch (err) {
    setStatus(`Microphone error: ${err.message}`, 'error');
    running = false;
    els.toggle.disabled = false;
    return;
  }

  setStatus('Connecting…', 'connecting');
  ws = new WebSocket(wsUrl('/ws'));
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => ws.send(JSON.stringify({ type: 'start' }));
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  };
  ws.onerror = () => setStatus('Connection error', 'error');
  ws.onclose = () => {
    if (running) stop();
  };
}

async function beginAudio() {
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

  els.toggle.disabled = false;
  els.toggle.textContent = 'Stop listening';
  setStatus('Listening — speak Ukrainian', 'live');
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'ready':
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
      setStatus(`Error: ${msg.message}`, 'error');
      break;
    case 'stopped':
      break;
    default:
      break;
  }
}

function stop() {
  running = false;
  els.toggle.textContent = 'Start listening';
  els.toggle.disabled = false;
  setStatus('Stopped', 'idle');

  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  } catch {
    /* ignore */
  }

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
  if (ws) {
    const socket = ws;
    ws = null;
    setTimeout(() => socket.close(), 250);
  }
}

els.toggle.addEventListener('click', () => {
  if (running) stop();
  else start();
});

setStatus('Idle', 'idle');
