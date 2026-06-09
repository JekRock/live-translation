import { connectSubtitleStream } from './subtitle-stream.js';

// Original-language (Ukrainian) transcript mirror. Same look and behaviour as
// the viewer page, just pointed at the source stream and without audio.
connectSubtitleStream({ path: '/ws/source' });
