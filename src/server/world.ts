// The office world's state rules: which agents exist, who they are across session restarts,
// which team each one is on, and where each team stands. An agent is whatever herdr sees
// running plus every inbox task not bound to a running agent. A team is a project's worktree:
// an agent working in a worktree is on that project, one of them leads it, and finishing the
// project removes the worktree. A standing team (Mission Control) has no worktree and keeps its
// members' desks while they are offline. What is said between them is kept and delivered by
// messages.ts, and a team becoming blocked is announced once.

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActivityEvent, AgentModel, AgentRole, Harness, InboxState, Presence, Repository, SessionInput, SwitchesView, Team, TeamBrief, TeamStatus, WorldAgent, WorldState,
} from "../shared/types.ts";
import { serviceUrl } from "../shared/agent-client.ts";
import { STORY_INTRO, STORY_MAX_CHARS, STORY_PROMPT, storyLine } from "../shared/story.ts";
import { Activity } from "./activity.ts";
import { ReviewFallback } from "./review-fallback.ts";
import { DEFAULT_LEAD, type CrewChoice } from "../shared/crewtree.ts";
import { startFlags, type CrewTreeStore } from "./crewtree.ts";
import { Adapters } from "./adapter.ts";
import { InboxError } from "./inbox.ts";
import { FOUNDER, Messages } from "./messages.ts";
import { Pipelines } from "./pipelines/store.ts";
import { Waivers } from "./pipelines/waiver.ts";
import { SessionFiles } from "./models.ts";
import { allocateName, NAMES } from "./names.ts";
import type { Usage } from "./usage.ts";
import { EFFORT_TIMEOUT_MS, Efforts } from "./effort.ts";
import type { EffortReport } from "../shared/types.ts";
import { whyStuck } from "../shared/stuck.ts";
import { Unpresented } from "./unpresented.ts";
import { LEAD_WATCH_SESSION, LeadWatch } from "./leadwatch.ts";
import { withOffline } from "../shared/waiting.ts";
import { checkoutOf, checkoutsIn, currentBranch, deleteMergedBranch, isProjectsFolder, linkedWorktrees, nameFor, placeFor, processesIn, stopProcesses, uncommitted, unmerged, type Checkout } from "./worktrees.ts";

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
type Joined = Omit<WorldAgent, "id" | "name" | "project" | "branch" | "teamId" | "role" | "waitingOnYou" | "doing" | "helpers" | "model" | "sessionName" | "ran"> & { sessionId: string | null };

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

const NONE: ReadonlySet<string> = new Set();

/** How long a pane opened for a team keeps its record while nothing runs there. */
const PANE_RECORD_LIFE_MS = 24 * 60 * 60 * 1000;

/** How long the folders beside known repositories are trusted before they are read again. */
const SCAN_CACHE_MS = 3000;

/** A first mate's model when the service has no crew tree: it plans, splits and supervises, which is the deep thinking. */
const FIRST_MATE_CHOICE: CrewChoice = DEFAULT_LEAD.use;

/** A string as one shell word. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Prose passed as an agent argument: herdr refuses shell words containing controls.
 * Keep word boundaries (including Unicode whitespace), strip other controls, and leave
 * quotes and Unicode intact: herdr, not this helper, does the shell quoting.
 */
export function briefArgument(text: string): string {
  return text.replace(/[\s\p{White_Space}]/gu, " ").replace(/\p{Cc}/gu, "").replace(/ +/g, " ").trim();
}

/** The CLI of the checkout the service runs from; a lead's pane need not have `inbox` on its PATH. */
export const INBOX_BIN = fileURLToPath(new URL("../../bin/inbox", import.meta.url));

/**
 * What a project's lead is, in the sense of firstmate (github.com/kunchenguid/firstmate): the
 * founder's one contact for the project, who runs a crew rather than doing the work itself.
 * Mission Control's lead is different: it dispatches a queue of comments to standing lanes.
 */
const FIRST_MATE = [
  "You are the project's first mate: the founder's one contact for it.",
  "You do not write the code yourself. Split the work into tasks, start a crew member for each in herdr, supervise them to completion, check what they deliver, and report plain outcomes.",
  "Start crew in this worktree:",
  `\`P=$(${quote(INBOX_BIN)} pane)\` opens a pane in your tab, laid out with the others as a grid, and prints its id (never split panes yourself);`,
  '`herdr agent start <name> --kind <kind> --pane "$P" -- <model>` starts a crew member in it (a unique lowercase name).',
  "Choose each member's harness, model and effort by the founder's crew guide, a decision tree they edit: `inbox crew` prints it with the exact start command for each choice, and `inbox team` prints it too. Read it before you start each member, not once, since it changes while you work: take the first rule whose \"when\" fits the task.",
  "Never any other kind or model: crew run only as Claude Code or Pi, which have the permissions set up. The crew guide also carries the founder's switch, which can turn one of the two off for a while (its subscription is running out): `inbox crew` says so, and shows only the commands that run on the other; never start the harness it says is switched off.",
  '`herdr agent prompt <name> "<task>"` gives it its task.',
  "Crew share this checkout, so give each one files of its own: put a `Writes: <globs>` line in its task (for example `Writes: src/server/qa*.ts, test/qa*`), and before you land its work run `inbox surface-check --writes \"<the same globs>\" --base <sha it started from> [--commit <sha>]` in the repository, which names every file changed outside them (exit 1); send each stray file back or to its owner.",
  'Tell each crew member to report to you with `inbox say <your office name> "…"` when done or stuck, and not to ask the founder; their reports arrive in your terminal.',
  "Ask for each report in six parts, so reports compare at a glance: Changed (files) / Why / Verified (commands with their result) / Left undone / Needs outside my surface / Questions.",
  "Do not answer acknowledgments or thanks, and tell your crew not to either; continue the work instead.",
  "Close a member's pane when its work is done: `herdr pane close <pane id>`. Done in herdr means a turn ended, not that it can go: never close one `inbox team` marks as a standing lane's session (recover the lane onto its replacement first, `inbox lane`), and see what still waits for it.",
  "Tell crew to close every browser they open: close its pages, `browser.close()` in a `finally`, one shared browser per task, and never leave a dev server's probe browser running; the office closes a headless browser left running (its script gone, or unused for 10 minutes) and tells you, and lists the ones still in use when they load the machine.",
  "Tell crew never to open a visible browser window: it makes the founder's screen jump to it. They use headless browsers (Playwright headless, which can still use the GPU with `--use-angle=metal`), and to show the founder a page they add it to the review inbox with `--page \"Label=URL\"`, never `open URL`; if a real window is unavoidable, `open -g URL` (macOS: in the background, without taking focus).",
  "Bring the founder only real decisions (`inbox decide`) and finished, checked increments they can look at (`inbox milestone`): present every visible step as soon as it is done, even if the project is not finished, with a milestone per visible step. Attach screenshots (`--screenshot`), pages to step through (`--page \"Label=URL\"`), or a video (`--video`). The office reminds you about commits you have not shown; if they are not ready, tell the founder why in one line with `inbox say founder`.",
  "When the whole team is idle, present finished work, ask for what you need with `inbox decide`, or tell the founder what happens next with `inbox say founder`; the office checks after five idle minutes and reminds you once until someone works again.",
  'Answer each message from the founder in one or two sentences with `inbox say founder "…"`, and follow up the same way when the job is done or something new happens, such as a crew member finishing.',
  "Ask a decision the way an engineer asks a colleague: the title is the question, the request says what you need and what happens if nobody answers, options read \"Label: consequence\", and the recommendation gives your pick and why; `inbox --help` has an example.",
].join(" ");

