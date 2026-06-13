import { createTranscript } from './transcript.js';

// Connects a read-only subtitle/transcript page to a broadcast WebSocket and
// renders incoming text into the scrollable transcript. Shared by the viewer
// (translated) and source (original-language) pages — they differ only in the
// socket path and whether they also handle audio.
//
// `onExtra(type, msg)` receives any message that isn't reset/sync/delta (e.g.
// 'audio'), plus 'reset' (after the transcript is cleared) so callers can hook
// in side effects.
export function connectSubtitleStream({ path, onExtra }) {
  const statusEl = document.getElementById('status');
  const transcript = createTranscript({
    container: document.getElementById('transcript'),
    button: document.getElementById('scroll-bottom'),
  });

  let ws = null;
  let reconnectTimer = null;

  function wsUrl(p) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}${p}`;
  }

  function connect() {
    // Forward the page's query string (e.g. ?token=<uuid>) onto the socket so
    // the server can authorize the stream when login is enabled.
    ws = new WebSocket(wsUrl(path + location.search));

    ws.onopen = () => {
      if (statusEl) statusEl.dataset.state = 'connected';
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'reset') {
        transcript.reset();
        onExtra?.('reset', msg);
      } else if (msg.type === 'sync') {
        transcript.setFull(msg.text);
      } else if (msg.type === 'delta') {
        transcript.append(msg.text);
      } else {
        onExtra?.(msg.type, msg);
      }
    };

    ws.onclose = () => {
      if (statusEl) statusEl.dataset.state = 'disconnected';
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    };

    ws.onerror = () => ws.close();
  }

  connect();
  return { transcript };
}
