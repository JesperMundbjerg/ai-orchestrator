// The inbox's SQLite store (Node's built-in driver). It lives in the application's data
// directory, never in a project worktree, so switching or deleting a worktree keeps history.

import { DatabaseSync } from "node:sqlite";
import { migrateUnpresented } from "./unpresented.ts";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.INBOX_DATA_DIR ?? join(homedir(), ".review-inbox");
}

const EVIDENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'url', 'document')),
  file TEXT,
  url TEXT,
  sha256 TEXT,
  caption TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root TEXT UNIQUE,
  objective TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  activity TEXT NOT NULL DEFAULT '',
  next_milestone TEXT NOT NULL DEFAULT '',
  last_decision TEXT NOT NULL DEFAULT '',
  last_accepted_milestone TEXT NOT NULL DEFAULT '',
  parked INTEGER NOT NULL DEFAULT 0,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  -- How replies were last collected for this session; capabilities are learned from these.
  listener_seen_at TEXT,
  boundary_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (harness, session_id)
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  key TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('decide', 'try', 'milestone')),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  request TEXT NOT NULL,
  context TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  options TEXT NOT NULL,
  check_text TEXT NOT NULL,
  preview TEXT,
  pages TEXT,
  blocking INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('needs_attention', 'answer_queued', 'delivered', 'resolved', 'snoozed', 'withdrawn')),
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (task_id, key)
);

CREATE TABLE IF NOT EXISTS item_revisions (
  item_id TEXT NOT NULL REFERENCES items(id),
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, revision)
);

${EVIDENCE_SCHEMA}

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  choice TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'failed', 'stale')),
  error TEXT,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  -- Images you attached (upload ids, JSON), handed to the agent as file paths.
  images TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  task_id TEXT,
  item_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- The office world: a team per project (its worktree) or standing, and every agent it has
-- seen, keyed by harness + checkout.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  hands_to TEXT REFERENCES teams(id) ON DELETE SET NULL,
  path TEXT UNIQUE,
  branch TEXT,
  standing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- The herdr pane a project's first mate was started in: whoever runs there is its lead.
  lead_pane TEXT
);

-- Worktrees a team owns besides its own (its lanes), such as Mission Control's crew checkouts:
-- an agent working in one is on that team, and finishing the team never removes one.
CREATE TABLE IF NOT EXISTS team_worktrees (
  path TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL
);

-- Panes an agent on a team opened with inbox pane for its crew: whoever first runs in one and is
-- placed nowhere joins that team as a member. The record goes once used, or when it is stale.
CREATE TABLE IF NOT EXISTS pane_teams (
  pane_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_agents (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  first_seen_at TEXT NOT NULL,
  -- Latest observation, for recycling an offline, unplaced agent's first name.
  last_seen_at TEXT,
  -- When it was first seen running in herdr; null for a record nothing ever ran behind.
  ran_at TEXT,
  -- Removed by you while nothing ran behind it; kept so what it said still has a sender.
  removed INTEGER NOT NULL DEFAULT 0
);

-- Everything said in the office: your instructions, agents' messages to each other, handoffs
-- and review verdicts. Who a message goes to is fixed when it is sent; each of them gets a
-- delivery row, typed into their terminal once they are free. Nothing is deleted.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'message', 'handoff', 'review')),
  from_agent_id TEXT REFERENCES world_agents(id),
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  work_id TEXT REFERENCES work(id),
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  -- An agent's answer to the founder: shown in the office, typed into nobody's terminal.
  to_founder INTEGER NOT NULL DEFAULT 0,
  -- Images you attached (upload ids, JSON), typed to the agent as file paths.
  images TEXT,
  -- Said by the office itself, such as a browser left running: no sender, and not yours.
  from_office INTEGER NOT NULL DEFAULT 0,
  all_leads INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id TEXT NOT NULL REFERENCES messages(id),
  agent_id TEXT NOT NULL REFERENCES world_agents(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'delivered', 'failed')),
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);

