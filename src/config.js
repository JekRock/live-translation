import 'dotenv/config';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  apiKey: process.env.OPENAI_API_KEY || '',
  targetLanguage: process.env.TARGET_LANGUAGE || 'en',
  // Enables the original-language transcript (session.input_transcript.delta).
  // Set to an empty string to turn the /source transcript off.
  inputTranscriptionModel:
    process.env.INPUT_TRANSCRIPTION_MODEL ?? 'gpt-4o-transcribe',
  safetyIdentifier: process.env.OPENAI_SAFETY_IDENTIFIER || '',
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '127.0.0.1',
  logLevel: process.env.LOG_LEVEL || 'info',
  // Single, always-appended log file (no rotation).
  logFile: process.env.LOG_FILE
    ? resolve(process.env.LOG_FILE)
    : join(__dirname, '..', 'logs', 'app.log'),

  // Optional login for the capture/control page. BOTH must be set (non-empty)
  // to enable auth; if either is missing, the app stays fully open.
  authUsername: process.env.AUTH_USERNAME || '',
  authPassword: process.env.AUTH_PASSWORD || '',
  // SQLite database that stores login sessions (only used when auth is enabled).
  dbPath: process.env.DB_PATH
    ? resolve(process.env.DB_PATH)
    : join(__dirname, '..', 'data', 'app.db'),
  // Mark the session cookie Secure. Required behind HTTPS; must stay false on
  // plain-HTTP localhost or the browser silently drops the cookie.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
};
