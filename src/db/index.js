import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import { config } from '../config.js';
import * as schema from './schema.js';

// One small SQLite file holds login sessions. We create the table on startup
// with idempotent DDL — there's a single tiny table and no schema evolution, so
// a full drizzle-kit migration toolchain would be overkill for this playground.
mkdirSync(dirname(config.dbPath), { recursive: true });

const sqlite = new Database(config.dbPath);
sqlite.pragma('journal_mode = WAL'); // better concurrency for multiple clients

// Column names are snake_case to match the text('...') mappings in schema.js.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token        TEXT PRIMARY KEY,
    viewer_token TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_viewer_token ON sessions(viewer_token);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions(expires_at);
`);

export const db = drizzle(sqlite, { schema });
export { sqlite };
