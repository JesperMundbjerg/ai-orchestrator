// The office world's state rules: which agents exist, who they are across session restarts,
// which team each one is on, and where each team stands. An agent is whatever herdr sees
// running plus every inbox task not bound to a running agent. A team is a project's worktree:
// an agent working in a worktree is on that project, one of them leads it, and finishing the
// project removes the worktree. A standing team (Mission Control) has no worktree and keeps its
// members' desks while they are offline. What is said between them is kept and delivered by
// messages.ts, and a team becoming blocked is announced once.

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  ActivityEvent, AgentModel, AgentRole, Harness, InboxState, Presence, Repository, SessionInput, Team, TeamBrief, TeamStatus, WorldAgent, WorldState,
} from "../shared/types.ts";
import { Activity } from "./activity.ts";
import { InboxError } from "./inbox.ts";
import { FOUNDER, Messages } from "./messages.ts";
import { SessionFiles } from "./models.ts";
import { whyStuck } from "../shared/stuck.ts";
import { checkoutOf, deleteMergedBranch, nameFor, placeFor, processesIn, stopProcesses, uncommitted, unmerged, type Checkout } from "./worktrees.ts";

/** An agent a terminal multiplexer reports as running. */
export interface LiveAgent {
  paneId: string;
  harness: Harness;
  sessionId: string | null;
  cwd: string | null;
  status: Presence["status"];
  title: string | null;
  /** The name herdr knows it by, when it was started with one. */
  name: string | null;
}

export interface AgentSource {
  available(): boolean;
  live(): LiveAgent[];
  /** Types a prompt into the agent and resolves once it has started on it. */
  prompt(paneId: string, text: string): Promise<void>;
  /** Tells you something, wherever you are working. */
  notify(title: string, body: string): Promise<void>;
  /** Makes a worktree with a workspace of its own and resolves with the pane a lead can start in. */
  createWorktree(repoRoot: string, place: { path: string; branch: string; base: string | null; label: string }): Promise<{ paneId: string }>;
  /** Starts an agent in a pane. One stopped at a question while starting still counts: it is there, waiting on you. */
  startAgent(paneId: string, name: string, harness: Harness, args: string[]): Promise<void>;
  /** Reads the agent list again now, rather than waiting for the next change or poll. */
  refresh?(): Promise<void>;
  closePane(paneId: string): Promise<void>;
  /** Removes a worktree and closes its workspace. It refuses a worktree with uncommitted changes. */
  removeWorktree(repoRoot: string, path: string): Promise<void>;
}

type Inbox = () => Pick<InboxState, "tasks" | "projects" | "items">;
type Joined = Omit<WorldAgent, "id" | "name" | "project" | "teamId" | "role" | "waitingOnYou" | "doing" | "helpers" | "model" | "ran"> & { sessionId: string | null };

/** First names handed out in a stable order per identity; a name is kept once given. */
const NAMES = [
  "Tom", "Ada", "Maja", "Noah", "Freja", "Oscar", "Ida", "Lucas", "Clara", "Emil", "Alma", "Viktor", "Sofie", "Felix",
  "Nora", "Anton", "Liv", "Magnus", "Esther", "Karl", "Agnes", "Otto", "Vera", "Aksel", "Ellen", "Hugo", "Selma", "Theo",
];

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

/** A first mate's model: it plans, splits and supervises, which is the deep thinking. */
const FIRST_MATE_ARGS = ["--model", "opus", "--effort", "medium"];

/**
 * What a project's lead is, in the sense of firstmate (github.com/kunchenguid/firstmate): the
 * founder's one contact for the project, who runs a crew rather than doing the work itself.
 * Mission Control's lead is different: it dispatches a queue of comments to standing lanes.
 */
