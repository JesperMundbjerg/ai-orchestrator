// The office world's state rules: which agents exist, who they are across session restarts,
// which team each one sits in, and where each team stands. An agent is whatever herdr sees
// running plus every inbox task not bound to a running agent; team members stay at their desks
// when they are offline. Your instructions to a team are kept here and typed into an agent's
// terminal only once it is free, and a team becoming blocked is announced once.

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { projectRoot } from "../shared/project.ts";
import {
  TEAM_STRUCTURES,
  type AgentRole, type AgentScreen, type DeliveryState, type Harness, type InboxState, type Presence, type Team, type TeamOrder,
  type TeamStatus, type TeamStructure, type WorldAgent, type WorldState, type WorldTeam,
} from "../shared/types.ts";
import { InboxError } from "./inbox.ts";

/** An agent a terminal multiplexer reports as running. */
export interface LiveAgent {
  paneId: string;
  harness: Harness;
  sessionId: string | null;
  cwd: string | null;
  status: Presence["status"];
  title: string | null;
}

export interface AgentSource {
  available(): boolean;
  live(): LiveAgent[];
  read(paneId: string): Promise<string>;
  focus(paneId: string): Promise<void>;
  /** Types a prompt into the agent and resolves once it has started on it. */
  prompt(paneId: string, text: string): Promise<void>;
  /** Tells you something, wherever you are working. */
  notify(title: string, body: string): Promise<void>;
}

type Inbox = () => Pick<InboxState, "tasks" | "projects" | "items">;
const ORDERS_SHOWN = 20;
/** An agent is free for a new prompt when it has finished its turn and is not asking anything. */
const FREE: ReadonlySet<WorldAgent["status"]> = new Set(["idle", "done"]);

/** First names handed out in a stable order per identity; a name is kept once given. */
const NAMES = [
  "Tom", "Ada", "Maja", "Noah", "Freja", "Oscar", "Ida", "Lucas", "Clara", "Emil", "Alma", "Viktor", "Sofie", "Felix",
  "Nora", "Anton", "Liv", "Magnus", "Esther", "Karl", "Agnes", "Otto", "Vera", "Aksel", "Ellen", "Hugo", "Selma", "Theo",
];

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

export function agentId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

export class World {
  private db: DatabaseSync;
  private source: AgentSource | null;
  private inbox: Inbox;
  private now: () => Date;
  private projects = new Map<string, string | null>();
  /** The last status seen per team, so a team is announced when it becomes blocked, not while it stays so. */
  private announced: Map<string, TeamStatus> | null = null;
  onChange: (reason: string) => void = () => {};

  constructor(db: DatabaseSync, source: AgentSource | null, inbox: Inbox, now: () => Date = () => new Date()) {
    this.db = db;
    this.source = source;
    this.inbox = inbox;
    this.now = now;
  }

