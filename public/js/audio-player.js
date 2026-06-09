// Streams translated speech to the speakers.
//
// The server forwards base64-encoded 24 kHz mono PCM16 chunks
// (session.output_audio.delta). We decode each chunk into an AudioBuffer and
// schedule them back-to-back on a Web Audio timeline for gapless playback.
// A small cushion is added only after an underrun so continuous speech stays
// tight while a stall doesn't glitch.

const SAMPLE_RATE = 24000;
const UNDERRUN_CUSHION = 0.06; // seconds

export function createAudioPlayer() {
  let ctx = null;
  let enabled = false;
  let nextTime = 0;
  const active = new Set(); // scheduled sources, so we can stop them on disable

  function base64ToInt16(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // PCM16 little-endian; guard against an odd byte count.
    return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  }

  function stopAll() {
    for (const src of active) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    active.clear();
  }

  return {
    get enabled() {
      return enabled;
    },

    /** Must be called from a user gesture (button click) to satisfy autoplay. */
    async enable() {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
      await ctx.resume();
      enabled = true;
      nextTime = ctx.currentTime + UNDERRUN_CUSHION;
    },

    disable() {
      enabled = false;
      stopAll();
      if (ctx) ctx.suspend().catch(() => {});
    },

    /** Queue one base64 PCM16 chunk for playback (no-op when disabled). */
    push(b64) {
      if (!enabled || !ctx || !b64) return;
      const pcm = base64ToInt16(b64);
      if (!pcm.length) return;

      const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      let start = nextTime;
      if (start < ctx.currentTime) start = ctx.currentTime + UNDERRUN_CUSHION;
      src.start(start);
      nextTime = start + buffer.duration;

      active.add(src);
      src.onended = () => active.delete(src);
    },

    /** Drop anything queued (e.g. a new session started). */
    reset() {
      stopAll();
      if (ctx) nextTime = ctx.currentTime + UNDERRUN_CUSHION;
    },
  };
}
