// AudioWorkletProcessor that converts microphone audio to 24 kHz mono PCM16
// and posts it back to the main thread in ~100 ms chunks.
//
// The microphone is usually delivered at 44.1 or 48 kHz, so we resample to the
// 24 kHz that the OpenAI Realtime Translation API expects using simple linear
// interpolation, block by block.
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target =
      (options.processorOptions && options.processorOptions.targetSampleRate) ||
      24000;
    this.inRate = sampleRate; // AudioWorkletGlobalScope: the context sample rate
    this.targetRate = target;
    this.ratio = this.inRate / this.targetRate;
    // Process ~100 ms of input audio at a time.
    this.blockSize = Math.max(1, Math.round(this.inRate * 0.1));
    this.buffer = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    // Append the new frame to our running buffer.
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer, 0);
    merged.set(input, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= this.blockSize) {
      const block = this.buffer.subarray(0, this.blockSize);
      const outLen = Math.max(1, Math.floor(this.blockSize / this.ratio));
      const pcm = new Int16Array(outLen);

      for (let i = 0; i < outLen; i++) {
        const srcPos = i * this.ratio;
        const idx = Math.floor(srcPos);
        const frac = srcPos - idx;
        const a = block[idx];
        const b = idx + 1 < block.length ? block[idx + 1] : a;
        let sample = a + (b - a) * frac;
        sample = Math.max(-1, Math.min(1, sample));
        pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      // Transfer the buffer to avoid a copy.
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.buffer = this.buffer.slice(this.blockSize);
    }

    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
