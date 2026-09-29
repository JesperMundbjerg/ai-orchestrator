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

test("items from before walkthroughs gain a pages column and keep their preview", () => {
  const file = join(mkdtempSync(join(tmpdir(), "inbox-db-")), "inbox.db");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL, revision INTEGER NOT NULL,
      title TEXT NOT NULL, request TEXT NOT NULL, context TEXT NOT NULL, recommendation TEXT NOT NULL, options TEXT NOT NULL,
      check_text TEXT NOT NULL, preview TEXT, blocking INTEGER NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL,
      snoozed_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (task_id, key));
    INSERT INTO items VALUES ('i1', 't1', 'k', 'try', 1, 'Try it', '', '', '', '[]', '', '{"url":"http://127.0.0.1:3000/","viewport":null,"setup":""}', 0, 'h', 'needs_attention', NULL, 'x', 'x');
  `);
  old.close();
  const db = openDatabase(file);
  assert.deepEqual({ ...db.prepare("SELECT preview IS NOT NULL AS preview, pages FROM items").get() }, { preview: 1, pages: null });
  db.close();
});