-- Finished work handed from one team to another for review.
CREATE TABLE IF NOT EXISTS work (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  from_agent_id TEXT NOT NULL REFERENCES world_agents(id),
  from_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  -- Kept when that team is disbanded later, so the record still says where the work went.
  to_team_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_review', 'accepted', 'changes_requested')),
  round INTEGER NOT NULL DEFAULT 1,
  reviewer_id TEXT REFERENCES world_agents(id),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS deliveries_state ON message_deliveries (state);
CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE INDEX IF NOT EXISTS replies_item ON replies (item_id, state);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id);
`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  migrate(db);
  migrateUnpresented(db);
  return db;
}

/** Brings a database made by an earlier version up to the schema above. Each step is idempotent. */
function migrate(db: DatabaseSync): void {
  // SQLite cannot widen a CHECK constraint in place. Keep ids and rowids (evidence order)
  // when rebuilding, so old attachment URLs and revisions remain exactly the same.
  const evidenceSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'evidence'").get() as { sql: string };
  if (!evidenceSchema.sql.includes("'video'")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE evidence RENAME TO evidence_before_video;
        ${EVIDENCE_SCHEMA}
        INSERT INTO evidence (rowid, id, item_id, revision, kind, file, url, sha256, caption, source_revision, captured_at)
          SELECT rowid, id, item_id, revision, kind, file, url, sha256, caption, source_revision, captured_at FROM evidence_before_video;
        DROP TABLE evidence_before_video;
      `);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  const teams = columns("teams");
  if (!teams.has("purpose")) db.exec("ALTER TABLE teams ADD COLUMN purpose TEXT NOT NULL DEFAULT ''");
  if (!teams.has("lead_pane")) db.exec("ALTER TABLE teams ADD COLUMN lead_pane TEXT");
  if (!teams.has("hands_to")) db.exec("ALTER TABLE teams ADD COLUMN hands_to TEXT REFERENCES teams(id) ON DELETE SET NULL");
  // Teams were formed by hand, as a lead with crew or as peers, before a team was a project's
  // worktree. Those teams had no worktree, so they carry on as standing teams, all with a lead.
  if (teams.has("structure")) {
    db.exec(`
      ALTER TABLE teams ADD COLUMN path TEXT;
      ALTER TABLE teams ADD COLUMN branch TEXT;
      ALTER TABLE teams ADD COLUMN standing INTEGER NOT NULL DEFAULT 0;
      UPDATE teams SET standing = 1;
      ALTER TABLE teams DROP COLUMN structure;
      CREATE UNIQUE INDEX IF NOT EXISTS teams_path ON teams (path);
    `);
  }

  const messages = columns("messages");
  if (!messages.has("to_founder")) db.exec("ALTER TABLE messages ADD COLUMN to_founder INTEGER NOT NULL DEFAULT 0");
  if (!messages.has("images")) db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
  if (!messages.has("from_office")) db.exec("ALTER TABLE messages ADD COLUMN from_office INTEGER NOT NULL DEFAULT 0");
  if (!messages.has("all_leads")) db.exec("ALTER TABLE messages ADD COLUMN all_leads INTEGER NOT NULL DEFAULT 0");
  if (!columns("replies").has("images")) db.exec("ALTER TABLE replies ADD COLUMN images TEXT");
  // An item's walkthrough of pages; before it, an item had one preview, which reads as a one-page walkthrough.
  const agents = columns("world_agents");
  if (!agents.has("story")) db.exec("ALTER TABLE world_agents ADD COLUMN story TEXT");
  if (!agents.has("ran_at")) db.exec("ALTER TABLE world_agents ADD COLUMN ran_at TEXT");
  if (!agents.has("removed")) db.exec("ALTER TABLE world_agents ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
  if (!agents.has("last_seen_at")) {
    // We did not track last sighting before this. Give existing records a full three-day grace period.
    db.exec("ALTER TABLE world_agents ADD COLUMN last_seen_at TEXT");
    db.prepare("UPDATE world_agents SET last_seen_at = ?").run(new Date().toISOString());
  }
  if (!columns("items").has("pages")) db.exec("ALTER TABLE items ADD COLUMN pages TEXT");

  // Team instructions were their own tables before agents could talk to each other.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_orders'").get()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        INSERT OR IGNORE INTO messages (id, kind, from_agent_id, team_id, text, work_id, client_id, created_at)
          SELECT id, 'instruction', NULL, team_id, text, NULL, client_id, created_at FROM team_orders ORDER BY rowid;
        INSERT OR IGNORE INTO message_deliveries (message_id, agent_id, state, error, updated_at)
          SELECT order_id, agent_id, state, error, updated_at FROM order_deliveries;
        DROP TABLE order_deliveries;
        DROP TABLE team_orders;
      `);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