/**
 * Claude Code settings, for this session only, that run the inbox hook in a lead the office
 * starts, so the founder's answers reach it at its turn boundaries, and the inbox statusline, which
 * tells the office the plan's 5-hour and weekly use. Nothing is written to anyone's settings. The
 * hook is left out when the settings Claude Code reads there already run it (two hooks would hand
 * each reply over twice), and the statusline when they set one (the founder's own stays).
 */
export function hookSettings(cwd: string): string[] {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const files = [join(config, "settings.json"), join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]
    .flatMap((f) => (existsSync(f) ? [readFileSync(f, "utf8")] : []));
  const inbox = `INBOX_URL=${quote(serviceUrl())} ${quote(INBOX_BIN)}`;
  const hook = [{ hooks: [{ type: "command", command: `${inbox} hook claude` }] }];
  const settings = {
    ...(files.some((text) => /\bhook claude\b/.test(text)) ? {} : { hooks: { SessionStart: hook, UserPromptSubmit: hook, Stop: hook } }),
    ...(files.some((text) => /"statusLine"/.test(text)) ? {} : { statusLine: { type: "command", command: `${inbox} statusline` } }),
  };
  return Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : [];
}

export function agentId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 12);
}

export class World {
  private db: DatabaseSync;
  private source: AgentSource | null;
  private inbox: Inbox;
  private now: () => Date;
  private checkouts = new Map<string, Checkout | null>();
  private scanned = new Map<string, { at: number; found: ReturnType<typeof checkoutsIn> }>();
  /** The last status seen per team, so a team is announced when it becomes blocked, not while it stays so. */
  private announced: Map<string, TeamStatus> | null = null;
  readonly messages: Messages;
  readonly pipelines: Pipelines;
  /** Founder-only exact-SHA repair waivers; the service wires in the inbox. */
  readonly waivers: Waivers;
  /** The founder's crew tree; the service sets it. Leads read it, so an edit reaches them without a restart. */
  crew: CrewTreeStore | null = null;
  private activity = new Activity();
  private reviewFallback = new ReviewFallback(undefined, () => this.onChange("activity"));
  private efforts = new Efforts();
  /** Session files, for the model of an agent whose harness does not report it. */
  private files: SessionFiles;
  private activityTimer: NodeJS.Timeout | null = null;
  private adapters = new Adapters();
  private unpresented: Unpresented;
  /** Teams with no lead online while others wait on them; the founder is asked to make someone lead. */
  readonly leadWatch: LeadWatch;
  onChange: (reason: string) => void = () => {};
  /** The standing lanes ("project/lane") an agent is the registered running session of; the service wires it (standing.ts). */
  standingHolds: (agent: WorldAgent) => string[] = () => [];
  /** Panes the office does not see yet or any more: an agent being switched to another harness (switch.ts) sets them. */
  hiddenPanes: () => ReadonlySet<string> = () => NONE;
  /** Agents being switched to another harness, and what each can be switched to; switch.ts sets it. */
  switches: { view(agents: WorldAgent[]): SwitchesView } | null = null;
  /** The founder's subscription use; the service sets it. */
  usage: Usage | null = null;

  constructor(db: DatabaseSync, source: AgentSource | null, inbox: Inbox, now: () => Date = () => new Date(), files = new SessionFiles()) {
    this.db = db;
    this.unpresented = new Unpresented(db);
    this.source = source;
    this.inbox = inbox;
    this.now = now;
    this.files = files;
    this.messages = new Messages(db, source, () => this.state(), now, (redrawOnly) => this.onChange(redrawOnly ? "activity" : "world"));
    this.pipelines = new Pipelines(db, () => this.state(), { now, changed: () => this.onChange("world") });
    this.waivers = new Waivers(db, () => this.state(), now);
    this.waivers.changed = () => this.onChange("world");
    this.messages.pipelines = this.pipelines;
    this.leadWatch = new LeadWatch(db, now, {
      makeLead: (id) => { this.updateAgent(id, { role: "lead" }); },
      handOver: (teamId, from, to) => this.messages.handOverQueued(teamId, from, to),
      openRuns: (teamId) => (this.db.prepare("SELECT id, snapshot FROM pipeline_runs WHERE team_id = ?").all(teamId) as Row[])
        .filter((r) => (JSON.parse(str(r.snapshot)) as { state?: string }).state === "open").map((r) => this.pipelines.get(str(r.id))),
    });
  }

