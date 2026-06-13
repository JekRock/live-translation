import crypto from 'node:crypto';

import { eq, lt } from 'drizzle-orm';

import { config } from './config.js';
import { db } from './db/index.js';
import { sessions } from './db/schema.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~1 month

// Auth is enabled only when BOTH credentials are configured. A half-set config
// (one var missing) leaves the app open rather than silently locking everyone
// out with an unusable login.
export function authEnabled() {
  return Boolean(config.authUsername && config.authPassword);
}

// Constant-time compare. Hashing first gives both sides a fixed length (so
// timingSafeEqual never throws) and avoids leaking length via timing.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function verifyCredentials(username, password) {
  // Evaluate both halves regardless of the first result — no early exit.
  const okUser = safeEqual(username, config.authUsername);
  const okPass = safeEqual(password, config.authPassword);
  return okUser && okPass;
}

// Issue a new login session and its read-only viewer token.
export function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const viewerToken = crypto.randomUUID();
  const now = Date.now();
  db.insert(sessions)
    .values({ token, viewerToken, createdAt: now, expiresAt: now + SESSION_TTL_MS })
    .run();
  return { token, viewerToken };
}

// Look up a live session by cookie token. Expired rows are treated as missing
// and deleted lazily.
export function getSession(token) {
  if (!token) return null;
  const [row] = db.select().from(sessions).where(eq(sessions.token, token)).all();
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
    return null;
  }
  return row;
}

// Validate a viewer link's ?token=<uuid> against any live session.
export function getSessionByViewerToken(viewerToken) {
  if (!viewerToken) return null;
  const [row] = db
    .select()
    .from(sessions)
    .where(eq(sessions.viewerToken, viewerToken))
    .all();
  if (!row || row.expiresAt < Date.now()) return null;
  return row;
}

export function deleteSession(token) {
  if (token) db.delete(sessions).where(eq(sessions.token, token)).run();
}

// Housekeeping: drop all expired sessions.
export function sweep() {
  db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
}