const FIRST_MATE = [
  "You are the project's first mate: the founder's one contact for it.",
  "You do not write the code yourself. Split the work into tasks, start a crew member for each in herdr, supervise them to completion, check what they deliver, and report plain outcomes.",
  "Start crew in this worktree:",
  '`herdr pane split --current --direction down --cwd "$PWD" --no-focus` gives a pane (.result.pane.pane_id);',
  "`herdr agent start <name> --kind claude --pane <pane id> -- --model sonnet` starts a crew member in it (a unique lowercase name);",
  '`herdr agent prompt <name> "<task>"` gives it its task.',
  "Use --model sonnet for most tasks and --model opus --effort medium for work that needs deep thinking.",
  "Crew share this checkout, so give each one files of its own.",
  'Tell each crew member to report to you with `inbox say <your office name> "…"` when done or stuck, and not to ask the founder; their reports arrive in your terminal.',
  "Close a member's pane when its work is done: `herdr pane close <pane id>`.",
  "Bring the founder only real decisions (`inbox decide`) and finished milestones (`inbox milestone`); to show what changed in the app, add the pages to step through in order (`--page \"Label=URL\"`).",
  'Answer each message from the founder in one or two sentences with `inbox say founder "…"`, and follow up the same way when the job is done or something new happens, such as a crew member finishing.',
  "Ask a decision the way an engineer asks a colleague: the title is the question, the request says what you need and what happens if nobody answers, options read \"Label: consequence\", and the recommendation gives your pick and why; `inbox --help` has an example.",
].join(" ");

export function agentId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

export class World {
  private db: DatabaseSync;
  private source: AgentSource | null;
  private inbox: Inbox;
  private now: () => Date;
  private checkouts = new Map<string, Checkout | null>();
  /** The last status seen per team, so a team is announced when it becomes blocked, not while it stays so. */
  private announced: Map<string, TeamStatus> | null = null;
  readonly messages: Messages;
  private activity = new Activity();
  /** Session files, for the model of an agent whose harness does not report it. */
  private files: SessionFiles;
  private activityTimer: NodeJS.Timeout | null = null;
  onChange: (reason: string) => void = () => {};

  constructor(db: DatabaseSync, source: AgentSource | null, inbox: Inbox, now: () => Date = () => new Date(), files = new SessionFiles()) {
    this.db = db;
    this.source = source;
    this.inbox = inbox;
    this.now = now;
    this.files = files;
    this.messages = new Messages(db, source, () => this.state(), now, () => this.onChange("world"));
  }

