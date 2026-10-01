// The office speaking to the founder, without an agent or a terminal delivery.
// Record inside the caller's transaction so a durable latch cannot outlive its notice.
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class OfficeNotices {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS office_notices (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),
      title TEXT NOT NULL,
      agent_ids TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    )`);
  }

  record(title: string, body: string, agentIds: string[], at: number): void {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO messages (id, kind, text, created_at, to_founder, from_office)
      VALUES (?, 'message', ?, ?, 1, 1)`).run(id, body, new Date(at).toISOString());
    this.db.prepare("INSERT INTO office_notices (message_id, title, agent_ids) VALUES (?, ?, ?)")
      .run(id, title, JSON.stringify(agentIds));
  }

  /** Best-effort desktop notification, once per committed notice; the founder's line is durable. */
  async dispatch(notify: ((title: string, body: string) => Promise<void>) | null): Promise<void> {
    if (!notify) return;
    const rows = this.db.prepare(`SELECT n.message_id, n.title, m.text FROM office_notices n
      JOIN messages m ON m.id = n.message_id WHERE n.notified = 0`).all() as Array<{ message_id: string; title: string; text: string }>;
    await Promise.all(rows.map(async (r) => {
      if (!this.db.prepare("UPDATE office_notices SET notified = 1 WHERE message_id = ? AND notified = 0").run(r.message_id).changes) return;
      try { await notify(r.title, r.text); } catch { /* The visible notice remains even if the desktop is unavailable. */ }
    }));
  }
}
