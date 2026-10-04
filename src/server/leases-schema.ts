// The office-run capture lease's tables. Self-contained (no imports, only IF NOT EXISTS), so the
// migration that calls it can be renumbered freely when another migration lands first.
import type { DatabaseSync } from "node:sqlite";

export function migrateCaptureLeases(db: DatabaseSync): void {
  db.exec(`
    -- One row per repository (its Git common dir) and resource, held or free. The hold limit lives here too.
    CREATE TABLE IF NOT EXISTS capture_leases (
      repo TEXT NOT NULL, resource TEXT NOT NULL, root TEXT NOT NULL,
      hold_ms INTEGER,
      lease_id TEXT, holder_id TEXT, holder_name TEXT, run_id TEXT, run_team_id TEXT, reason TEXT,
      queued_at TEXT, granted_at TEXT, expires_at TEXT,
      PRIMARY KEY (repo, resource)
    );
    -- Who waits, in order (seq). An entry's lease id becomes the lease's id when it is granted.
    CREATE TABLE IF NOT EXISTS capture_lease_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, resource TEXT NOT NULL, lease_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, run_id TEXT, run_team_id TEXT, reason TEXT,
      joined_at TEXT NOT NULL,
      UNIQUE (repo, resource, agent_id)
    );
  `);
}
