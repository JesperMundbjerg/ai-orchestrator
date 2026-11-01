// The page-comment queue's table (migration 18). Self-contained (no imports, only IF NOT EXISTS),
// like the capture lease's, so the migration that calls it can be renumbered if another lands first.
import type { DatabaseSync } from "node:sqlite";

/** One row per comment: what the page sent, where it stands, and the message that carried it. */
export function migratePageComments(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_comments (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      text TEXT NOT NULL,
      page TEXT NOT NULL,
      origin TEXT,
      open_url TEXT,
      fixed_url TEXT,
      meta TEXT,
      images TEXT,
      status TEXT NOT NULL,
      note TEXT,
      commit_sha TEXT,
      by_name TEXT,
      message_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      client_id TEXT UNIQUE,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS page_comments_team ON page_comments (team_id, created_at);
    CREATE INDEX IF NOT EXISTS page_comments_open ON page_comments (status);
  `);
}