  state(): WorldState {
    const inbox = this.inbox();
    const agents = this.join(inbox.tasks);
    const projectOfTask = new Map(inbox.tasks.map((t) => [t.id, inbox.projects.find((p) => p.id === t.projectId)?.name ?? null]));
    const waitedOn = new Set(inbox.items.filter((i) => i.state === "needs_attention" && i.blocking).map((i) => i.taskId));
    const rows = new Map((this.db.prepare("SELECT * FROM world_agents").all() as Row[]).map((r) => [str(r.identity), r]));
    // Protect the whole snapshot before assigning any name: an old record may return beside a newcomer.
    // Tasks also reserve their agent's name; hidden panes (during a switch) are still running.
    const present = new Set([...agents.map((a) => a.identity), ...(this.source?.live() ?? []).map(liveIdentity)]);
    const protectedIds = new Set([...present].flatMap((identity) => rows.has(identity) ? [str(rows.get(identity)!.id)] : []));
    const lastSeenAt = this.now().toISOString();
    // One write for the snapshot, rather than one disk commit per visible agent.
    if (protectedIds.size) this.db.prepare(`UPDATE world_agents SET last_seen_at = ? WHERE id IN (${[...protectedIds].map(() => "?").join(",")})`)
      .run(lastSeenAt, ...protectedIds);
    for (const identity of present) {
      const row = rows.get(identity);
      if (row) row.last_seen_at = lastSeenAt;
    }
    for (const a of agents) if (!rows.has(a.identity)) rows.set(a.identity, this.register(a.identity, rows, protectedIds));
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
    // A worktree a team owns besides its own (a lane) puts the agent on that team instead, and is never made a project.
    for (const a of agents) {
      const row = rows.get(a.identity)!;
      const checkout = a.cwd ? this.checkout(a.cwd) : null;
      if (row.team_id || !checkout?.linked) continue;
      const team = teams.find((t) => t.path === checkout.top) ?? teams.find((t) => t.worktrees.includes(checkout.top)) ?? this.adopt(checkout, teams);
      this.db.prepare("UPDATE world_agents SET team_id = ?, role = 'member' WHERE id = ?").run(team.id, str(row.id));
      Object.assign(row, { team_id: team.id, role: "member" });
    }

    this.placeInOpenedPanes(agents, rows, teams);

    const seen = new Set(agents.map((a) => a.identity));
    this.seatLeads(agents, rows, seen);
    // A standing team keeps its members' desks, and a project its lead's, while they are neither running nor holding a task,
    // unless someone else runs in the same checkout: that one replaced them, so they leave (the record stays, unplaced).
    // A lead is stricter, as a standing team's lead often works in a main checkout other projects' agents run in: it leaves
    // only for a replacement on its own team. A project's offline lead is the other way round and stays while one of that
    // project's own members runs beside it, as that one may take its place and name.
    const running = new Map<string, Set<string>>();
    for (const a of agents) {
      if (!a.paneId || a.status === "offline" || !a.cwd) continue;
      const top = this.top(a.cwd);
      running.set(top, (running.get(top) ?? new Set()).add(str(rows.get(a.identity)?.team_id)));
    }
    for (const row of rows.values()) {
      const team = row.team_id ? teams.find((t) => t.id === row.team_id) : undefined;
      if (!team || row.removed || seen.has(str(row.identity)) || (!team.standing && row.role !== "lead")) continue;
      const [harness, cwd] = splitIdentity(str(row.identity));
      const beside = cwd ? running.get(this.top(cwd)) : undefined;
      if (beside && (row.role !== "lead" || team.standing === beside.has(team.id))) {
        this.db.prepare("UPDATE world_agents SET team_id = NULL, role = 'member' WHERE id = ?").run(str(row.id));
        Object.assign(row, { team_id: null, role: "member" });
        continue;
      }
      agents.push({ identity: str(row.identity), harness, cwd, status: "offline", title: null, paneId: null, taskIds: [], sessionId: null });
    }

    const sessions = new Map<string, string | null>();
    const world = agents.map(({ sessionId, ...a }): WorldAgent => {
      const row = rows.get(a.identity)!;
      sessions.set(str(row.id), sessionId);
      return {
        ...a,
        id: str(row.id),
        name: str(row.name),
        story: row.story ? str(row.story) : null,
        storyAsk: !row.story || (Number(row.story_prompt ?? 1) < STORY_PROMPT && Number(row.story_asked ?? 1) < STORY_PROMPT),
        project: (a.cwd ? this.checkout(a.cwd)?.repoName : null) ?? projectOfTask.get(a.taskIds[0] ?? "") ?? null,
        branch: (a.cwd ? this.checkout(a.cwd)?.branch : null) ?? null,
        teamId: row.team_id ? str(row.team_id) : null,
        role: str(row.role) as AgentRole,
        waitingOnYou: a.taskIds.some((t) => waitedOn.has(t)),
        ...this.activityOf(str(row.id), a.status),
        // What the harness reported wins; its own session file is the fallback, read lazily.
        model: this.activity.modelOf(str(row.id), sessionId) ?? this.files.modelOf(a.harness, sessionId, this.now().getTime(), a.cwd),
        sessionName: this.activity.sessionNameOf(str(row.id), sessionId),
        ...this.efforts.view(a.harness, sessionId, this.now().getTime()),
        ran: Boolean(row.ran_at),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    this.appointLeads(world, teams, rows);
    const work = this.messages.work();
    const now = this.now().getTime();
    for (const agent of world) agent.reviewExcerpt = this.reviewFallback.forAgent(agent, world, work, teams, now);

    return {
      agents: world,
      teams: teams.map((team) => ({ ...team, unpresentedCommits: team.standing ? 0 : this.unpresented.count(team.path), ...teamStatus(world.filter((a) => a.teamId === team.id)), stalled: this.leadWatch.stall(team.id) })),
      messages: withOffline(this.messages.list(), world, teams),
      withFounder: withOffline(this.messages.withFounder(), world, teams),
      work,
      repositories: this.repositories(world, teams),
      herdr: this.source?.available() ? "connected" : "unavailable",
      ...(this.switches ? { switches: this.switches.view(world) } : {}),
      ...(this.usage ? { usage: this.usage.view(world.map((a) => ({ ...a, sessionId: sessions.get(a.id) ?? null })), teams) } : {}),
    };
  }

  /**
   * An agent placed nowhere that runs in a pane someone on a team opened for its crew (`inbox pane`) joins that
   * team as a member, never its lead. This comes after the worktree rules, so an agent in a project's own worktree
   * or one of its lanes stays where they put it, and the checkout it works in becomes neither a lane nor a project.
   * A record goes once an agent runs in its pane, or a day after the pane was opened.
   */
  private placeInOpenedPanes(agents: Joined[], rows: Map<string, Row>, teams: Team[]): void {
    const cutoff = new Date(this.now().getTime() - PANE_RECORD_LIFE_MS).toISOString();
    this.db.prepare("DELETE FROM pane_teams WHERE opened_at < ?").run(cutoff);
    const opened = new Map((this.db.prepare("SELECT pane_id, team_id FROM pane_teams").all() as Row[]).map((r) => [str(r.pane_id), str(r.team_id)]));
    if (!opened.size) return;
    for (const a of agents) {
      if (!a.paneId || a.status === "offline" || !opened.has(a.paneId)) continue;
      const row = rows.get(a.identity)!;
      const teamId = opened.get(a.paneId)!;
      if (!row.team_id && teams.some((t) => t.id === teamId)) {
        this.db.prepare("UPDATE world_agents SET team_id = ?, role = 'member' WHERE id = ?").run(teamId, str(row.id));
        Object.assign(row, { team_id: teamId, role: "member" });
      }
      this.db.prepare("DELETE FROM pane_teams WHERE pane_id = ?").run(a.paneId);
    }
  }

  /**
   * `inbox pane` run by `session` opened `paneId`: whoever first runs there and is placed nowhere joins the caller's
   * team. Nothing is recorded for a caller on no team.
   */
  paneOpened(session: SessionInput, paneId: unknown): { recorded: boolean } {
    if (typeof paneId !== "string" || !paneId) throw new InboxError(400, "paneOpened needs the new pane's id");
    const team = this.resolve(session).teamId;
    if (!team) return { recorded: false };
    this.db.prepare("INSERT OR REPLACE INTO pane_teams (pane_id, team_id, opened_at) VALUES (?, ?, ?)").run(paneId, team, this.now().toISOString());
    this.onChange("world");
    return { recorded: true };
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

  /**
   * Every team with anyone on it has a lead: the one who has been on it longest, preferring someone running.
   * Someone working in one of its lanes is never appointed: they are crew, and only you make one lead.
   */
  private appointLeads(world: WorldAgent[], teams: Team[], rows: Map<string, Row>): void {
    const since = (a: WorldAgent) => str(rows.get(a.identity)?.first_seen_at);
    for (const team of teams) {
      const inLane = (a: WorldAgent) => !!a.cwd && team.worktrees.some((w) => a.cwd === w || a.cwd!.startsWith(`${w}/`));
      const members = world.filter((a) => a.teamId === team.id);
      const candidates = members.filter((a) => !inLane(a));
      if (!candidates.length || members.some((a) => a.role === "lead")) continue;
      const lead = [...candidates].sort((a, b) => Number(!a.paneId) - Number(!b.paneId) || since(a).localeCompare(since(b)))[0]!;
      this.db.prepare("UPDATE world_agents SET role = 'lead' WHERE id = ?").run(lead.id);
      lead.role = "lead";
    }
  }

  /**
   * The repositories a new project can be made in: those agents work in, then the other main
   * checkouts beside them, so a repository made today shows without anyone working in it yet.
   */
  private repositories(world: WorldAgent[], teams: Team[]): Repository[] {
    const known = new Map<string, Repository>();
    for (const cwd of [...world.map((a) => a.cwd), ...teams.flatMap((t) => [t.path, ...t.worktrees])]) {
      const checkout = cwd ? this.checkout(cwd) : null;
      if (checkout && !known.has(checkout.repoRoot)) known.set(checkout.repoRoot, this.repository(checkout.repoName, checkout.repoRoot, this.checkout(checkout.repoRoot)?.branch ?? null));
    }
    const beside = new Map<string, Repository>();
    for (const parent of new Set([...known.keys()].map((root) => dirname(root)))) {
      for (const found of this.siblings(parent)) if (!known.has(found.root)) beside.set(found.root, this.repository(found.name, found.root, found.branch));
    }
    const byName = (a: Repository, b: Repository) => a.name.localeCompare(b.name);
    return [...[...known.values()].sort(byName), ...[...beside.values()].sort(byName)];
  }

  /** The main checkouts in a folder, scanned at most once per few seconds: one level, never a walk. */
  private siblings(parent: string): ReturnType<typeof checkoutsIn> {
    const now = this.now().getTime();
    const cached = this.scanned.get(parent);
    if (cached && now - cached.at < SCAN_CACHE_MS) return cached.found;
    const found = isProjectsFolder(parent) ? checkoutsIn(parent) : [];
    this.scanned.set(parent, { at: now, found });
    return found;
  }

  private repository(name: string, root: string, base: string | null): Repository {
    const { adapter, problems } = this.adapters.read(root, name);
    return { name, root, base, adapter, adapterProblems: problems };
  }

  /** A repository nobody works in yet, named by the path of its main checkout. */
  private mainCheckout(path: string | undefined): Repository | undefined {
    const checkout = path && isAbsolute(path) ? checkoutOf(path) : null;
    if (!checkout || checkout.linked || checkout.top !== path) return undefined;
    return this.repository(checkout.repoName, checkout.repoRoot, checkout.branch);
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
   * What an agent's harness reports it doing, the model it runs and its session's name. An unknown session is
   * ignored rather than an error, since a hook must never get in an agent's way. `modelFor` is
   * asked for the model when the caller has to read it from somewhere, given the one known now.
   */
  report(session: SessionInput, events: ActivityEvent[], helperId: string | null = null, modelFor?: (known: AgentModel | null) => AgentModel | null): { ok: boolean } {
    if (!events.length && !helperId && !modelFor) return { ok: true };
    let agent: Pick<WorldAgent, "id" | "cwd">;
    try {
      agent = this.activityAgent(session);
    } catch {
      return { ok: false };
    }
    const now = this.now().getTime();
    if (helperId) this.activity.touchHelper(agent.id, helperId, now);
    let changed = false;
    for (const e of events) changed = this.activity.record(agent.id, e, now, agent.cwd) || changed;
    const sessionId = session.sessionId ?? null;
    const model = events.findLast((e) => e.kind === "model")?.model ?? modelFor?.(this.activity.modelOf(agent.id, sessionId)) ?? null;
    if (model?.id && model.label) changed = this.activity.setModel(agent.id, sessionId, model) || changed;
    const named = events.findLast((e) => e.kind === "session_name");
    if (named) changed = this.activity.setSessionName(agent.id, sessionId, typeof named.sessionName === "string" ? named.sessionName : null) || changed;
    if (sessionId && session.harness) for (const e of events) {
      if (e.kind === "effort" && e.effort) changed = this.efforts.report(session.harness, sessionId, e.effort, now) || changed;
    }
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

  setEffort(agentId: string, level: unknown) {
    const agent = this.state().agents.find((a) => a.id === agentId);
    const session = agent && this.join(this.inbox().tasks).find((a) => a.identity === agent.identity);
    if (!agent?.paneId || !session?.sessionId || !agent.capabilities?.changeEffort) throw new InboxError(409, "this agent has no session-only effort control");
    const result = this.efforts.request(agent.harness, session.sessionId, level, this.now().getTime());
    // Even if the integration disappears, a quiet office must redraw the unconfirmed failure.
    setTimeout(() => this.onChange("activity"), EFFORT_TIMEOUT_MS).unref();
    this.onChange("activity");
    return result;
  }

  /** The integration reports actual state and fetches only its own pending request. */
  pollEffort(session: SessionInput, report: EffortReport) {
    this.activityAgent(session);
    if (!session.harness || !session.sessionId) throw new InboxError(400, "effort control needs a session id and harness");
    this.report(session, [{ kind: "effort", effort: report }]);
    return { request: this.efforts.pending(session.harness, session.sessionId, this.now().getTime()) };
  }

  private activityOf(agentId: string, status: WorldAgent["status"]): Pick<WorldAgent, "doing" | "helpers"> {
    const { doing, helpers } = this.activity.of(agentId, this.now().getTime());
    // A tool line is only true while the agent works; herdr knows when it stopped.
    return { doing: status === "working" || status === "unknown" ? doing : null, helpers };
  }

  /** Activity and two-second effort polls need only the caller, not a drawing of the
   * whole office. Follow current presence (including duplicate identities and hidden
   * panes) and the persisted id: a harness switch can keep an id under a new identity.
   * First sightings and task-only callers still take the normal registration path. */
  private activityAgent(session: SessionInput): Pick<WorldAgent, "id" | "cwd"> {
    const live = this.join([]);
    const pane = session.paneId ?? live.find((a) => a.harness === session.harness && a.sessionId === session.sessionId)?.paneId;
    const agent = pane ? live.find((a) => a.paneId === pane) : undefined;
    if (agent) {
      const row = this.db.prepare("SELECT id FROM world_agents WHERE identity = ? AND removed = 0 AND ran_at IS NOT NULL")
        .get(agent.identity) as Row | undefined;
      if (row) return { id: str(row.id), cwd: agent.cwd };
    }
    return this.resolve(session);
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

  /** An agent writes only its own office note; never interpreted as HTML or Markdown. */
  setStory(session: SessionInput, text: unknown): { story: string } {
    if (typeof text !== "string") throw new InboxError(400, "story must be plain text");
    const story = Array.from(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, STORY_MAX_CHARS).join("");
    if (!story) throw new InboxError(400, "story must not be empty");
    if (!session || typeof session !== "object") throw new InboxError(400, "story needs the agent's session");
    const me = this.resolve(session);
    this.db.prepare("UPDATE world_agents SET story = ?, story_prompt = ? WHERE id = ?").run(story, STORY_PROMPT, me.id);
    this.onChange("world");
    return { story };
  }

  /**
   * The office telling a project's lead something it saw, such as a headless browser left running.
   * False when the project has no lead to tell.
   */
  tellLead(teamId: string, text: string): boolean {
    const lead = this.state().agents.find((a) => a.teamId === teamId && a.role === "lead");
    if (!lead) return false;
    this.messages.notice(lead.id, text);
    return true;
  }

  crewTree(): CrewTreeStore {
    if (!this.crew) throw new InboxError(404, "this service has no crew tree");
    return this.crew;
  }

  /** What `inbox team` prints: who the agent is, its project and part in it, and what waits for it. */
  brief(session: SessionInput): TeamBrief {
    const me = this.resolve(session);
    const state = this.state();
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const teams = new Map(state.teams.map((t) => [t.id, t]));
    const team = me.teamId ? teams.get(me.teamId) ?? null : null;
    const status = (a: WorldAgent) => {
      const holds = this.standingHolds(a);
      const waiting = holds.length ? this.messages.waitingFor(a.id) : 0;
      const standing = holds.length ? `, the standing ${holds.join(" and ")} session: do not close it${waiting ? `; ${waiting} ${waiting === 1 ? "message waits" : "messages wait"} for it` : ""}` : "";
      return `${a.name}${a.role === "lead" ? " (lead)" : ""}: ${a.status}${a.doing ? `, ${a.doing}` : ""}${standing}`;
    };
    const lines = [`You are ${me.name} (${me.harness}${me.cwd ? `, ${me.cwd}` : ""}).`];
    if (me.story) lines.push(storyLine(me.story));
    if (me.storyAsk) lines.push(STORY_INTRO);
    for (const stall of this.leadWatch.all().filter((st) => st.blockingAgentIds.includes(me.id))) {
      lines.push(`${stall.teamName} has no lead online${stall.leadName ? ` (${stall.leadName} is offline)` : ""}: what you are waiting on from it has waited ${Math.floor((this.now().getTime() - Date.parse(stall.since)) / 60_000)} min. The founder has been asked to make someone there lead.`);
    }
    if (!team) {
      lines.push("You are not on a project: you work straight for the founder.");
    } else {
      const lead = state.agents.find((a) => a.teamId === team.id && a.role === "lead");
      lines.push(team.standing ? `Team: ${team.name}, a standing team.` : `Project: ${team.name}, in the worktree ${team.path} (branch ${team.branch ?? "unknown"}).`);
      const part = team.standing
        ? me.role === "lead" ? "You lead it: divide the work among your crew and keep them moving." : `${lead ? lead.name : "Its lead"} leads it and divides the work; take yours from them.`
        : me.role === "lead" ? `Your office name is ${me.name}. ${FIRST_MATE}` : `${lead ? lead.name : "Its first mate"} is its first mate: take your work from them and report back with \`inbox say ${lead?.name ?? "NAME"} "…"\`, not to the founder.`;
      lines.push(part);
      lines.push(this.pipelines.brief(team.id, me.id));
      if (me.role === "lead" && !team.standing && this.crew) lines.push(this.crew.text());
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
    const watched = this.messages.watch(state);
    const changed = this.unpresented.tick(state, this.now().getTime(), (lead, text) => { this.messages.notice(lead, text); });
    const stalled = this.leadWatch.tick(state);
    if (changed || watched || stalled) this.onChange("activity"); // redraw only; do not recursively react
    const first = this.announced === null;
    const before = this.announced ?? new Map<string, TeamStatus>();
    this.announced = new Map(state.teams.map((t) => [t.id, t.status]));
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const notices = first ? [] : state.teams.filter((t) => t.status === "blocked" && before.get(t.id) !== "blocked");
    await Promise.all([
      ...notices.map((t) => this.source?.notify(`${t.name} is blocked`, `${whyStuck(t.blockedBy.flatMap((id) => agents.get(id) ?? []))}.`).catch(() => {})),
      this.messages.founderNotices.dispatch(this.source ? (title, body) => this.source!.notify(title, body) : null),
      this.messages.deliver(state),
    ]);
  }

  /** Running agents and inbox tasks, joined on their session and merged per identity. */
  private join(tasks: InboxState["tasks"]): Joined[] {
    const live = this.source?.live() ?? [];
    const out = new Map<string, Joined>();
    const hidden = this.hiddenPanes();
    for (const a of live) {
      if (hidden.has(a.paneId)) continue;
      const base = liveIdentity(a);
      let identity = base;
      // Two unnamed agents in one checkout are two people.
      for (let n = 2; out.has(identity); n++) identity = `${base}#${n}`;
      out.set(identity, { identity, harness: a.harness, cwd: a.cwd, status: a.status, title: a.title, paneId: a.paneId, taskIds: [], sessionId: a.sessionId });
    }
    for (const task of tasks) {
      // The office's own decisions (a stalled team's lead) are asked by nobody in the office.
      if (task.parked || (task.binding.harness === LEAD_WATCH_SESSION.harness && task.binding.sessionId === LEAD_WATCH_SESSION.sessionId)) continue;
      const byPane = task.presence ? [...out.values()].find((a) => a.paneId === task.presence!.paneId) : undefined;
      const identity = byPane?.identity ?? identityOf(task.binding.harness, task.binding.cwd, task.binding.sessionId);
      const agent = out.get(identity);
      if (agent) agent.taskIds.push(task.id);
      else out.set(identity, { identity, harness: task.binding.harness, cwd: task.binding.cwd, status: "offline", title: null, paneId: null, taskIds: [task.id], sessionId: task.binding.sessionId });
    }
    return [...out.values()];
  }

  private register(identity: string, known: Map<string, Row>, protectedIds: ReadonlySet<string>): Row {
    const start = parseInt(agentId(identity).slice(0, 8), 16) % NAMES.length;
    const { name, retired } = allocateName([...known.values()].map((r) => ({
      id: str(r.id), name: str(r.name), teamId: r.team_id ? str(r.team_id) : null,
      removed: Boolean(r.removed), lastSeenAt: str(r.last_seen_at),
    })), protectedIds, start, this.now().getTime());
    const at = this.now().toISOString();
    const row = { id: agentId(identity), identity, name, team_id: null, role: "member", first_seen_at: at, last_seen_at: at };
    // Retiring the old display name and giving it to the newcomer are one durable change.
    // Message senders remain agent ids, never names.
    this.tx(() => {
      if (retired) this.db.prepare("UPDATE world_agents SET name = ? WHERE id = ?").run(retired.name, retired.id);
      this.db.prepare("INSERT INTO world_agents (id, identity, name, role, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(row.id, identity, name, row.role, at, at);
    });
    if (retired) for (const old of known.values()) if (old.id === retired.id) old.name = retired.name;
    return row;
  }

  /** The top of the checkout a folder is in, or the folder itself when git knows nothing of it. */
  private top(cwd: string): string {
    return this.checkout(cwd)?.top ?? cwd;
  }

  /** What git says about a folder, asked again once a worktree it was in is removed; its branch is read fresh, as a checkout can switch. */
  private checkout(cwd: string): Checkout | null {
    const known = this.checkouts.get(cwd);
    if (known === undefined || (known && !existsSync(known.top))) this.checkouts.set(cwd, checkoutOf(cwd));
    const checkout = this.checkouts.get(cwd)!;
    return checkout && { ...checkout, branch: currentBranch(checkout) };
  }

  /**
   * The teams, without projects whose worktree has gone: removed outside the office, the project is over.
   * A lane whose folder has gone is let go the same way; only the record goes.
   */
  teams(): Team[] {
    const lanes = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT path, team_id FROM team_worktrees ORDER BY added_at, path").all() as Row[]) {
      if (!existsSync(str(r.path))) {
        this.db.prepare("DELETE FROM team_worktrees WHERE path = ?").run(str(r.path));
        continue;
      }
      lanes.set(str(r.team_id), [...(lanes.get(str(r.team_id)) ?? []), str(r.path)]);
    }
    const teams = (this.db.prepare("SELECT * FROM teams ORDER BY standing DESC, created_at, name").all() as Row[]).map((r): Team => ({
      id: str(r.id),
      name: str(r.name),
      purpose: str(r.purpose),
      handsTo: r.hands_to == null ? null : str(r.hands_to),
      path: r.path == null ? null : str(r.path),
      branch: r.branch == null ? null : str(r.branch),
      standing: Boolean(r.standing),
      worktrees: lanes.get(str(r.id)) ?? [],
      createdAt: str(r.created_at),
    }));
    const gone = teams.filter((t) => t.path && !existsSync(t.path));
    for (const t of gone) this.forget(t, { reason: "missing" });
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
      STORY_INTRO,
      this.pipelines.brief(team.id),
      '`inbox team` shows your office name, your crew and what waits for you; `inbox say NAME "text"` reaches anyone in the office.',
      next ? `When the work is done, hand it to ${next} for review: inbox handoff "title" --summary "what was done, where, how to check it".` : "",
    ].filter(Boolean).join(" ");
    // The lead starts with only its brief, so herdr sees it ready for input; its first task follows as a prompt.
    // What it runs on is the crew tree's lead choice under the founder's switch; both harnesses take the brief as an appended system prompt.
    const lead = this.crew?.lead() ?? FIRST_MATE_CHOICE;
    const harness = lead.harness as Harness;
    try {
      await this.source.startAgent(paneId, `lead-${place.slug}`.slice(0, 32).replace(/-+$/, ""), harness, [...startFlags(lead), ...(harness === "claude" ? hookSettings(place.path) : []), "--append-system-prompt", briefArgument(brief)]);
    } catch (err) {
      // herdr gave up waiting for it to look ready, but it may be running all the same: then the project is started.
      await this.source.refresh?.().catch(() => {});
      if (!this.source.live().some((a) => a.paneId === paneId && a.harness === harness)) {
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

  private insertTeam(t: Omit<Team, "id" | "createdAt" | "worktrees">): Team {
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

  /**
   * The worktrees a team owns and the ones it could own: the other linked worktrees of the
   * repositories it and its agents work in that no team owns yet.
   */
  worktrees(id: string): { worktrees: string[]; available: string[] } {
    const team = this.team(id);
    const owned = new Set(this.teams().flatMap((t) => [t.path, ...t.worktrees].filter((p): p is string => !!p)));
    const roots = new Set<string>();
    const cwds = [team.path, ...team.worktrees, ...this.state().agents.filter((a) => a.teamId === id).map((a) => a.cwd)];
    for (const cwd of cwds) {
      const checkout = cwd ? this.checkout(cwd) : null;
      if (checkout) roots.add(checkout.repoRoot);
    }
    const available = [...roots].flatMap(linkedWorktrees).filter((p) => !owned.has(p)).sort();
    return { worktrees: team.worktrees, available };
  }

  /**
   * Gives a team another worktree of its repository (a lane): an agent working there is on it as
   * a member. Nothing on disk changes. Refused for a worktree another team owns: merge that
   * project instead, so its agents and history come along.
   */
  addWorktree(id: string, path: unknown): Team {
    const team = this.team(id);
    if (typeof path !== "string" || !isAbsolute(path)) throw new InboxError(400, "name the worktree by its full path");
    const checkout = checkoutOf(path);
    if (!checkout) throw new InboxError(400, `${path} is not a git checkout`);
    if (!checkout.linked) throw new InboxError(400, `${checkout.top} is the repository's main checkout, not a worktree`);
    const top = checkout.top;
    const owner = this.teams().find((t) => t.path === top || t.worktrees.includes(top));
    if (owner?.id === id) throw new InboxError(409, `${team.name} already works in ${top}`);
    if (owner) {
      throw new InboxError(409, owner.path === top
        ? `${top} is ${owner.name}'s own worktree. To make it ${team.name}'s, merge ${owner.name} into ${team.name} (Edit ${owner.name}, then Merge into…).`
        : `${top} is already one of ${owner.name}'s worktrees; remove it there first`);
    }
    const repo = this.repoOf(team);
    if (repo && repo !== checkout.repoRoot) throw new InboxError(409, `${top} is in another repository than ${team.name}'s (${repo})`);
    this.db.prepare("INSERT INTO team_worktrees (path, team_id, added_at) VALUES (?, ?, ?)").run(top, id, this.now().toISOString());
    this.onChange("world");
    return this.team(id);
  }

  /** Lets a team's lane go. Only the record goes: the folder, its branch and whoever works there are left as they are. */
  removeWorktree(id: string, path: unknown): Team {
    const team = this.team(id);
    if (typeof path !== "string" || !team.worktrees.includes(path)) {
      throw new InboxError(team.path === path ? 409 : 404, team.path === path ? `${path} is ${team.name}'s own worktree; finish the project to remove it` : `${team.name} has no worktree ${String(path)}`);
    }
    this.db.prepare("DELETE FROM team_worktrees WHERE path = ? AND team_id = ?").run(path, id);
    this.onChange("world");
    return this.team(id);
  }

  /**
   * Folds a project into another team: its worktree (and its lanes) become the target's lanes, its
   * agents join the target as members, and what was said to it, handed over by it or to it follows.
   * Then the project is forgotten. Unlike finishing, nothing on disk is touched: no worktree,
   * branch, pane or process. Refused while work waits for its review, or for a standing team whose
   * lanes would be left without a team.
   */
  mergeTeam(id: string, into: unknown): { ok: true; note: string; team: Team } {
    const source = this.team(id);
    if (typeof into !== "string" || !into) throw new InboxError(400, "pick the project or team to merge into");
    const target = this.team(into);
    if (target.id === source.id) throw new InboxError(400, `${source.name} cannot be merged into itself`);
    const waiting = this.db.prepare("SELECT title FROM work WHERE to_team_id = ? AND state = 'in_review'").all(id) as Row[];
    if (waiting.length) {
      throw new InboxError(409, `${source.name} still has work to review (${waiting.map((w) => `"${str(w.title)}"`).join(", ")}). Its agents would lose track of it: review it first, then merge.`);
    }
    if (source.standing && source.worktrees.length) {
      throw new InboxError(409, `${source.name} is a standing team with worktrees of its own (${source.worktrees.join(", ")}). Remove them from ${source.name} first, or add them to ${target.name}, so none is left without a team.`);
    }
    const moving = [source.path, ...source.worktrees].filter((p): p is string => !!p);
    const repo = this.repoOf(target);
    const elsewhere = repo ? moving.find((p) => { const c = this.checkout(p); return c && c.repoRoot !== repo; }) : undefined;
    if (elsewhere) throw new InboxError(409, `${elsewhere} is in another repository than ${target.name}'s (${repo}), so it cannot be one of its worktrees`);
    const members = this.state().agents.filter((a) => a.teamId === id).map((a) => a.name);
    const at = this.now().toISOString();
    this.tx(() => {
      this.db.prepare("DELETE FROM team_worktrees WHERE team_id = ?").run(id);
      for (const p of moving) this.db.prepare("INSERT INTO team_worktrees (path, team_id, added_at) VALUES (?, ?, ?)").run(p, target.id, at);
      this.db.prepare("UPDATE world_agents SET team_id = ?, role = 'member' WHERE team_id = ?").run(target.id, id);
      this.db.prepare("UPDATE messages SET team_id = ? WHERE team_id = ?").run(target.id, id);
      this.db.prepare("UPDATE work SET from_team_id = ? WHERE from_team_id = ?").run(target.id, id);
      this.db.prepare("UPDATE work SET to_team_id = ? WHERE to_team_id = ?").run(target.id, id);
      this.db.prepare("UPDATE teams SET hands_to = NULL WHERE hands_to = ? AND id = ?").run(id, target.id);
      this.db.prepare("UPDATE teams SET hands_to = ? WHERE hands_to = ?").run(target.id, id);
      // Its runs stay its own, archived and listed in the target's Runs: never the target's to deliver.
      this.pipelines.archiveTeam(id, { reason: "merged", teamName: source.name, mergedInto: { teamId: target.id, teamName: target.name } });
      this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    });
    this.onChange("world");
    const where = moving.length ? ` ${moving.map((p) => basename(p)).join(" and ")} ${moving.length === 1 ? "is" : "are"} now ${target.name}'s, left on disk as ${moving.length === 1 ? "it was" : "they were"}.` : "";
    const who = members.length ? ` ${members.join(", ")} ${members.length === 1 ? "joins" : "join"} ${target.name} as ${members.length === 1 ? "a member" : "members"}.` : "";
    return { ok: true, note: `${source.name} is merged into ${target.name}.${where}${who}`, team: this.team(target.id) };
  }

  /** The repository a team works in, from its worktree or its lanes; null for a standing team without lanes. */
  private repoOf(team: Team): string | null {
    for (const p of [team.path, ...team.worktrees]) {
      const checkout = p ? this.checkout(p) : null;
      if (checkout) return checkout.repoRoot;
    }
    return null;
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
   * members go back to the lounge. Its lanes are never removed, only let go.
   */
  async deleteTeam(id: string): Promise<{ ok: true; note: string }> {
    const team = this.team(id);
    if (this.db.prepare("SELECT 1 FROM work WHERE to_team_id = ? AND state = 'in_review'").get(id)) {
      throw new InboxError(409, `${team.name} still has work under review`);
    }
    const checkout = team.path ? checkoutOf(team.path) : null;
    if (!checkout) {
      this.forget(team, { reason: "deleted" });
      return { ok: true, note: team.standing ? `${team.name} is disbanded.` : `${team.name} is finished; its worktree was already gone.` };
    }
    const working = this.state().agents.filter((a) => a.teamId === id && a.status === "working");
    if (working.length) throw new InboxError(409, `${working.map((a) => a.name).join(" and ")} ${working.length === 1 ? "is" : "are"} still working on ${team.name}`);
    const changes = uncommitted(checkout.top);
    if (changes) throw new InboxError(409, `${changes} uncommitted ${changes === 1 ? "change" : "changes"} in ${checkout.top}: commit or discard ${changes === 1 ? "it" : "them"} first`);
    if (!this.source?.available()) throw new InboxError(409, "herdr closes the project's agents and removes its worktree, and herdr is not running");
    const inside = (cwd: string | null) => cwd === checkout.top || !!cwd?.startsWith(`${checkout.top}/`);
    for (const a of this.state().agents.filter((x) => inside(x.cwd) && x.paneId)) {
      const why = this.standingGuard(a);
      if (why) throw new InboxError(409, `${team.name} cannot be finished: ${why}`);
    }
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
    this.forget(team, { reason: "deleted" });
    const where = this.checkout(checkout.repoRoot)?.branch ?? "the main checkout";
    const about = !branch ? "" : deleted ? ` Branch ${branch} was merged and is deleted.` : ` Branch ${branch} is kept: ${kept} ${kept === 1 ? "commit is" : "commits are"} not in ${where} yet.`;
    const also = stopped.length ? ` Stopped what was still running there: ${stopped.join(", ")}.` : "";
    return { ok: true, note: `${team.name} is finished and ${checkout.top} removed.${also}${about}` };
  }

  /**
   * Removes a team; anyone still on it goes back to the lounge with their name and face. Its
   * pipeline runs stay, archived: a team going (even a checkout seen missing) never erases history.
   */
  private forget(team: Team, why: { reason: "deleted" | "missing" }): void {
    const forget = () => {
      this.pipelines.archiveTeam(team.id, { reason: why.reason, teamName: team.name });
      this.db.prepare("UPDATE world_agents SET team_id = NULL, role = 'member' WHERE team_id = ?").run(team.id);
      this.db.prepare("DELETE FROM teams WHERE id = ?").run(team.id);
    };
    // teams() can be read inside another transaction.
    if (this.db.isTransaction) forget(); else this.tx(forget);
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
    if (patch.name !== undefined && (this.db.prepare("SELECT id, name FROM world_agents WHERE id != ?").all(id) as Row[])
      .some((other) => str(other.name).toLowerCase() === patch.name!.trim().toLowerCase())) {
      throw new InboxError(409, `there is already an agent called ${patch.name.trim()}`);
    }
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
    const held = this.standingGuard(agent);
    if (held) throw new InboxError(409, held);
    if (agent.paneId || agent.status !== "offline") {
      throw new InboxError(409, `${agent.name} is running in herdr. Close it there first; only someone nothing runs behind can be removed.`);
    }
    this.tx(() => {
      this.db.prepare("DELETE FROM message_deliveries WHERE agent_id = ? AND state != 'delivered'").run(id);
      this.db.prepare("UPDATE world_agents SET removed = 1, team_id = NULL, role = 'member' WHERE id = ?").run(id);
    });
    this.onChange("world");
  }

  /**
   * Why closing, removing or switching `agent` would cut a project's standing lane off, naming
   * what still waits for it; null when it holds none (a lane recovered onto a replacement is not its).
   */
  standingGuard(agent: WorldAgent): string | null {
    const holds = this.standingHolds(agent);
    if (!holds.length) return null;
    const waiting = this.messages.waitingFor(agent.id);
    return `${agent.name} is the standing ${holds.join(" and ")} session${waiting ? ` and ${waiting} ${waiting === 1 ? "message waits" : "messages wait"} for it` : ""}; recover the lane onto its replacement first (inbox lane recover)`;
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

/** Who a running agent is. A lead's crew shares its checkout, so an agent herdr knows by name is that name in the checkout. */
export function liveIdentity(a: Pick<LiveAgent, "harness" | "cwd" | "sessionId" | "paneId" | "name">): string {
  return `${identityOf(a.harness, a.cwd, a.sessionId ?? a.paneId)}${a.name ? `@${a.name}` : ""}`;
}

function identityOf(harness: Harness, cwd: string | null, fallback: string): string {
  return `${harness}:${cwd ?? fallback}`;
}

function splitIdentity(identity: string): [Harness, string | null] {
  const at = identity.indexOf(":");
  const rest = identity.slice(at + 1).replace(/#\d+$/, "").replace(/@[a-z][a-z0-9_-]*$/, "");
  return [identity.slice(0, at) as Harness, rest.startsWith("/") ? rest : null];
}