  state(): WorldState {
    const inbox = this.inbox();
    const agents = this.join(inbox.tasks);
    const projectOfTask = new Map(inbox.tasks.map((t) => [t.id, inbox.projects.find((p) => p.id === t.projectId)?.name ?? null]));
    const waitedOn = new Set(inbox.items.filter((i) => i.state === "needs_attention" && i.blocking).map((i) => i.taskId));
    const rows = new Map((this.db.prepare("SELECT * FROM world_agents").all() as Row[]).map((r) => [str(r.identity), r]));
    for (const a of agents) if (!rows.has(a.identity)) rows.set(a.identity, this.register(a.identity, rows));

    const seen = new Set(agents.map((a) => a.identity));
    // Team members who are neither running nor holding a task still have a desk.
    for (const row of rows.values()) {
      if (!row.team_id || seen.has(str(row.identity))) continue;
      const [harness, cwd] = splitIdentity(str(row.identity));
      agents.push({ identity: str(row.identity), harness, cwd, status: "offline", title: null, paneId: null, taskIds: [] });
    }

    const world = agents.map((a): WorldAgent => {
      const row = rows.get(a.identity)!;
      return {
        ...a,
        id: str(row.id),
        name: str(row.name),
        project: (a.cwd ? this.projectOf(a.cwd) : null) ?? projectOfTask.get(a.taskIds[0] ?? "") ?? null,
        teamId: row.team_id ? str(row.team_id) : null,
        role: str(row.role) as AgentRole,
        waitingOnYou: a.taskIds.some((t) => waitedOn.has(t)),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const orders = this.orders();
    return {
      agents: world,
      teams: this.teams().map((team) => ({ ...team, ...teamStatus(world.filter((a) => a.teamId === team.id)), orders: orders.filter((o) => o.teamId === team.id) })),
      herdr: this.source?.available() ? "connected" : "unavailable",
    };
  }

  /**
   * Runs after anything changed: hands queued instructions to agents that have become free,
   * and announces a team that has just become blocked. The first run only takes note of how
   * things stand, so a restart does not re-announce every team that was already stuck.
   */
  async react(): Promise<void> {
    const state = this.state();
    const first = this.announced === null;
    const before = this.announced ?? new Map<string, TeamStatus>();
    this.announced = new Map(state.teams.map((t) => [t.id, t.status]));
    const names = new Map(state.agents.map((a) => [a.id, a.name]));
    const notices = first ? [] : state.teams.filter((t) => t.status === "blocked" && before.get(t.id) !== "blocked");
    await Promise.all([
      ...notices.map((t) => this.source?.notify(`${t.name} is blocked`, `Waiting on ${t.blockedBy.map((id) => names.get(id) ?? id).join(" and ")}.`).catch(() => {})),
      ...this.sendable(state).map((d) => this.send(d)),
    ]);
  }

  private sendable(state: WorldState): Array<{ orderId: string; agent: WorldAgent; text: string }> {
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const out: Array<{ orderId: string; agent: WorldAgent; text: string }> = [];
    // One order at a time per agent, oldest first: a later order waits behind an earlier one.
    const pending = new Set<string>();
    for (const team of state.teams) {
      for (const order of [...team.orders].reverse()) {
        for (const d of order.deliveries) {
          if (pending.has(d.agentId) || (d.state !== "queued" && d.state !== "sending")) continue;
          pending.add(d.agentId);
          const agent = agents.get(d.agentId);
          if (d.state === "queued" && agent?.paneId && FREE.has(agent.status)) out.push({ orderId: order.id, agent, text: briefing(team, agent, state.agents, order.text) });
        }
      }
    }
    return out;
  }

  private async send({ orderId, agent, text }: { orderId: string; agent: WorldAgent; text: string }): Promise<void> {
    // Claimed before typing, so two reactions never type the same order twice.
    const claimed = this.db
      .prepare("UPDATE order_deliveries SET state = 'sending', updated_at = ? WHERE order_id = ? AND agent_id = ? AND state = 'queued'")
      .run(this.now().toISOString(), orderId, agent.id);
    if (!claimed.changes || !this.source) return;
    this.onChange("world");
    let error: string | null = null;
    try {
      await this.source.prompt(agent.paneId!, text);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.db
      .prepare("UPDATE order_deliveries SET state = ?, error = ?, updated_at = ? WHERE order_id = ? AND agent_id = ?")
      .run(error ? "failed" : "delivered", error, this.now().toISOString(), orderId, agent.id);
    this.onChange("world");
  }

  /**
   * Gives a team an instruction. A lead-and-crew team hears it through its lead, who divides
   * the work; peers each hear it and settle it between them. Retrying with the same client id
   * returns the first order instead of giving a second one.
   */
  instruct(teamId: string, input: { text?: string; clientId?: string }): TeamOrder {
    const team = this.team(teamId);
    const text = input.text?.trim();
    if (!text) throw new InboxError(400, "an instruction needs some text");
    if (input.clientId) {
      const existing = this.db.prepare("SELECT id FROM team_orders WHERE client_id = ?").get(input.clientId) as Row | undefined;
      if (existing) return this.order(str(existing.id));
    }
    const members = this.state().agents.filter((a) => a.teamId === teamId);
    const targets = team.structure === "dispatch" ? members.filter((a) => a.role === "lead") : members.filter((a) => a.paneId);
    if (!targets.length) {
      throw new InboxError(409, team.structure === "dispatch" ? `${team.name} has no lead to hand the instruction to` : `nobody in ${team.name} is running to hear it`);
    }
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO team_orders (id, team_id, text, client_id, created_at) VALUES (?, ?, ?, ?, ?)").run(id, teamId, text, input.clientId ?? null, at);
      for (const a of targets) {
        this.db.prepare("INSERT INTO order_deliveries (order_id, agent_id, state, updated_at) VALUES (?, ?, 'queued', ?)").run(id, a.id, at);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.onChange("world");
    return this.order(id);
  }

  /** Puts a failed delivery back in line. */
  retry(orderId: string, agentId: string): TeamOrder {
    const done = this.db
      .prepare("UPDATE order_deliveries SET state = 'queued', error = NULL, updated_at = ? WHERE order_id = ? AND agent_id = ? AND state = 'failed'")
      .run(this.now().toISOString(), orderId, agentId);
    if (!done.changes) throw new InboxError(409, "only a failed delivery can be retried");
    this.onChange("world");
    return this.order(orderId);
  }

  private orders(): TeamOrder[] {
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT *, rowid AS seq, row_number() OVER (PARTITION BY team_id ORDER BY rowid DESC) AS n FROM team_orders) WHERE n <= ${ORDERS_SHOWN} ORDER BY seq DESC`)
      .all() as Row[];
    const deliveries = this.db.prepare("SELECT * FROM order_deliveries").all() as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      teamId: str(r.team_id),
      text: str(r.text),
      createdAt: str(r.created_at),
      deliveries: deliveries.filter((d) => d.order_id === r.id).map((d) => ({
        agentId: str(d.agent_id),
        state: str(d.state) as DeliveryState,
        error: d.error == null ? null : str(d.error),
        updatedAt: str(d.updated_at),
      })),
    }));
  }

  private order(id: string): TeamOrder {
    const found = this.orders().find((o) => o.id === id);
    if (!found) throw new InboxError(404, `no order ${id}`);
    return found;
  }

  /** Running agents and inbox tasks, joined on their session and merged per identity. */
  private join(tasks: InboxState["tasks"]): Array<Omit<WorldAgent, "id" | "name" | "project" | "teamId" | "role" | "waitingOnYou">> {
    const live = this.source?.live() ?? [];
    const out = new Map<string, Omit<WorldAgent, "id" | "name" | "project" | "teamId" | "role" | "waitingOnYou">>();
    for (const a of live) {
      let identity = identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId);
      // Two agents in one checkout are two people.
      for (let n = 2; out.has(identity); n++) identity = `${identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId)}#${n}`;
      out.set(identity, { identity, harness: a.harness, cwd: a.cwd, status: a.status, title: a.title, paneId: a.paneId, taskIds: [] });
    }
    for (const task of tasks) {
      if (task.parked) continue;
      const byPane = task.presence ? [...out.values()].find((a) => a.paneId === task.presence!.paneId) : undefined;
      const identity = byPane?.identity ?? identityOf(task.binding.harness, task.binding.cwd, task.binding.sessionId);
      const agent = out.get(identity);
      if (agent) agent.taskIds.push(task.id);
      else out.set(identity, { identity, harness: task.binding.harness, cwd: task.binding.cwd, status: "offline", title: null, paneId: null, taskIds: [task.id] });
    }
    return [...out.values()];
  }

  private register(identity: string, known: Map<string, Row>): Row {
    const taken = new Set([...known.values()].map((r) => str(r.name)));
    const start = parseInt(agentId(identity).slice(0, 8), 16) % NAMES.length;
    let name = "";
    for (let i = 0; i < NAMES.length && !name; i++) {
      const candidate = NAMES[(start + i) % NAMES.length]!;
      if (!taken.has(candidate)) name = candidate;
    }
    if (!name) name = `${NAMES[start]} ${taken.size + 1}`;
    const row = { id: agentId(identity), identity, name, team_id: null, role: "member", first_seen_at: this.now().toISOString() };
    this.db
      .prepare("INSERT OR IGNORE INTO world_agents (id, identity, name, role, first_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, identity, name, row.role, row.first_seen_at);
    return row;
  }

  private projectOf(cwd: string): string | null {
    if (!this.projects.has(cwd)) this.projects.set(cwd, projectRoot(cwd)?.name ?? null);
    return this.projects.get(cwd)!;
  }

  teams(): Team[] {
    return (this.db.prepare("SELECT * FROM teams ORDER BY created_at, name").all() as Row[]).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      structure: str(r.structure) as TeamStructure,
      createdAt: str(r.created_at),
    }));
  }

