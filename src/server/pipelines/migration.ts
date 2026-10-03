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

/**
 * Append-only migration 10: run history outlives its team. Migration 7 cascaded a team's
 * deletion (finishing, merging, or a checkout seen missing) into its runs, their files and
 * bindings. Runs keep their original team as provenance without a foreign key, and list in
 * `ledger_team_id`'s Runs (a merge moves that, never the provenance). Nothing cascades from a
 * run any more. SQLite cannot drop a foreign key in place, and dropping a parent table with
 * foreign keys on deletes its children, so the children are copied and dropped first.
 */
export function retainPipelineHistory(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE pipeline_runs_kept (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, ledger_team_id TEXT NOT NULL,
      snapshot TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO pipeline_runs_kept (id, team_id, ledger_team_id, snapshot, created_at)
      SELECT id, team_id, team_id, snapshot, created_at FROM pipeline_runs;
    CREATE TABLE pipeline_files_kept (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs_kept(id),
      file TEXT NOT NULL, sha256 TEXT NOT NULL
    );
    INSERT INTO pipeline_files_kept SELECT id, run_id, file, sha256 FROM pipeline_files;
    CREATE TABLE pipeline_work_bindings_kept (
      work_id TEXT NOT NULL REFERENCES work(id) ON DELETE CASCADE, round INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES pipeline_runs_kept(id), fingerprint TEXT NOT NULL,
      PRIMARY KEY (work_id, round)
    );
    INSERT INTO pipeline_work_bindings_kept SELECT work_id, round, run_id, fingerprint FROM pipeline_work_bindings;
    CREATE TABLE pipeline_item_bindings_kept (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
      run_id TEXT NOT NULL REFERENCES pipeline_runs_kept(id), fingerprint TEXT NOT NULL,
      PRIMARY KEY (item_id, revision)
    );
    INSERT INTO pipeline_item_bindings_kept SELECT item_id, revision, run_id, fingerprint FROM pipeline_item_bindings;
    DROP TABLE pipeline_files; DROP TABLE pipeline_work_bindings; DROP TABLE pipeline_item_bindings; DROP TABLE pipeline_runs;
    ALTER TABLE pipeline_runs_kept RENAME TO pipeline_runs;
    ALTER TABLE pipeline_files_kept RENAME TO pipeline_files;
    ALTER TABLE pipeline_work_bindings_kept RENAME TO pipeline_work_bindings;
    ALTER TABLE pipeline_item_bindings_kept RENAME TO pipeline_item_bindings;
    CREATE INDEX pipeline_runs_team ON pipeline_runs (team_id, created_at);
    CREATE INDEX pipeline_runs_ledger ON pipeline_runs (ledger_team_id, created_at);
  `);
}