  state(): WorldState {
    const inbox = this.inbox();
    const agents = this.join(inbox.tasks);
    const projectOfTask = new Map(inbox.tasks.map((t) => [t.id, inbox.projects.find((p) => p.id === t.projectId)?.name ?? null]));
    const waitedOn = new Set(inbox.items.filter((i) => i.state === "needs_attention" && i.blocking).map((i) => i.taskId));
    const rows = new Map((this.db.prepare("SELECT * FROM world_agents").all() as Row[]).map((r) => [str(r.identity), r]));
    for (const a of agents) if (!rows.has(a.identity)) rows.set(a.identity, this.register(a.identity, rows));
    // Someone you removed stays out while nothing runs behind them; running again brings them back.
    for (const a of agents) {
      const row = rows.get(a.identity)!;
      if (!a.paneId) continue;
      if (row.removed || !row.ran_at) {
        row.ran_at ??= this.now().toISOString();
        row.removed = 0;
        this.db.prepare("UPDATE world_agents SET ran_at = ?, removed = 0 WHERE id = ?").run(str(row.ran_at), str(row.id));
      }
    }
    for (let i = agents.length - 1; i >= 0; i--) if (!agents[i]!.paneId && rows.get(agents[i]!.identity)!.removed) agents.splice(i, 1);
    const teams = this.teams();

    // Working in a project's worktree puts an agent on that project, which is made for a worktree seen for the first time.
    for (const a of agents) {
      const row = rows.get(a.identity)!;
      const checkout = a.cwd ? this.checkout(a.cwd) : null;
      if (row.team_id || !checkout?.linked) continue;
      const team = teams.find((t) => t.path === checkout.top) ?? this.adopt(checkout, teams);
      this.db.prepare("UPDATE world_agents SET team_id = ?, role = 'member' WHERE id = ?").run(team.id, str(row.id));
      Object.assign(row, { team_id: team.id, role: "member" });
    }

    const seen = new Set(agents.map((a) => a.identity));
    this.seatLeads(agents, rows, seen);
    // A standing team keeps its members' desks, and a project its lead's, while they are neither running nor holding a task.
    for (const row of rows.values()) {
      const team = row.team_id ? teams.find((t) => t.id === row.team_id) : undefined;
      if (!team || row.removed || seen.has(str(row.identity)) || (!team.standing && row.role !== "lead")) continue;
      const [harness, cwd] = splitIdentity(str(row.identity));
      agents.push({ identity: str(row.identity), harness, cwd, status: "offline", title: null, paneId: null, taskIds: [], sessionId: null });
    }

    const world = agents.map(({ sessionId, ...a }): WorldAgent => {
      const row = rows.get(a.identity)!;
      return {
        ...a,
        id: str(row.id),
        name: str(row.name),
        project: (a.cwd ? this.checkout(a.cwd)?.repoName : null) ?? projectOfTask.get(a.taskIds[0] ?? "") ?? null,
        teamId: row.team_id ? str(row.team_id) : null,
        role: str(row.role) as AgentRole,
        waitingOnYou: a.taskIds.some((t) => waitedOn.has(t)),
        ...this.activityOf(str(row.id), a.status),
        // What the harness reported wins; its own session file is the fallback, read lazily.
        model: this.activity.modelOf(str(row.id), sessionId) ?? this.files.modelOf(a.harness, sessionId, this.now().getTime()),
        ran: Boolean(row.ran_at),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    this.appointLeads(world, teams, rows);

    return {
      agents: world,
      teams: teams.map((team) => ({ ...team, ...teamStatus(world.filter((a) => a.teamId === team.id)) })),
      messages: this.messages.list(),
      withFounder: this.messages.withFounder(),
      work: this.messages.work(),
      repositories: this.repositories(world, teams),
      herdr: this.source?.available() ? "connected" : "unavailable",
    };
  }

  /**
   * The agent running in the pane a project's first mate was started in is its lead, whatever
   * herdr calls it. herdr can lose the name it started the agent with, which makes it a new
   * record; the lead record left offline is folded into it, keeping its name and what was said
   * to it. A lead who is running, such as one you picked, is left alone.
   */
  private seatLeads(agents: Joined[], rows: Map<string, Row>, seen: Set<string>): void {
    const panes = this.db.prepare("SELECT id, lead_pane FROM teams WHERE lead_pane IS NOT NULL AND standing = 0").all() as Row[];
    for (const t of panes) {
      const teamId = str(t.id);
      const running = agents.find((a) => a.paneId === str(t.lead_pane) && a.status !== "offline");
      const row = running && rows.get(running.identity);
      if (!row || (row.team_id === teamId && row.role === "lead")) continue;
      const lead = [...rows.values()].find((r) => r.team_id === teamId && r.role === "lead");
      if (lead && seen.has(str(lead.identity))) continue;
      this.tx(() => this.seat(row, teamId, lead ?? null, rows));
    }
  }

  /**
   * Makes `row` the team's lead. With `fold`, the lead record it replaces goes into it: `row`
   * takes its name, and the messages, deliveries and work that were its. Call inside a transaction.
   */
  private seat(row: Row, teamId: string, fold: Row | null, rows?: Map<string, Row>): void {
    if (fold) {
      const [from, to] = [str(fold.id), str(row.id)];
      this.db.prepare("UPDATE OR IGNORE message_deliveries SET agent_id = ? WHERE agent_id = ?").run(to, from);
      this.db.prepare("DELETE FROM message_deliveries WHERE agent_id = ?").run(from);
      this.db.prepare("UPDATE messages SET from_agent_id = ? WHERE from_agent_id = ?").run(to, from);
      this.db.prepare("UPDATE work SET from_agent_id = ? WHERE from_agent_id = ?").run(to, from);
      this.db.prepare("UPDATE work SET reviewer_id = ? WHERE reviewer_id = ?").run(to, from);
      this.db.prepare("DELETE FROM world_agents WHERE id = ?").run(from);
      rows?.delete(str(fold.identity));
      row.name = fold.name;
    }
    this.db.prepare("UPDATE world_agents SET role = 'member' WHERE team_id = ? AND id != ?").run(teamId, str(row.id));
    for (const r of rows?.values() ?? []) if (r.team_id === teamId) r.role = "member";
    this.db.prepare("UPDATE world_agents SET name = ?, team_id = ?, role = 'lead' WHERE id = ?").run(str(row.name), teamId, str(row.id));
    Object.assign(row, { team_id: teamId, role: "lead" });
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Every team with anyone on it has a lead: the one who has been on it longest, preferring someone running. */
  private appointLeads(world: WorldAgent[], teams: Team[], rows: Map<string, Row>): void {
    const since = (a: WorldAgent) => str(rows.get(a.identity)?.first_seen_at);
    for (const team of teams) {
      const members = world.filter((a) => a.teamId === team.id);
      if (!members.length || members.some((a) => a.role === "lead")) continue;
      const lead = [...members].sort((a, b) => Number(!a.paneId) - Number(!b.paneId) || since(a).localeCompare(since(b)))[0]!;
      this.db.prepare("UPDATE world_agents SET role = 'lead' WHERE id = ?").run(lead.id);
      lead.role = "lead";
    }
  }

  /** The repositories agents work in, where a new project can be made. */
  private repositories(world: WorldAgent[], teams: Team[]): Repository[] {
    const out = new Map<string, Repository>();
    for (const cwd of [...world.map((a) => a.cwd), ...teams.map((t) => t.path)]) {
      const checkout = cwd ? this.checkout(cwd) : null;
      if (checkout && !out.has(checkout.repoRoot)) out.set(checkout.repoRoot, { name: checkout.repoName, root: checkout.repoRoot, base: this.checkout(checkout.repoRoot)?.branch ?? null });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A repository nobody works in yet, named by the path of its main checkout. */
  private mainCheckout(path: string | undefined): Repository | undefined {
    const checkout = path && isAbsolute(path) ? checkoutOf(path) : null;
    if (!checkout || checkout.linked || checkout.top !== path) return undefined;
    return { name: checkout.repoName, root: checkout.repoRoot, base: checkout.branch };
  }

  /** A worktree seen for the first time becomes a project, named after its folder. */
  private adopt(checkout: Checkout, teams: Team[]): Team {
    let name = nameFor(checkout);
    for (let n = 2; teams.some((t) => t.name.toLowerCase() === name.toLowerCase()); n++) name = `${nameFor(checkout)} ${n}`;
    const team = this.insertTeam({ name, purpose: "", handsTo: null, path: checkout.top, branch: checkout.branch, standing: false });
    teams.push(team);
    return team;
  }

  /**
   * What an agent's harness reports it doing, and the model it runs. An unknown session is
   * ignored rather than an error, since a hook must never get in an agent's way. `modelFor` is
   * asked for the model when the caller has to read it from somewhere, given the one known now.
   */
  report(session: SessionInput, events: ActivityEvent[], helperId: string | null = null, modelFor?: (known: AgentModel | null) => AgentModel | null): { ok: boolean } {
    if (!events.length && !helperId && !modelFor) return { ok: true };
    let agent: WorldAgent;
    try {
      agent = this.resolve(session);
    } catch {
      return { ok: false };
    }
    const now = this.now().getTime();
    if (helperId) this.activity.touchHelper(agent.id, helperId, now);
    let changed = false;
    for (const e of events) changed = this.activity.record(agent.id, e, now) || changed;
    const sessionId = session.sessionId ?? null;
    const model = events.findLast((e) => e.kind === "model")?.model ?? modelFor?.(this.activity.modelOf(agent.id, sessionId)) ?? null;
    if (model?.id && model.label) changed = this.activity.setModel(agent.id, sessionId, model) || changed;
    // Tool calls come several a second; the office redraws at most a few times a second.
    if (changed && !this.activityTimer) {
      this.activityTimer = setTimeout(() => {
        this.activityTimer = null;
        this.onChange("activity");
      }, 400);
      this.activityTimer.unref?.();
    }
    return { ok: true };
  }

  private activityOf(agentId: string, status: WorldAgent["status"]): Pick<WorldAgent, "doing" | "helpers"> {
    const { doing, helpers } = this.activity.of(agentId, this.now().getTime());
    // A tool line is only true while the agent works; herdr knows when it stopped.
    return { doing: status === "working" || status === "unknown" ? doing : null, helpers };
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

  /** What `inbox team` prints: who the agent is, its project and part in it, and what waits for it. */
  brief(session: SessionInput): TeamBrief {
    const me = this.resolve(session);
    const state = this.state();
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const teams = new Map(state.teams.map((t) => [t.id, t]));
    const team = me.teamId ? teams.get(me.teamId) ?? null : null;
    const status = (a: WorldAgent) => `${a.name}${a.role === "lead" ? " (lead)" : ""}: ${a.status}${a.doing ? `, ${a.doing}` : ""}`;
    const lines = [`You are ${me.name} (${me.harness}${me.cwd ? `, ${me.cwd}` : ""}).`];
    if (!team) {
      lines.push("You are not on a project: you work straight for the founder.");
    } else {
      const lead = state.agents.find((a) => a.teamId === team.id && a.role === "lead");
      lines.push(team.standing ? `Team: ${team.name}, a standing team.` : `Project: ${team.name}, in the worktree ${team.path} (branch ${team.branch ?? "unknown"}).`);
      const part = team.standing
        ? me.role === "lead" ? "You lead it: divide the work among your crew and keep them moving." : `${lead ? lead.name : "Its lead"} leads it and divides the work; take yours from them.`
        : me.role === "lead" ? `Your office name is ${me.name}. ${FIRST_MATE}` : `${lead ? lead.name : "Its first mate"} is its first mate: take your work from them and report back with \`inbox say ${lead?.name ?? "NAME"} "…"\`, not to the founder.`;
      lines.push(part);
      if (team.purpose) lines.push(`Purpose: ${team.purpose}`);
      lines.push(`On it: ${state.agents.filter((a) => a.teamId === team.id && a.id !== me.id).map(status).join("; ") || "just you"}.`);
      const next = team.handsTo ? teams.get(team.handsTo) : null;
      lines.push(next ? `Finished work goes to ${next.name}: inbox handoff "title" --summary "what was done, where, how to check it"` : "Finished work is not handed to another team.");
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
    if (others.length) lines.push(`Other projects and teams: ${others.map((t) => `${t.name}${t.purpose ? ` (${t.purpose})` : ""}`).join("; ")}.`);
    lines.push('Talk to anyone, agent or team, by name: inbox say NAME "text". Messages arrive in their terminal when they are free. Answer the founder with inbox say founder "text".');
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
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const notices = first ? [] : state.teams.filter((t) => t.status === "blocked" && before.get(t.id) !== "blocked");
    await Promise.all([
      ...notices.map((t) => this.source?.notify(`${t.name} is blocked`, `${whyStuck(t.blockedBy.flatMap((id) => agents.get(id) ?? []))}.`).catch(() => {})),
      this.messages.deliver(state),
    ]);
  }

  /** Running agents and inbox tasks, joined on their session and merged per identity. */
  private join(tasks: InboxState["tasks"]): Joined[] {
    const live = this.source?.live() ?? [];
    const out = new Map<string, Joined>();
    for (const a of live) {
      // A lead's crew shares its checkout, so an agent herdr knows by name is that name in the checkout.
      const base = `${identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId)}${a.name ? `@${a.name}` : ""}`;
      let identity = base;
      // Two unnamed agents in one checkout are two people.
      for (let n = 2; out.has(identity); n++) identity = `${base}#${n}`;
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

  /** What git says about a folder, asked again once a worktree it was in is removed. */
  private checkout(cwd: string): Checkout | null {
    const known = this.checkouts.get(cwd);
    if (known === undefined || (known && !existsSync(known.top))) this.checkouts.set(cwd, checkoutOf(cwd));
    return this.checkouts.get(cwd)!;
  }

  /** The teams, without projects whose worktree has gone: removed outside the office, the project is over. */
  teams(): Team[] {
    const teams = (this.db.prepare("SELECT * FROM teams ORDER BY standing DESC, created_at, name").all() as Row[]).map((r): Team => ({
      id: str(r.id),
      name: str(r.name),
      purpose: str(r.purpose),
      handsTo: r.hands_to == null ? null : str(r.hands_to),
      path: r.path == null ? null : str(r.path),
      branch: r.branch == null ? null : str(r.branch),
      standing: Boolean(r.standing),
      createdAt: str(r.created_at),
    }));
    const gone = teams.filter((t) => t.path && !existsSync(t.path));
    for (const t of gone) this.forget(t.id);
    return teams.filter((t) => !gone.includes(t));
  }

  /**
   * A new project: its own worktree beside the repository's main checkout, on a new branch from
   * the branch the main checkout is on, with a first mate started there who runs the crew. A standing
   * team is only named.
   */
  async createTeam(input: { name?: string; purpose?: string; handsTo?: string | null; repository?: string; standing?: boolean }): Promise<Team> {
    const name = this.teamName(input.name, null);
    const purpose = input.purpose?.trim() ?? "";
    const handsTo = input.handsTo ? this.team(input.handsTo).id : null;
    if (input.standing) {
      const team = this.insertTeam({ name, purpose, handsTo, path: null, branch: null, standing: true });
      this.onChange("world");
      return team;
    }
    const repositories = this.state().repositories;
    const repository = repositories.find((r) => r.root === input.repository) ?? (repositories.length === 1 && !input.repository ? repositories[0] : undefined) ?? this.mainCheckout(input.repository);
    if (!repository) throw new InboxError(400, "pick the repository the project works in");
    if (!this.source?.available()) throw new InboxError(409, "a project gets its worktree and lead through herdr, and herdr is not running");
    const place = placeFor(repository.root, name);
    if (!place) throw new InboxError(400, "start the project's name with a letter");
    if (existsSync(place.path)) throw new InboxError(409, `${place.path} already exists`);
    const base = checkoutOf(repository.root)?.branch ?? null;
    let paneId: string;
    try {
      ({ paneId } = await this.source.createWorktree(repository.root, { path: place.path, branch: place.branch, base, label: name }));
    } catch (err) {
      throw new InboxError(502, `herdr could not make the worktree: ${(err as Error).message}`);
    }
    const team = this.insertTeam({ name, purpose, handsTo, path: checkoutOf(place.path)?.top ?? place.path, branch: place.branch, standing: false });
    this.db.prepare("UPDATE teams SET lead_pane = ? WHERE id = ?").run(paneId, team.id);
    this.onChange("world");
    const next = handsTo ? this.team(handsTo).name : null;
    const brief = [
      `You run the project "${name}", working in this worktree (branch ${place.branch}, from ${base ?? "the main checkout"}).`,
      purpose ? `The project: ${purpose}` : "",
      FIRST_MATE,
      '`inbox team` shows your office name, your crew and what waits for you; `inbox say NAME "text"` reaches anyone in the office.',
      next ? `When the work is done, hand it to ${next} for review: inbox handoff "title" --summary "what was done, where, how to check it".` : "",
    ].filter(Boolean).join(" ");
    // The lead starts with only its brief, so herdr sees it ready for input; its first task follows as a prompt.
    try {
      await this.source.startAgent(paneId, `lead-${place.slug}`.slice(0, 32).replace(/-+$/, ""), "claude", [...FIRST_MATE_ARGS, "--append-system-prompt", brief]);
    } catch (err) {
      // herdr gave up waiting for it to look ready, but it may be running all the same: then the project is started.
      await this.source.refresh?.().catch(() => {});
      if (!this.source.live().some((a) => a.paneId === paneId && a.harness === "claude")) {
        throw new InboxError(502, `The worktree ${team.path} is made, but no first mate is running in it (herdr: ${(err as Error).message}). Start one there in herdr, or finish the project.`);
      }
    }
    if (purpose) await this.kickoff(team, paneId, `Start on the project: ${purpose}`);
    return team;
  }

  /**
   * A new lead's first task, typed once herdr sees it ready. One that cannot take it now, such as
   * a lead stopped at a question, gets it as your message instead, typed once it is free.
   */
  private async kickoff(team: Team, paneId: string, text: string): Promise<void> {
    try {
      await this.source!.prompt(paneId, text);
      return;
    } catch (err) {
      await this.source!.refresh?.().catch(() => {});
      const lead = this.state().agents.find((a) => a.paneId === paneId);
      if (!lead) throw new InboxError(502, `${team.name}'s first mate is starting but could not be given its first task (herdr: ${(err as Error).message}). Tell it in the office.`);
      this.messages.tell(lead.id, { text });
    }
  }

  private insertTeam(t: Omit<Team, "id" | "createdAt">): Team {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO teams (id, name, purpose, hands_to, path, branch, standing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, t.name, t.purpose, t.handsTo, t.path, t.branch, t.standing ? 1 : 0, this.now().toISOString());
    return this.team(id);
  }

  updateTeam(id: string, patch: { name?: string; purpose?: string; handsTo?: string | null }): Team {
    const team = this.team(id);
    const name = patch.name === undefined ? team.name : this.teamName(patch.name, id);
    if (patch.handsTo === id) throw new InboxError(400, "a team cannot hand its work to itself");
    if (patch.handsTo) this.team(patch.handsTo);
    this.db
      .prepare("UPDATE teams SET name = ?, purpose = ?, hands_to = ? WHERE id = ?")
      .run(name, patch.purpose === undefined ? team.purpose : patch.purpose.trim(), patch.handsTo === undefined ? team.handsTo : patch.handsTo, id);
    this.onChange("world");
    return this.team(id);
  }

  /** Agents address teams by name, so two teams never share one. */
  private teamName(value: string | undefined, id: string | null): string {
    const name = value?.trim();
    if (!name) throw new InboxError(400, "a project needs a name");
    if (this.teams().some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new InboxError(409, `there is already a project or team called ${name}`);
    return name;
  }

  /**
   * Finishes a project: closes the agents working in its worktree and removes the worktree, and
   * its branch once that is merged (an unmerged branch is kept, so no commit is lost). It refuses
   * while someone is working there or anything is uncommitted. A standing team is disbanded: its
   * members go back to the lounge.
   */
  async deleteTeam(id: string): Promise<{ ok: true; note: string }> {
    const team = this.team(id);
    if (this.db.prepare("SELECT 1 FROM work WHERE to_team_id = ? AND state = 'in_review'").get(id)) {
      throw new InboxError(409, `${team.name} still has work under review`);
    }
    const checkout = team.path ? checkoutOf(team.path) : null;
    if (!checkout) {
      this.forget(id);
      return { ok: true, note: team.standing ? `${team.name} is disbanded.` : `${team.name} is finished; its worktree was already gone.` };
    }
    const working = this.state().agents.filter((a) => a.teamId === id && a.status === "working");
    if (working.length) throw new InboxError(409, `${working.map((a) => a.name).join(" and ")} ${working.length === 1 ? "is" : "are"} still working on ${team.name}`);
    const changes = uncommitted(checkout.top);
    if (changes) throw new InboxError(409, `${changes} uncommitted ${changes === 1 ? "change" : "changes"} in ${checkout.top}: commit or discard ${changes === 1 ? "it" : "them"} first`);
    if (!this.source?.available()) throw new InboxError(409, "herdr closes the project's agents and removes its worktree, and herdr is not running");
    const inside = (cwd: string | null) => cwd === checkout.top || !!cwd?.startsWith(`${checkout.top}/`);
    let stopped: string[] = [];
    try {
      for (const a of this.source.live().filter((l) => inside(l.cwd))) await this.source.closePane(a.paneId);
      // Whatever still runs there (a dev server outlives its pane) would keep writing into the folder being removed.
      const left = processesIn(checkout.top);
      await stopProcesses(left);
      stopped = [...new Set(left.map((p) => p.command))];
      await this.source.removeWorktree(checkout.repoRoot, checkout.top);
    } catch (err) {
      throw new InboxError(502, `herdr could not remove ${checkout.top}: ${(err as Error).message}`);
    }
    const branch = team.branch ?? checkout.branch;
    const kept = branch ? unmerged(checkout.repoRoot, branch) : 0;
    const deleted = branch ? deleteMergedBranch(checkout.repoRoot, branch) : false;
    this.forget(id);
    const where = this.checkout(checkout.repoRoot)?.branch ?? "the main checkout";
    const about = !branch ? "" : deleted ? ` Branch ${branch} was merged and is deleted.` : ` Branch ${branch} is kept: ${kept} ${kept === 1 ? "commit is" : "commits are"} not in ${where} yet.`;
    const also = stopped.length ? ` Stopped what was still running there: ${stopped.join(", ")}.` : "";
    return { ok: true, note: `${team.name} is finished and ${checkout.top} removed.${also}${about}` };
  }

  /** Removes a team; anyone still on it goes back to the lounge with their name and face. */
  private forget(id: string): void {
    this.db.prepare("UPDATE world_agents SET team_id = NULL, role = 'member' WHERE team_id = ?").run(id);
    this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    this.onChange("world");
  }

  /** Renames an agent, or seats it in a team. A team has at most one lead. */
  /**
   * `takeName`: making it the lead also folds in the lead it replaces, which must not be running:
   * it takes that lead's name and what was said to it, and the old record goes.
   */
  updateAgent(id: string, patch: { name?: string; teamId?: string | null; role?: string; takeName?: boolean }): WorldAgent {
    const row = this.db.prepare("SELECT * FROM world_agents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no agent ${id}`);
    if (patch.takeName) return this.takeOver(row);
    if (patch.name !== undefined && !patch.name.trim()) throw new InboxError(400, "an agent needs a name");
    if (patch.name?.trim().toLowerCase() === FOUNDER) throw new InboxError(400, `"${FOUNDER}" is how agents address you`);
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

  private takeOver(row: Row): WorldAgent {
    const id = str(row.id);
    const agents = this.state().agents;
    const me = agents.find((a) => a.id === id);
    const teamId = row.team_id ? str(row.team_id) : null;
    if (!me || !teamId) throw new InboxError(409, "only someone on a project can take over its lead");
    const lead = agents.find((a) => a.teamId === teamId && a.role === "lead" && a.id !== id);
    if (!lead) throw new InboxError(409, `${me.name}'s project has no other lead whose name it could take`);
    if (lead.status !== "offline") throw new InboxError(409, `${lead.name} is running, so ${me.name} cannot take their place and name`);
    const fold = this.db.prepare("SELECT * FROM world_agents WHERE id = ?").get(lead.id) as Row;
    this.tx(() => this.seat(row, teamId, fold));
    this.onChange("world");
    return this.agent(id);
  }

  /**
   * Takes someone nobody runs out of the office. What it said and handed over keeps it as the
   * sender; messages still waiting for it are dropped. If it led a team, the team's longest-standing
   * running member leads it next. Refused while it runs, since herdr would bring it straight back.
   */
  removeAgent(id: string): void {
    const agent = this.agent(id);
    if (agent.paneId || agent.status !== "offline") {
      throw new InboxError(409, `${agent.name} is running in herdr. Close it there first; only someone nothing runs behind can be removed.`);
    }
    this.tx(() => {
      this.db.prepare("DELETE FROM message_deliveries WHERE agent_id = ? AND state != 'delivered'").run(id);
      this.db.prepare("UPDATE world_agents SET removed = 1, team_id = NULL, role = 'member' WHERE id = ?").run(id);
    });
    this.onChange("world");
  }

  agent(id: string): WorldAgent {
    const found = this.state().agents.find((a) => a.id === id);
    if (!found) throw new InboxError(404, `no agent ${id}`);
    return found;
  }

  private team(id: string): Team {
    const found = this.teams().find((t) => t.id === id);
    if (!found) throw new InboxError(404, `no team ${id}`);
    return found;
  }
}

/** Where a team stands: stuck when its lead is, or when someone is and nobody is still working. */
export function teamStatus(members: WorldAgent[]): { status: TeamStatus; blockedBy: string[] } {
  const stuck = members.filter((m) => m.status === "blocked" || m.waitingOnYou);
  const working = members.some((m) => m.status === "working" && !m.waitingOnYou);
  const leadStuck = stuck.some((m) => m.role === "lead");
  if (stuck.length && (leadStuck || !working)) return { status: "blocked", blockedBy: stuck.map((m) => m.id) };
  if (working) return { status: "working", blockedBy: [] };
  if (members.some((m) => m.status !== "offline")) return { status: "idle", blockedBy: [] };
  return { status: "offline", blockedBy: [] };
}

function identityOf(harness: Harness, cwd: string | null, fallback: string): string {
  return `${harness}:${cwd ?? fallback}`;
}

function splitIdentity(identity: string): [Harness, string | null] {
  const at = identity.indexOf(":");
  const rest = identity.slice(at + 1).replace(/#\d+$/, "").replace(/@[a-z][a-z0-9_-]*$/, "");
  return [identity.slice(0, at) as Harness, rest.startsWith("/") ? rest : null];
}
