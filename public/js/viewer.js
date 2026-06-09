import { connectSubtitleStream } from './subtitle-stream.js';
import { createAudioPlayer } from './audio-player.js';
import { wireAudioToggle } from './audio-toggle.js';

const audio = createAudioPlayer();
wireAudioToggle(document.getElementById('audio-toggle'), audio);

connectSubtitleStream({
  path: '/ws/viewer',
  onExtra: (type, msg) => {
    if (type === 'audio') audio.push(msg.data);
    else if (type === 'reset') audio.reset();
  },
});
