import type { DatabaseSync } from "node:sqlite";

/** Append-only migration 7: migration 5 is approve-all, 6 indexes evidence. */
export function migratePipelines(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_pipelines (
      team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
      repo_root TEXT, graph TEXT, layout TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 0, layout_revision INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0, 1)), observed_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pipeline_runs_team ON pipeline_runs (team_id, created_at);
    CREATE TABLE IF NOT EXISTS pipeline_files (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      file TEXT NOT NULL, sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pipeline_requests (client_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pipeline_work_bindings (
      work_id TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE, round INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
      PRIMARY KEY (work_id, round)
    );
    CREATE TABLE IF NOT EXISTS pipeline_item_bindings (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL,
      PRIMARY KEY (item_id, revision)
    );
  `);
}
