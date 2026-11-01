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

/**
 * Capacity: how many agents may hold one lease at once (default 1, so nothing changes until a
 * lead sets it). Holders move out of the single holder columns of capture_leases into a table
 * of their own, one row per holder in grant order; the queue keeps its shape. Idempotent and
 * self-contained like the first migration, so it can be renumbered freely.
 */
export function migrateLeaseCapacity(db: DatabaseSync): void {
  const columns = (): string[] => db.prepare("PRAGMA table_info(capture_leases)").all().map((c) => String(c.name));
  if (!columns().includes("capacity")) db.exec("ALTER TABLE capture_leases ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1");
  db.exec(`
    -- Who holds a lease now, in grant order (seq). A holder's lease id is the one it had in the queue.
    CREATE TABLE IF NOT EXISTS capture_lease_holders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, resource TEXT NOT NULL, lease_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, agent_name TEXT NOT NULL, run_id TEXT, run_team_id TEXT, reason TEXT,
      queued_at TEXT, granted_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      UNIQUE (repo, resource, agent_id)
    );
  `);
  if (!columns().includes("holder_id")) return;
  db.exec(`INSERT OR IGNORE INTO capture_lease_holders (repo, resource, lease_id, agent_id, agent_name, run_id, run_team_id, reason, queued_at, granted_at, expires_at)
    SELECT repo, resource, lease_id, holder_id, COALESCE(holder_name, ''), run_id, run_team_id, reason, queued_at, COALESCE(granted_at, ''), COALESCE(expires_at, '')
    FROM capture_leases WHERE holder_id IS NOT NULL AND lease_id IS NOT NULL ORDER BY granted_at`);
  for (const column of ["lease_id", "holder_id", "holder_name", "run_id", "run_team_id", "reason", "queued_at", "granted_at", "expires_at"]) {
    db.exec(`ALTER TABLE capture_leases DROP COLUMN ${column}`);
  }
}
