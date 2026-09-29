import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";

test("team instructions from before agents could talk are kept as messages", () => {
  const file = join(mkdtempSync(join(tmpdir(), "inbox-db-")), "inbox.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, structure TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE world_agents (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, name TEXT NOT NULL, team_id TEXT, role TEXT NOT NULL DEFAULT 'member', first_seen_at TEXT NOT NULL);
    CREATE TABLE team_orders (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE order_deliveries (order_id TEXT NOT NULL, agent_id TEXT NOT NULL, state TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (order_id, agent_id));
    INSERT INTO teams VALUES ('t1', 'Mission Control', 'dispatch', '2026-09-27T10:00:00Z');
    INSERT INTO world_agents VALUES ('a1', 'pi:/lead', 'Alma', 't1', 'lead', '2026-09-27T10:00:00Z');
    INSERT INTO team_orders VALUES ('o1', 't1', 'Ship the login page', 'c1', '2026-09-27T11:00:00Z');
    INSERT INTO order_deliveries VALUES ('o1', 'a1', 'delivered', NULL, '2026-09-27T11:00:05Z');
  `);
  old.close();

  const db = openDatabase(file);
  assert.deepEqual({ ...db.prepare("SELECT id, kind, team_id, text, client_id FROM messages").get() }, { id: "o1", kind: "instruction", team_id: "t1", text: "Ship the login page", client_id: "c1" });
  assert.deepEqual({ ...db.prepare("SELECT message_id, agent_id, state FROM message_deliveries").get() }, { message_id: "o1", agent_id: "a1", state: "delivered" });
  // A hand-formed team from before projects carries on as a standing team.
  assert.deepEqual({ ...db.prepare("SELECT * FROM teams").get() }, { id: "t1", name: "Mission Control", created_at: "2026-09-27T10:00:00Z", purpose: "", hands_to: null, path: null, branch: null, standing: 1 });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'team_orders'").get(), undefined);
  db.close();
  openDatabase(file).close();
});
