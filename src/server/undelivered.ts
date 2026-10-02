// Observation only: never claim, change or retry a delivery. Queue age is its updated_at,
// so an explicit Retry starts a new wait. The latch and founder line commit together.
import type { DatabaseSync } from "node:sqlite";
import type { WorldAgent, WorldState } from "../shared/types.ts";
import type { OfficeNotices } from "./notices.ts";

const WAIT_MS = 10 * 60_000;
export class Undelivered {
  private db: DatabaseSync;
  private free: ReadonlySet<WorldAgent["status"]>;
  constructor(db: DatabaseSync, free: ReadonlySet<WorldAgent["status"]>) {
    this.db = db;
    this.free = free;
  }

  /** Called by the sender as well as the poll, so a drain between polls rearms immediately. */
  drained(): void {
    this.db.exec(`DELETE FROM undelivered_episodes WHERE agent_id NOT IN
      (SELECT agent_id FROM message_deliveries WHERE state = 'queued')`);
  }

  tick(state: WorldState, at: number, notices: OfficeNotices): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    let changed = false;
    try {
      this.drained();
      const queues = this.db.prepare(`SELECT agent_id, COUNT(*) AS n, MIN(updated_at) AS oldest
        FROM message_deliveries WHERE state = 'queued' GROUP BY agent_id`).all() as Array<{ agent_id: string; n: number; oldest: string }>;
      for (const q of queues) {
        const agent = state.agents.find((a) => a.id === q.agent_id);
        const age = at - Date.parse(q.oldest);
        if (!agent || !this.free.has(agent.status) || age <= WAIT_MS || !Number.isFinite(age)) continue;
        if (!this.db.prepare("INSERT OR IGNORE INTO undelivered_episodes (agent_id) VALUES (?)").run(agent.id).changes) continue;
        const project = state.teams.find((t) => t.id === agent.teamId)?.name ?? agent.project ?? "no project";
        notices.record(`${agent.name}: messages undelivered`,
          `${agent.name} (${project}) is free but ${q.n} messages have waited ${Math.floor(age / 60_000)} minutes undelivered.`, [agent.id], at);
        changed = true;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }
}
