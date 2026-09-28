// The inbox's SQLite store (Node's built-in driver). It lives in the application's data
// directory, never in a project worktree, so switching or deleting a worktree keeps history.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  return process.env.INBOX_DATA_DIR ?? join(homedir(), ".review-inbox");
}

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

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'url', 'document')),
  file TEXT,
  url TEXT,
  sha256 TEXT,
  caption TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

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
  delivered_at TEXT
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

-- The office world: teams, and every agent it has seen, keyed by harness + checkout.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  structure TEXT NOT NULL CHECK (structure IN ('dispatch', 'circle')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_agents (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  first_seen_at TEXT NOT NULL
);

-- Your instructions to a team. The agents an order goes to are fixed when it is given (the
-- lead, or every running peer); each gets its own delivery row, sent once the agent is free.
CREATE TABLE IF NOT EXISTS team_orders (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  client_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_deliveries (
  order_id TEXT NOT NULL REFERENCES team_orders(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES world_agents(id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'delivered', 'failed')),
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (order_id, agent_id)
);

CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE INDEX IF NOT EXISTS replies_item ON replies (item_id, state);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id);
`;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(join(file, ".."), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}
