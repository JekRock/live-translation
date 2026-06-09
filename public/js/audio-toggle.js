// Wires a toggle button to an audio player. Clicking enables/disables playback
// of the translated speech; the button reflects state via an `audio-on` class
// (for icon swapping), `aria-pressed`, and an optional [data-audio-label].

export function wireAudioToggle(button, audio) {
  if (!button) return;

  const labelEl = button.querySelector('[data-audio-label]');
  const setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };

  const reflect = () => {
    button.classList.toggle('audio-on', audio.enabled);
    button.setAttribute('aria-pressed', String(audio.enabled));
    setLabel(audio.enabled ? 'Audio on' : 'Audio off');
  };

  button.addEventListener('click', async () => {
    if (audio.enabled) {
      audio.disable();
      reflect();
      return;
    }
    button.disabled = true;
    try {
      await audio.enable(); // user gesture -> satisfies autoplay policy
    } catch (err) {
      console.error('Could not enable audio:', err);
    } finally {
      button.disabled = false;
    }
    reflect();
  });

  reflect();
}
