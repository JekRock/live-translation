import WebSocket from 'ws';

const OPENAI_URL =
  process.env.OPENAI_REALTIME_URL ||
  'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';

/**
 * Opens a WebSocket session to the OpenAI Realtime Translation API and exposes
 * a tiny interface for streaming audio in and receiving transcript deltas out.
 *
 * The browser never talks to OpenAI directly — this runs server-side so the
 * API key stays private.
 *
 * @param {object} opts
 * @param {string} opts.apiKey            OpenAI API key.
 * @param {string} opts.language          Target language code (e.g. "en").
 * @param {string} [opts.inputTranscriptionModel] Transcription model to enable
 *        the original-language transcript. Falsy = leave input transcription off.
 * @param {string} [opts.safetyIdentifier] Optional hashed user id.
 * @param {() => void} [opts.onReady]      Called once the session is configured.
 * @param {(event: object) => void} [opts.onEvent] Every raw upstream event
 *        (for diagnostics/logging).
 * @param {(text: string) => void} [opts.onSource]      Source transcript delta.
 * @param {(text: string) => void} [opts.onTranslation] Translated text delta.
 * @param {(base64Pcm16: string) => void} [opts.onAudio] Translated audio delta
 *        (base64-encoded 24 kHz PCM16).
 * @param {(message: string) => void} [opts.onError]    Error message.
 * @param {() => void} [opts.onClose]      Upstream session closed/ended.
 */
export function connectTranslator({
  apiKey,
  language,
  inputTranscriptionModel,
  safetyIdentifier,
  onReady,
  onEvent,
  onSource,
  onTranslation,
  onAudio,
  onError,
  onClose,
}) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (safetyIdentifier) headers['OpenAI-Safety-Identifier'] = safetyIdentifier;

  const ws = new WebSocket(OPENAI_URL, { headers });
  let closed = false;

  ws.on('open', () => {
    const audio = { output: { language } };

    // Enabling input transcription (it defaults to null on the session) is what
    // makes the model emit session.input_transcript.delta — i.e. the original
    // language transcript. The docs don't pin down the transcription model, so
    // it's configurable; set INPUT_TRANSCRIPTION_MODEL='' to leave it off.
    if (inputTranscriptionModel) {
      audio.input = { transcription: { model: inputTranscriptionModel } };
    }

    ws.send(JSON.stringify({ type: 'session.update', session: { audio } }));
    onReady?.();
  });

  ws.on('message', (data) => {
    let evt;
    try {
      evt = JSON.parse(data.toString());
    } catch {
      return;
    }

    onEvent?.(evt);

    switch (evt.type) {
      case 'session.input_transcript.delta':
        if (evt.delta) onSource?.(evt.delta);
        break;
      case 'session.output_transcript.delta':
        if (evt.delta) onTranslation?.(evt.delta);
        break;
      case 'session.output_audio.delta':
        if (evt.delta) onAudio?.(evt.delta);
        break;
      case 'error':
      case 'session.error':
        onError?.(stringifyError(evt.error || evt));
        break;
      case 'session.closed':
        if (!closed) {
          closed = true;
          onClose?.();
        }
        break;
      default:
        break;
    }
  });

  ws.on('error', (err) => {
    onError?.(err?.message || String(err));
  });

  ws.on('close', () => {
    if (!closed) {
      closed = true;
      onClose?.();
    }
  });

  return {
    /** Append a chunk of base64-encoded 24 kHz PCM16 audio. */
    sendAudio(base64Pcm16) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'session.input_audio_buffer.append',
            audio: base64Pcm16,
          })
        );
      }
    },

    /** Politely end the session and let the server flush remaining output. */
    close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session.close' }));
        // Fallback: force-close if the server never sends session.closed.
        setTimeout(() => ws.terminate(), 3000).unref?.();
      } else {
        ws.terminate();
      }
    },

    /** Hard close immediately (e.g. the browser disconnected). */
    terminate() {
      ws.terminate();
    },
  };
}

function stringifyError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || error.type || JSON.stringify(error);
}
