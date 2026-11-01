// The page-comment queue's table (migration 18). Self-contained (no imports, only IF NOT EXISTS),
// like the capture lease's, so the migration that calls it can be renumbered if another lands first.
// Columns added after migration 18 are added when missing, by the migration on a new database and by
// PageComments on one that is already past it, so the numbered migrations do not grow for them.
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
  ensurePageCommentColumns(db);
}

/** kind, group, question/answer, edits, follow-up links and the founder's check: added when missing (SQLite has no ADD COLUMN IF NOT EXISTS). */
export function ensurePageCommentColumns(db: DatabaseSync): void {
  const have = new Set((db.prepare("PRAGMA table_info(page_comments)").all() as Array<{ name: string }>).map((c) => String(c.name)));
  if (!have.size) return;
  const columns: Array<[string, string]> = [
    ["kind", "TEXT"], ["group_id", "TEXT"], ["question", "TEXT"], ["answer", "TEXT"], ["revision", "INTEGER NOT NULL DEFAULT 0"],
    ["follows_up", "TEXT"], ["verification", "TEXT"], ["verified_at", "TEXT"],
  ];
  for (const [name, type] of columns) if (!have.has(name)) db.exec(`ALTER TABLE page_comments ADD COLUMN ${name} ${type}`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS page_comments_group ON page_comments (group_id);
    CREATE INDEX IF NOT EXISTS page_comments_follows ON page_comments (follows_up);
  `);
}
