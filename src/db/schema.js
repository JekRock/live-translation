import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Login sessions. One row per successful login; lives for ~1 month.
//   token       — the random value stored in the `session` cookie.
//   viewerToken — a UUID handed out for read-only /viewer & /source links.
//   createdAt / expiresAt — epoch milliseconds (Date.now()).
export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  viewerToken: text('viewer_token').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
