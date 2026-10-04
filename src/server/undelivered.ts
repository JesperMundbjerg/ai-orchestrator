// Observation only: never claim, change or retry a delivery. Queue age is its updated_at,
// so an explicit Retry starts a new wait. The latch and founder line commit together.
import type { DatabaseSync } from "node:sqlite";
import type { WorldAgent, WorldState } from "../shared/types.ts";
import type { OfficeNotices } from "./notices.ts";

const WAIT_MS = 10 * 60_000;

/** Queued deliveries to one agent the office knows is gone, with who sent each. `sender` is null for the founder or the office. */
export interface GoneDeliveries {
  agentId: string;
  name: string;
  removed: boolean;
  senders: Array<{ sender: string | null; office: boolean; count: number }>;
  messageIds: string[];
}

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

  /**
   * Agents whose queued deliveries can never be typed: removed from the office, or not seen
   * running (or holding a task) for `graceMs`, which the office sets to how long a pane keeps its
   * record while nothing runs there. Without a grace period only the removed count.
   * Never an agent that is running, being switched (`held`), a team's lead (which waits to
   * return or be replaced by the founder's choice, leadwatch) or a standing team's member (recovered onto a
   * replacement with `inbox lane`, which then gets what waited). Observation only: the caller fails the rows.
   */
  gone(state: WorldState, at: number, held: ReadonlySet<string>, graceMs: number | null, removing: ReadonlySet<string> = new Set()): GoneDeliveries[] {
    const running = new Set(state.agents.filter((a) => a.paneId).map((a) => a.id));
    const rows = this.db.prepare(`SELECT d.message_id, d.agent_id, a.name, a.removed, a.role, a.team_id, t.standing, a.last_seen_at,
        m.from_agent_id, m.from_office FROM message_deliveries d
      JOIN messages m ON m.id = d.message_id JOIN world_agents a ON a.id = d.agent_id LEFT JOIN teams t ON t.id = a.team_id
      WHERE d.state = 'queued' ORDER BY m.rowid`).all() as Array<Record<string, unknown>>;
    const out = new Map<string, GoneDeliveries>();
    for (const r of rows) {
      const agentId = String(r.agent_id);
      if (!removing.has(agentId) && (running.has(agentId) || held.has(agentId))) continue;
      const removed = Boolean(r.removed) || removing.has(agentId);
      const away = Date.parse(String(r.last_seen_at ?? ""));
      if (!removed && ((r.role === "lead" && r.team_id) || r.standing || graceMs === null || !(away <= at - graceMs))) continue;
      const entry = out.get(agentId) ?? { agentId, name: String(r.name), removed, senders: [], messageIds: [] };
      out.set(agentId, entry);
      entry.messageIds.push(String(r.message_id));
      const sender = r.from_agent_id ? String(r.from_agent_id) : null;
      const office = Boolean(r.from_office);
      const known = entry.senders.find((s) => s.sender === sender && s.office === office);
      if (known) known.count++;
      else entry.senders.push({ sender, office, count: 1 });
    }
    return [...out.values()];
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
