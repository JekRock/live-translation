// Append-only, scrollable transcript with smart autoscroll.
//
// - New text is appended as plain text nodes (no re-render of existing text, so
//   nothing blinks).
// - While the user is at the bottom, it autoscrolls to follow new text.
// - If the user scrolls up, autoscroll pauses and a "scroll to latest" button
//   appears. Scrolling back to the bottom (or clicking the button) re-pins it.

// How close to the bottom (px) still counts as "at the bottom".
const BOTTOM_THRESHOLD = 48;

export function createTranscript({ container, button }) {
  let pinned = true;
  let rafId = 0;

  const atBottom = () =>
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    BOTTOM_THRESHOLD;

  const reflectButton = () => {
    button.classList.toggle('visible', !pinned);
  };

  const jumpToBottom = () => {
    container.scrollTop = container.scrollHeight;
  };

  // Coalesce multiple deltas per frame into a single scroll to avoid thrashing.
  const scheduleScroll = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (pinned) jumpToBottom();
    });
  };

  container.addEventListener(
    'scroll',
    () => {
      pinned = atBottom();
      reflectButton();
    },
    { passive: true }
  );

  button.addEventListener('click', () => {
    pinned = true;
    jumpToBottom();
    reflectButton();
  });

  return {
    /** Append incoming translated text. */
    append(text) {
      if (!text) return;
      container.appendChild(document.createTextNode(text));
      scheduleScroll();
    },
    /** Replace the whole transcript (used to sync a late joiner). */
    setFull(text) {
      container.textContent = text || '';
      pinned = true;
      reflectButton();
      scheduleScroll();
    },
    /** Clear everything (new session). */
    reset() {
      container.textContent = '';
      pinned = true;
      reflectButton();
    },
  };
}
