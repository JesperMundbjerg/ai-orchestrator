// The office world's state rules: which agents exist, who they are across session restarts,
// which team each one sits in, and where each team stands. An agent is whatever herdr sees
// running plus every inbox task not bound to a running agent; team members stay at their desks
// when they are offline. Your instructions to a team are kept here and typed into an agent's
// terminal only once it is free (messages.ts), and a team becoming blocked is announced once.

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { projectRoot } from "../shared/project.ts";
import {
  TEAM_STRUCTURES,
  type AgentRole, type AgentScreen, type Harness, type InboxState, type Presence, type SessionInput, type Team, type TeamBrief,
  type TeamStatus, type TeamStructure, type WorldAgent, type WorldState,
} from "../shared/types.ts";
import { InboxError } from "./inbox.ts";
import { Messages } from "./messages.ts";

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
type Joined = Omit<WorldAgent, "id" | "name" | "project" | "teamId" | "role" | "waitingOnYou" | "doing" | "helpers"> & { sessionId: string | null };

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
  readonly messages: Messages;
  onChange: (reason: string) => void = () => {};

  constructor(db: DatabaseSync, source: AgentSource | null, inbox: Inbox, now: () => Date = () => new Date()) {
    this.db = db;
    this.source = source;
    this.inbox = inbox;
    this.now = now;
    this.messages = new Messages(db, source, () => this.state(), now, () => this.onChange("world"));
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
      agents.push({ identity: str(row.identity), harness, cwd, status: "offline", title: null, paneId: null, taskIds: [], sessionId: null });
    }

    const world = agents.map(({ sessionId: _, ...a }): WorldAgent => {
      const row = rows.get(a.identity)!;
      return {
        ...a,
        id: str(row.id),
        name: str(row.name),
        project: (a.cwd ? this.projectOf(a.cwd) : null) ?? projectOfTask.get(a.taskIds[0] ?? "") ?? null,
        teamId: row.team_id ? str(row.team_id) : null,
        role: str(row.role) as AgentRole,
        waitingOnYou: a.taskIds.some((t) => waitedOn.has(t)),
        doing: null,
        helpers: [],
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      agents: world,
      teams: this.teams().map((team) => ({ ...team, ...teamStatus(world.filter((a) => a.teamId === team.id)) })),
      messages: this.messages.list(),
      work: this.messages.work(),
      herdr: this.source?.available() ? "connected" : "unavailable",
    };
  }

  /**
   * Which agent in the office a calling session is: by its herdr pane, by the session herdr
   * reports running, by harness and checkout, or by the inbox task it posted from.
   */
  resolve(session: SessionInput): WorldAgent {
    const state = this.state();
    const live = this.source?.live() ?? [];
    const pane = session.paneId ?? live.find((a) => a.harness === session.harness && a.sessionId === session.sessionId)?.paneId;
    const task = this.inbox().tasks.find((t) => t.binding.harness === session.harness && t.binding.sessionId === session.sessionId);
    const found = (pane ? state.agents.find((a) => a.paneId === pane) : undefined)
      ?? (session.harness && session.cwd ? state.agents.find((a) => a.identity === identityOf(session.harness!, session.cwd!, "")) : undefined)
      ?? (task ? state.agents.find((a) => a.taskIds.includes(task.id)) : undefined);
    if (!found) throw new InboxError(404, "the office does not know this session: run inside herdr, or post to the inbox first");
    return found;
  }

  /** What `inbox team` prints: who the agent is, its team and part in it, and what waits for it. */
  brief(session: SessionInput): TeamBrief {
    const me = this.resolve(session);
    const state = this.state();
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const teams = new Map(state.teams.map((t) => [t.id, t]));
    const team = me.teamId ? teams.get(me.teamId) ?? null : null;
    const status = (a: WorldAgent) => `${a.name}${a.role === "lead" ? " (lead)" : ""}: ${a.status}${a.doing ? `, ${a.doing}` : ""}`;
    const lines = [`You are ${me.name} (${me.harness}${me.cwd ? `, ${me.cwd}` : ""}).`];
    if (!team) {
      lines.push("You are not in a team: you work straight for the founder.");
    } else {
      const lead = state.agents.find((a) => a.teamId === team.id && a.role === "lead");
      const part = team.structure === "dispatch"
        ? me.role === "lead" ? "You lead it: divide the work among your crew and keep them moving." : `${lead ? `${lead.name} leads it and` : "Its lead"} divides the work; take yours from them.`
        : "It is a team of peers: settle between you who does what.";
      lines.push(`Team: ${team.name}. ${part}`);
      if (team.purpose) lines.push(`Purpose: ${team.purpose}`);
      lines.push(`Members: ${state.agents.filter((a) => a.teamId === team.id && a.id !== me.id).map(status).join("; ") || "just you"}.`);
      const next = team.handsTo ? teams.get(team.handsTo) : null;
      lines.push(next ? `Finished work goes to ${next.name}: inbox handoff "title" --summary "what was done, where, how to check it"` : "Your team does not hand work to another team.");
    }
    const toReview = state.work.filter((w) => w.state === "in_review" && w.toTeamId === me.teamId);
    for (const w of toReview) {
      lines.push(`To review: work ${w.id} "${w.title}" from ${agents.get(w.fromAgentId)?.name ?? "someone"}. Verdict: inbox review ${w.id} accept|changes --notes "…"`);
    }
    for (const w of state.work.filter((x) => x.fromAgentId === me.id)) {
      const where = teams.get(w.toTeamId)?.name ?? "a disbanded team";
      lines.push(`Your handoff ${w.id} "${w.title}" to ${where}: ${w.state === "in_review" ? "under review" : w.state === "accepted" ? "accepted" : `changes requested${w.notes ? ` (${w.notes})` : ""}`}.`);
    }
    const others = state.teams.filter((t) => t.id !== team?.id);
    if (others.length) lines.push(`Other teams: ${others.map((t) => `${t.name}${t.purpose ? ` (${t.purpose})` : ""}`).join("; ")}.`);
    lines.push('Talk to anyone, agent or team, by name: inbox say NAME "text". Messages arrive in their terminal when they are free.');
    return { agentId: me.id, text: lines.join("\n") };
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
      this.messages.deliver(state),
    ]);
  }

  /** Running agents and inbox tasks, joined on their session and merged per identity. */
  private join(tasks: InboxState["tasks"]): Joined[] {
    const live = this.source?.live() ?? [];
    const out = new Map<string, Joined>();
    for (const a of live) {
      let identity = identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId);
      // Two agents in one checkout are two people.
      for (let n = 2; out.has(identity); n++) identity = `${identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId)}#${n}`;
      out.set(identity, { identity, harness: a.harness, cwd: a.cwd, status: a.status, title: a.title, paneId: a.paneId, taskIds: [], sessionId: a.sessionId });
    }
    for (const task of tasks) {
      if (task.parked) continue;
      const byPane = task.presence ? [...out.values()].find((a) => a.paneId === task.presence!.paneId) : undefined;
      const identity = byPane?.identity ?? identityOf(task.binding.harness, task.binding.cwd, task.binding.sessionId);
      const agent = out.get(identity);
      if (agent) agent.taskIds.push(task.id);
      else out.set(identity, { identity, harness: task.binding.harness, cwd: task.binding.cwd, status: "offline", title: null, paneId: null, taskIds: [task.id], sessionId: task.binding.sessionId });
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
      purpose: str(r.purpose),
      handsTo: r.hands_to == null ? null : str(r.hands_to),
      createdAt: str(r.created_at),
    }));
  }

  createTeam(input: { name?: string; structure?: string; purpose?: string; handsTo?: string | null }): Team {
    const name = this.teamName(input.name, null);
    const structure = checkStructure(input.structure ?? "circle");
    const id = randomUUID();
    if (input.handsTo) this.team(input.handsTo);
    this.db
      .prepare("INSERT INTO teams (id, name, structure, purpose, hands_to, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, structure, input.purpose?.trim() ?? "", input.handsTo ?? null, this.now().toISOString());
    this.onChange("world");
    return this.team(id);
  }

  updateTeam(id: string, patch: { name?: string; structure?: string; purpose?: string; handsTo?: string | null }): Team {
    const team = this.team(id);
    const name = patch.name === undefined ? team.name : this.teamName(patch.name, id);
    if (patch.handsTo === id) throw new InboxError(400, "a team cannot hand its work to itself");
    if (patch.handsTo) this.team(patch.handsTo);
    this.db
      .prepare("UPDATE teams SET name = ?, structure = ?, purpose = ?, hands_to = ? WHERE id = ?")
      .run(
        name,
        patch.structure === undefined ? team.structure : checkStructure(patch.structure),
        patch.purpose === undefined ? team.purpose : patch.purpose.trim(),
        patch.handsTo === undefined ? team.handsTo : patch.handsTo,
        id,
      );
    this.onChange("world");
    return this.team(id);
  }

  /** Agents address teams by name, so two teams never share one. */
  private teamName(value: string | undefined, id: string | null): string {
    const name = value?.trim();
    if (!name) throw new InboxError(400, "a team needs a name");
    if (this.teams().some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new InboxError(409, `there is already a team called ${name}`);
    return name;
  }

  /** Removes the team; its members go back to the lounge with their names and faces. */
  deleteTeam(id: string): { ok: true } {
    this.team(id);
    if (this.db.prepare("SELECT 1 FROM work WHERE to_team_id = ? AND state = 'in_review'").get(id)) {
      throw new InboxError(409, "this team still has work under review");
    }
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
