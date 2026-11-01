import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";

// A database from before the removed QA agent feature: its schema at user_version 16, rebuilt by hand
// on today's schema, since every migration before the removal still runs and only the last one drops it.
const presence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const session = { harness: "manual" as const, sessionId: "automation-owner" };
const LAST_BEFORE_REMOVAL = 16;

function oldDatabase(t: TestContext, mode: "off" | "approve_all" | "qa") {
  const dir = mkdtempSync(join(tmpdir(), "automation-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "inbox.sqlite");
  const db = openDatabase(file);
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const delivered = inbox.submit({ session, item: { type: "decide", title: "Docked or overlay?", options: ["Docked", "Overlay"] } }).itemId;
  const queued = inbox.submit({ session, item: { type: "decide", title: "Wide or narrow?", options: ["Wide", "Narrow"] } }).itemId;
  const founder = inbox.submit({ session, item: { type: "milestone", title: "Ready" } }).itemId;
  restoreOldSchema(db, mode);
  // An automatic answer the agent already has, one still waiting to be sent, and the founder's own.
  automaticAnswer(db, inbox, delivered, "a");
  inbox.acknowledge(session, `auto:${delivered}:1`);
  automaticAnswer(db, inbox, queued, "b");
  inbox.answer(founder, { id: "founder-answer", revision: 1, action: "accept" });
  db.prepare("INSERT INTO qa_predictions VALUES (?, 1, 'agent', 'accept', NULL, '', 'why', '[]', '2026-10-01T00:00:00Z', NULL, NULL)").run(founder);
  const counts = rowCounts(db);
  db.exec(`PRAGMA user_version = ${LAST_BEFORE_REMOVAL}`);
  db.close();
  return { dir, file, delivered, queued, founder, counts };
}

function restoreOldSchema(db: DatabaseSync, mode: string): void {
  db.exec(`ALTER TABLE auto_approve ADD COLUMN mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'approve_all', 'qa'));
    ALTER TABLE auto_approve ADD COLUMN qa_agent_id TEXT;
    ALTER TABLE auto_approve ADD COLUMN qa_learned_through INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE auto_approve ADD COLUMN qa_started TEXT;
    ALTER TABLE replies ADD COLUMN answered_by TEXT CHECK (answered_by IN ('approve_all', 'qa_agent', 'qa_override'));
    CREATE TABLE qa_predictions (
      item_id TEXT NOT NULL REFERENCES items(id), revision INTEGER NOT NULL, agent_id TEXT NOT NULL,
      action TEXT NOT NULL, choice TEXT, text TEXT NOT NULL, reason TEXT NOT NULL, learnings TEXT NOT NULL, at TEXT NOT NULL,
      judged TEXT, judged_at TEXT, PRIMARY KEY (item_id, revision)
    );`);
  db.prepare("UPDATE auto_approve SET mode = ?, enabled = ?, qa_agent_id = 'agent', qa_learned_through = 7 WHERE singleton = 1").run(mode, mode === "approve_all" ? 1 : 0);
}

/** What the removed feature wrote: an ordinary reply marked as its own, and a system event naming the agent. */
function automaticAnswer(db: DatabaseSync, inbox: Inbox, itemId: string, choice: string): void {
  db.exec("BEGIN");
  db.prepare("INSERT INTO replies (id, item_id, revision, action, choice, text, state, created_at, answered_by) VALUES (?, ?, 1, 'choose', ?, '', 'queued', '2026-10-01T00:00:00Z', 'qa_agent')")
    .run(`auto:${itemId}:1`, itemId, choice);
  db.prepare("UPDATE items SET state = 'answer_queued' WHERE id = ?").run(itemId);
  const taskId = inbox.detail(itemId).item.taskId;
  db.prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES ('2026-10-01T00:00:00Z', 'system', ?, ?, 'reply.queued', ?)")
    .run(taskId, itemId, JSON.stringify({ deliveryId: `auto:${itemId}:1`, action: "choose", choice, qaAgent: { id: "agent", name: "Bhavna" } }));
  db.exec("COMMIT");
}

function rowCounts(db: DatabaseSync) {
  const n = (table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  return { replies: n("replies"), items: n("items"), events: n("events") };
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
}

test("a database that answered with the removed QA agent comes out Off, without its tables, keeping every row", (t) => {
  const old = oldDatabase(t, "qa");
  const db = openDatabase(old.file);
  t.after(() => db.close());
  assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), LAST_BEFORE_REMOVAL + 1);
  assert.deepEqual(rowCounts(db), old.counts, "replies, items and events are all kept");
  assert.deepEqual(columns(db, "auto_approve"), ["singleton", "enabled"]);
  assert.ok(!columns(db, "replies").includes("answered_by"));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'qa_predictions'").get(), undefined);
  const inbox = new Inbox(db, join(old.dir, "files"), presence);
  assert.deepEqual(new AutoApprove(db, inbox).state(), { enabled: false, count: 0 });

  // Already delivered: kept as it was, and its history still shows it was not the founder's answer.
  const delivered = inbox.detail(old.delivered);
  assert.equal(delivered.replies[0]!.state, "delivered");
  assert.equal(delivered.history.find((h) => h.kind === "reply.queued")!.actor, "system");
  // Never sent as the founder's own: the waiting automatic answer is stale and the founder answers the item.
  const queued = inbox.detail(old.queued);
  assert.equal(queued.replies[0]!.state, "stale");
  assert.equal(queued.item.state, "needs_attention");
  assert.deepEqual(inbox.pendingReplies(session, "pull").map((r) => r.deliveryId), ["founder-answer"]);
  // The founder's own answer is untouched.
  assert.equal(inbox.detail(old.founder).replies[0]!.state, "queued");
  assert.equal(inbox.detail(old.founder).history.find((h) => h.kind === "reply.queued")!.actor, "user");
});

test("Approve all that was on before the removal stays on, and Off stays off", (t) => {
  for (const [mode, enabled] of [["approve_all", true], ["off", false]] as const) {
    const old = oldDatabase(t, mode);
    const db = openDatabase(old.file);
    t.after(() => db.close());
    const inbox = new Inbox(db, join(old.dir, "files"), presence);
    assert.equal(new AutoApprove(db, inbox).state().enabled, enabled, mode);
  }
});