  createTeam(input: { name?: string; structure?: string }): Team {
    const name = input.name?.trim();
    if (!name) throw new InboxError(400, "a team needs a name");
    const structure = checkStructure(input.structure ?? "circle");
    const id = randomUUID();
    this.db.prepare("INSERT INTO teams (id, name, structure, created_at) VALUES (?, ?, ?, ?)").run(id, name, structure, this.now().toISOString());
    this.onChange("world");
    return this.team(id);
  }

  updateTeam(id: string, patch: { name?: string; structure?: string }): Team {
    this.team(id);
    if (patch.name !== undefined && !patch.name.trim()) throw new InboxError(400, "a team needs a name");
    this.db
      .prepare("UPDATE teams SET name = coalesce(?, name), structure = coalesce(?, structure) WHERE id = ?")
      .run(patch.name?.trim() ?? null, patch.structure === undefined ? null : checkStructure(patch.structure), id);
    this.onChange("world");
    return this.team(id);
  }

  /** Removes the team; its members go back to the lounge with their names and faces. */
  deleteTeam(id: string): { ok: true } {
    this.team(id);
    this.db.prepare("UPDATE world_agents SET team_id = NULL, role = 'member' WHERE team_id = ?").run(id);
    this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    this.onChange("world");
    return { ok: true };
  }

