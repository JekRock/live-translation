import { appendFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Persists the live transcripts to disk: one file per day per stream, e.g.
//   transcripts/2026-06-09-source.txt        (original Ukrainian)
//   transcripts/2026-06-09-translation.txt   (English translation)
//
// Files are only ever appended to (never deleted/overwritten). Each session
// start writes a timestamp marker, separated from any previous content by a
// blank line, so a day's file can hold many sessions in order.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TRANSCRIPT_DIR = process.env.TRANSCRIPT_DIR
  ? resolve(process.env.TRANSCRIPT_DIR)
  : join(__dirname, '..', 'transcripts');

// Logger is injected by the server (pino); falls back to console until then.
let logger = console;
export function setLogger(l) {
  logger = l;
}

// Serialize every write through one chain so order is preserved and the two
// streams never interleave a partial write.
let queue = Promise.resolve();
let dirReady = null;

function ensureDir() {
  if (!dirReady) dirReady = mkdir(TRANSCRIPT_DIR, { recursive: true });
  return dirReady;
}

function enqueue(task) {
  queue = queue
    .then(ensureDir)
    .then(task)
    .catch((err) => logger.error(`[transcripts] write failed: ${err.message}`));
  return queue;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp() {
  const d = new Date();
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { date, time };
}

function fileFor(kind, date) {
  return join(TRANSCRIPT_DIR, `${date}-${kind}.txt`);
}

async function writeMarker(kind, date, time) {
  const filePath = fileFor(kind, date);
  let exists = true;
  try {
    await stat(filePath);
  } catch {
    exists = false;
  }
  const header = `===== Session started ${date} ${time} =====\n`;
  // Separate from previous content with a blank line, but don't lead a brand
  // new file with empty lines.
  await appendFile(filePath, exists ? `\n\n${header}` : header);
}

/** Write a timestamped session marker to both day files. */
export function startSession() {
  const { date, time } = stamp();
  enqueue(() => writeMarker('source', date, time));
  enqueue(() => writeMarker('translation', date, time));
}

/** Append a chunk of the original-language transcript. */
export function appendSource(text) {
  if (!text) return;
  const { date } = stamp();
  enqueue(() => appendFile(fileFor('source', date), text));
}

/** Append a chunk of the translated transcript. */
export function appendTranslation(text) {
  if (!text) return;
  const { date } = stamp();
  enqueue(() => appendFile(fileFor('translation', date), text));
}