  /** Renames an agent, or seats it in a team. A team has at most one lead. */
  updateAgent(id: string, patch: { name?: string; teamId?: string | null; role?: string }): WorldAgent {
    const row = this.db.prepare("SELECT * FROM world_agents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no agent ${id}`);
    if (patch.name !== undefined && !patch.name.trim()) throw new InboxError(400, "an agent needs a name");
    if (patch.teamId) this.team(patch.teamId);
    if (patch.role !== undefined && patch.role !== "lead" && patch.role !== "member") throw new InboxError(400, `role must be lead or member`);
    const teamId = patch.teamId === undefined ? (row.team_id ? str(row.team_id) : null) : patch.teamId;
    // Leaving a team drops the lead role with it.
    const role = !teamId ? "member" : patch.role ?? (patch.teamId !== undefined && patch.teamId !== row.team_id ? "member" : str(row.role));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (role === "lead") this.db.prepare("UPDATE world_agents SET role = 'member' WHERE team_id = ? AND id != ?").run(teamId, id);
      this.db
        .prepare("UPDATE world_agents SET name = coalesce(?, name), team_id = ?, role = ? WHERE id = ?")
        .run(patch.name?.trim() ?? null, teamId, role, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.onChange("world");
    return this.agent(id);
  }

  agent(id: string): WorldAgent {
    const found = this.state().agents.find((a) => a.id === id);
    if (!found) throw new InboxError(404, `no agent ${id}`);
    return found;
  }

  /** What the agent's terminal shows now. Only herdr can read a terminal. */
  async screen(id: string): Promise<AgentScreen> {
    const agent = this.agent(id);
    if (!this.source || !agent.paneId) throw new InboxError(409, `${agent.name} is not running in herdr, so there is no terminal to show`);
    return { text: await this.source.read(agent.paneId), readAt: this.now().toISOString() };
  }

  async focus(id: string): Promise<{ ok: true }> {
    const agent = this.agent(id);
    if (!this.source || !agent.paneId) throw new InboxError(409, `${agent.name} is not running in herdr, so it cannot be brought to the front`);
    await this.source.focus(agent.paneId);
    return { ok: true };
  }

  private team(id: string): Team {
    const found = this.teams().find((t) => t.id === id);
    if (!found) throw new InboxError(404, `no team ${id}`);
    return found;
  }
}

/** Where a team stands: stuck when its lead is, or when someone is and nobody is still working. */
export function teamStatus(members: WorldAgent[]): { status: TeamStatus; blockedBy: string[]; projects: string[] } {
  const projects = [...new Set(members.flatMap((m) => (m.project ? [m.project] : [])))].sort();
  const stuck = members.filter((m) => m.status === "blocked" || m.waitingOnYou);
  const working = members.some((m) => m.status === "working" && !m.waitingOnYou);
  const leadStuck = stuck.some((m) => m.role === "lead");
  if (stuck.length && (leadStuck || !working)) return { status: "blocked", blockedBy: stuck.map((m) => m.id), projects };
  if (working) return { status: "working", blockedBy: [], projects };
  if (members.some((m) => m.status !== "offline")) return { status: "idle", blockedBy: [], projects };
  return { status: "offline", blockedBy: [], projects };
}

/** What the agent reads: who is asking, what team it is in and what its part is, then the instruction. */
function briefing(team: WorldTeam, agent: WorldAgent, agents: WorldAgent[], text: string): string {
  const others = agents.filter((a) => a.teamId === team.id && a.id !== agent.id);
  const who = (a: WorldAgent) => `${a.name}${a.cwd ? ` (${a.cwd})` : ""}`;
  const part = team.structure === "dispatch"
    ? `You lead ${team.name}. Divide this among your crew${others.length ? ` (${others.map(who).join(", ")})` : ""} and keep them moving.`
    : `You are one of the peers in ${team.name}${others.length ? `, with ${others.map(who).join(", ")}` : ""}. Settle between you who does what.`;
  return `[From the founder to the team ${team.name}] ${part} Ask in the review inbox if you need a decision.\n\n${text}`;
}

function identityOf(harness: Harness, cwd: string | null, fallback: string): string {
  return `${harness}:${cwd ?? fallback}`;
}

function splitIdentity(identity: string): [Harness, string | null] {
  const at = identity.indexOf(":");
  const rest = identity.slice(at + 1).replace(/#\d+$/, "");
  return [identity.slice(0, at) as Harness, rest.startsWith("/") ? rest : null];
}

function checkStructure(value: string): TeamStructure {
  if (!(TEAM_STRUCTURES as readonly string[]).includes(value)) throw new InboxError(400, `structure must be one of ${TEAM_STRUCTURES.join(", ")}`);
  return value as TeamStructure;
}
