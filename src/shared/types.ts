// The domain the service, the UI and the agent CLI share. Agent protocol payloads are the
// `*Input` types; everything else is what the service returns.

export const ITEM_TYPES = ["decide", "try", "milestone"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Human attention, not task progress: an agent can keep working while an item waits. */
export const ITEM_STATES = ["needs_attention", "answer_queued", "delivered", "resolved", "snoozed", "withdrawn"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** `stale`: the item changed after this answer was written, so it is held, never delivered. */
export const REPLY_STATES = ["queued", "delivered", "failed", "stale"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

/** What the user did. `accept` / `request_changes` answer a milestone or a try-it request (Approve /
 * Needs changes), `choose` a decision, `answer` an open question (a decision with no options); `discuss` is free conversation on any type. `tried` is what a
 * try-it request used to be answered with: old replies keep it and stay readable, but it is no longer
 * accepted. */
export const REPLY_ACTIONS = ["choose", "answer", "accept", "request_changes", "tried", "discuss"] as const;
export type ReplyAction = (typeof REPLY_ACTIONS)[number];

export const HARNESSES = ["pi", "claude", "codex", "manual"] as const;
export type Harness = (typeof HARNESSES)[number];

/** How a reply reaches the owning conversation. */
export type ReplyDelivery =
  | "live" // pushed into the running session
  | "boundary" // handed over at the session's next turn boundary (hook)
  | "pull" // the agent must ask for it (`inbox replies`)
  | "none";

export interface Capabilities {
  submit: boolean;
  reply: ReplyDelivery;
  /** The agent confirms receipt, so "Delivered" is a fact rather than a hope. */
  ack: boolean;
  /** Bring the owning conversation to the front (via herdr when the session runs in a pane). */
  openConversation: boolean;
  openPreview: boolean;
  /** Session-only control, advertised by a live integration, with its accepted levels. */
  changeEffort?: { levels: string[] };
  effortUnavailable?: string;
}

/** Live facts about a session from the terminal multiplexer, when it runs in one. */
export interface Presence {
  source: "herdr";
  paneId: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
  name: string | null;
  title: string | null;
  seenAt: string;
}

export interface Binding {
  harness: Harness;
  /** Stable session identity: a Pi session file, a Claude session UUID or a Codex thread id. */
  sessionId: string;
  cwd: string | null;
}

export interface Project {
  id: string;
  name: string;
  root: string | null;
  objective: string;
  pinned: boolean;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  activity: string;
  nextMilestone: string;
  lastDecision: string;
  lastAcceptedMilestone: string;
  parked: boolean;
  binding: Binding;
  capabilities: Capabilities;
  presence: Presence | null;
  createdAt: string;
  updatedAt: string;
}

export interface Option {
  id: string;
  label: string;
  consequence: string;
}

export interface Preview {
  url: string;
  viewport: "desktop" | "phone" | null;
  setup: string;
}

/** One step of a walkthrough: a live page to look at, and what to look for on it. */
export interface Page {
  url: string;
  label: string;
  /** What to look at on this page; empty when the label says it. */
  look: string;
}

/** Whether a page answers now, and whether it lets the office frame it (null: not known). */
export interface PageCheck {
  reachable: boolean;
  status: number | null;
  framable: boolean | null;
  /** The page is the Review Inbox's own app, which is never shown inside itself. */
  own: boolean;
  checkedAt: string;
}

export type EvidenceKind = "image" | "video" | "url" | "document";

export interface Evidence {
  id: string;
  itemId: string;
  revision: number;
  kind: EvidenceKind;
  /** Served by the service for stored attachments, or the external URL. */
  href: string;
  caption: string;
  capturedAt: string;
  sourceRevision: string;
}

export interface Item {
  /** Worktree HEAD when this revision was put in front of the founder. */
  presentedHead?: string | null;
  id: string;
  taskId: string;
  key: string;
  type: ItemType;
  revision: number;
  title: string;
  request: string;
  context: string;
  recommendation: string;
  options: Option[];
  check: string;
  preview: Preview | null;
  /** The pages to go through, in order. An item with only a preview has that one page. */
  pages: Page[];
  /** The agent is waiting on this answer, rather than carrying on with other work. */
  blocking: boolean;
  state: ItemState;
  snoozedUntil: string | null;
  /** When the founder put this item at the back of the queue; null if they have not. It still needs them. */
  backedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Reply {
  id: string;
  itemId: string;
  revision: number;
  action: ReplyAction;
  choice: string | null;
  text: string;
  /** Images you attached: upload ids, served at /uploads/<id>. */
  images: string[];
  state: ReplyState;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** Who answered: the founder, Approve all, or the QA agent on the founder's behalf. Absent from older services. */
  answeredBy?: AnsweredBy;
  /** A founder answer that overrides the QA agent's answer to the same revision. */
  overridesQa?: boolean;
}

export type AnsweredBy = "founder" | "approve_all" | "qa_agent";

export interface HistoryEvent {
  id: number;
  at: string;
  actor: "user" | "agent" | "system";
  taskId: string | null;
  itemId: string | null;
  kind: string;
  detail: Record<string, unknown>;
}

export interface ItemSummary extends Item {
  evidenceCount: number;
  /** Videos attached to the current revision. */
  videoCount?: number;
  thumbnail: string | null;
  lastReply: Reply | null;
  /** The QA agent has this item now, so it is out of Needs you; it comes back when the QA agent is offline or QA answers are off. */
  withQa?: boolean;
}

export interface InboxState {
  projects: Project[];
  tasks: Task[];
  items: ItemSummary[];
  herdr: "connected" | "unavailable";
}

export interface ItemDetail {
  item: Item;
  task: Task;
  project: Project;
  evidence: Evidence[];
  replies: Reply[];
  history: HistoryEvent[];
  /** Present when a pipeline run presented this revision for its "Founder approves" step. Approve-all never
   * answers it; only the founder's own Accept counts, and a later message does not withdraw it. */
  pipelineApproval?: { runId: string; accepted: boolean };
  /** The QA agent has this item now (see ItemSummary.withQa). */
  withQa?: boolean;
  /** What the QA agent predicted in manual mode, only for revisions the founder has already answered, so it never biases them. */
  qaPredictions?: QaPrediction[];
}

// ── Inbox automation: Approve all, or the QA agent answering on the founder's behalf ─────────

export const AUTOMATION_MODES = ["off", "approve_all", "qa"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export interface AutoApproveState {
  /** Approve all is on (kept for older clients; `mode` says which automation runs). */
  enabled: boolean;
  /** Revisions Approve all has answered, over its lifetime. */
  count: number;
  mode: AutomationMode;
  /** The QA agent, when one is chosen (whatever the mode). */
  qa: QaSummary | null;
}

export interface QaSummary {
  agentId: string;
  /** Null when the office no longer knows that agent. */
  agentName: string | null;
  online: boolean;
  /** Items the QA agent has now, out of Needs you. Zero whenever it is offline or QA answers are off. */
  withQa: number;
  /** Revisions it answered, and how many of those the founder overrode, over its lifetime. */
  answered: number;
  overridden: number;
  /** Manual mode: revisions it predicted; of those the founder has answered, how many it judged and agreed with; words still to judge. */
  predicted?: number;
  judged?: number;
  agreed?: number;
  toJudge?: number;
}

/** What `inbox qa next` hands the QA agent: one question, and where the learnings are. */
export interface QaNext {
  item: (Item & { project: string; taskTitle: string }) | null;
  /** Questions it has now, including this one. */
  waiting: number;
  /** Founder answers it has not learned from yet (`inbox qa answers`). */
  toLearn: number;
  learnings: string;
  /** Manual mode: an answer is recorded only as a prediction of the founder's, never sent. Absent from older services. */
  predicting?: boolean;
}

/** A founder answer the QA agent learns from. Approve-all and QA answers are never in this feed. */
export interface FounderAnswer {
  /** The event id; `inbox qa learned --through` it once learned. */
  seq: number;
  at: string;
  itemId: string;
  revision: number;
  project: string;
  itemType: ItemType;
  title: string;
  request: string;
  recommendation: string;
  options: Option[];
  action: ReplyAction;
  choice: string | null;
  choiceLabel: string | null;
  text: string;
  /** The QA agent's answer this one overrode, with the learnings it cited. */
  overrode: { action: ReplyAction; choice: string | null; learnings: string[] } | null;
  /** What the QA agent predicted for this revision in manual mode (never sent), and how it compares. Absent from older services. */
  predicted?: QaPrediction | null;
}

/** In manual mode the QA agent's answer is only a prediction of the founder's: never a reply, never delivered. */
export interface QaPrediction {
  predicted: true;
  itemId: string;
  revision: number;
  action: "choose" | "answer" | "accept" | "request_changes";
  choice: string | null;
  text: string;
  reason: string;
  learnings: string[];
  at: string;
  /** Null until the founder answers that revision. Same action and choice (or both accept, or both request changes) is a
   * match; two answers in words need the QA agent's judgement (`inbox qa judge`) until it records one. */
  verdict: QaVerdict | null;
}

export type QaVerdict = "match" | "mismatch" | "needs_judging";

// ── Agent protocol inputs ────────────────────────────────────────────────────────────────

export interface SessionInput {
  harness?: Harness;
  sessionId?: string;
  cwd?: string;
  /** herdr pane, used to resolve harness and session when the caller cannot name them. */
  paneId?: string;
}

export interface EvidenceInput {
  kind?: EvidenceKind;
  /** A local file the agent explicitly attaches; the service copies it into its own storage. */
  path?: string;
  url?: string;
  caption?: string;
  sourceRevision?: string;
}

export interface SubmitInput {
  session: SessionInput;
  project?: { name?: string; root?: string; objective?: string };
  task?: { title?: string; objective?: string };
  item: {
    /** Stable per task: resubmitting a key revises that item instead of adding a duplicate. */
    key?: string;
    type: ItemType;
    title: string;
    request?: string;
    context?: string;
    recommendation?: string;
    options?: Array<string | Partial<Option>>;
    check?: string;
    preview?: Partial<Preview> | string;
    /** A walkthrough: "Label=URL" or {url, label, look}, in the order to go through them. */
    pages?: Array<string | Partial<Page>>;
    blocking?: boolean;
    evidence?: EvidenceInput[];
  };
}

export interface SubmitResult {
  itemId: string;
  taskId: string;
  revision: number;
  /** false when an identical resubmission changed nothing. */
  changed: boolean;
  /** Things the agent should know now, e.g. a page that will not show inline. */
  warnings?: string[];
}

export interface ActivityInput {
  session: SessionInput;
  activity?: string;
  nextMilestone?: string;
  title?: string;
}

/** What an agent receives: the answer plus enough of the question to act on it alone. */
export interface PendingReply {
  deliveryId: string;
  itemId: string;
  itemKey: string;
  itemTitle: string;
  itemType: ItemType;
  revision: number;
  action: ReplyAction;
  choice: string | null;
  choiceLabel: string | null;
  text: string;
  /** Absolute paths of the images you attached, for the agent to read. */
  images: string[];
  createdAt: string;
  /** Absent means the founder (older services did not say). */
  answeredBy?: AnsweredBy;
  overridesQa?: boolean;
}

// ── The office world ─────────────────────────────────────────────────────────────────────

/**
 * The agents working on one project. A project is a git worktree: every agent working in it is
 * on the project, and finishing the project removes the worktree. A standing team, such as
 * Mission Control, has no worktree of its own: its agents keep their own checkouts and it is
 * never finished. Every team with anyone in it has one lead, who divides the work.
 */
export interface Team {
  id: string;
  name: string;
  /** What the project is for, in your words. Every agent on it is told this. */
  purpose: string;
  /** The team its finished work goes to for review. */
  handsTo: string | null;
  /** The worktree checkout; null for a standing team. */
  path: string | null;
  branch: string | null;
  standing: boolean;
  /** Worktrees it owns besides its own (its lanes): an agent working in one is on it, and finishing it never removes one. */
  worktrees: string[];
  createdAt: string;
}

export type AgentRole = "lead" | "member";

/**
 * One agent as the office shows it. Its identity is the harness plus the checkout it works in,
 * not the session, so a lane keeps its name, face and desk when its session is restarted.
 */
export interface WorldAgent {
  /** Short stable id derived from the identity, safe in URLs. */
  id: string;
  identity: string;
  name: string;
  /** The agent's own plain-text backstory; absent until it writes one. */
  story?: string | null;
  /** The office still asks this agent for its story: it has none, or one under an older prompt it was not yet asked to retell. */
  storyAsk?: boolean;
  harness: Harness;
  cwd: string | null;
  /** The repository the checkout belongs to. */
  project: string | null;
  /** The branch git says its checkout is on; null without a checkout, or on a detached HEAD. */
  branch: string | null;
  status: Presence["status"] | "offline";
  title: string | null;
  paneId: string | null;
  /** Inbox tasks of this agent: their items are what it queues at your desk with. */
  taskIds: string[];
  teamId: string | null;
  role: AgentRole;
  /** It has asked you something in the inbox and says it cannot go on until you answer. */
  waitingOnYou: boolean;
  /** What it is doing right now, from its harness's own events: "Bash: npm test". */
  doing: string | null;
  /** Sub-agents it has running, such as reviewers. */
  helpers: Helper[];
  /** Server-selected safe projector code while reviewing; a reported helper read wins. */
  reviewExcerpt?: ReviewExcerpt | null;
  /** The model its harness last reported for this session; null when it has not said. */
  model: AgentModel | null;
  capabilities?: Pick<Capabilities, "changeEffort" | "effortUnavailable">;
  effort?: AgentEffort;
  /** The name its session goes by in its own harness (Pi's session name, shown in its title), as the harness reported it; null when it has not said. */
  sessionName: string | null;
  /** It has been seen running in herdr; a record that never has is a name with nobody behind it. */
  ran: boolean;
}

/** Reported level stays separate from a requested change until the session acknowledges it. */
export interface AgentEffort {
  current: string | null;
  request: { id: string; level: string; state: "pending" | "confirmed" | "failed"; error?: string } | null;
}
export interface EffortReport {
  current: string;
  levels: string[];
  result?: { id: string; error?: string };
}

/** A model as the harness names it: its own id, and a short label to show. */
export interface AgentModel {
  /** "claude-opus-5-5", or Pi's "anthropic/claude-opus-5-5". */
  id: string;
  /** "Opus 5.5". */
  label: string;
}

/** Reported by an agent's harness to POST /api/agent/events. */
export interface ActivityEvent {
  kind: "tool" | "tool_end" | "idle" | "helper_start" | "helper_stop" | "model" | "session_name" | "effort";
  tool?: string;
  input?: Record<string, unknown>;
  /** The harness's id for one tool call, so its end can be matched to its start. */
  callId?: string;
  helperId?: string;
  helperType?: string;
  /** For "model": the model the harness runs now. */
  model?: AgentModel;
  /** For "session_name": the session's name in its harness now; null or empty when it has none. */
  sessionName?: string | null;
  /** For "effort": read back from the running session, not an assumed setting. */
  effort?: EffortReport;
}

/** A sub-agent working for an agent while it runs. */
export interface Helper {
  id: string;
  /** Its kind, such as "architecture-reviewer". */
  type: string;
  startedAt: string;
  /** Safe, checkout-relative source last viewed by this helper; prepared by the service. */
  excerpt?: ReviewExcerpt | null;
}

export interface ReviewExcerpt {
  /** Event time, for choosing the last read when several reviewers run. */
  viewedAt?: number;
  path: string;
  startLine: number;
  lines: string[];
}

/**
 * Where a team stands, as one word. `blocked` means the team cannot go on without you: its
 * lead is stuck, or someone is and nobody else is still working.
 */
export type TeamStatus = "blocked" | "working" | "idle" | "offline";

export interface WorldTeam extends Team {
  /** Branch commits outside base and the most recently presented HEAD. */
  unpresentedCommits?: number;
  status: TeamStatus;
  /** Who holds the team up, when it is blocked. */
  blockedBy: string[];
  /** Its lead is offline (or it has none) while others have waited on it past the threshold; null otherwise. */
  stalled?: TeamStall | null;
}

/** A team nobody can move: no lead online, and something has waited on it for ten minutes or more (leadwatch.ts). */
export interface TeamStall {
  teamId: string;
  teamName: string;
  /** The offline lead; null when the team has none. */
  leadId: string | null;
  leadName: string | null;
  /** When the oldest thing still waiting on it started waiting (ISO). */
  since: string;
  /** How many things wait: queued messages to its lead, work handed to it for review, pipeline steps reported to its lead. */
  waiting: number;
  /** Who is held up, as the founder reads it: other teams by name, agents by name, and "you" for your own messages. */
  blocking: string[];
  blockingAgentIds: string[];
  /** Its other members, running first: who the founder can make lead. */
  candidates: Array<{ id: string; name: string; running: boolean }>;
}

/** A repository agents work in, where a new project's worktree can be made. */
export interface Repository {
  name: string;
  root: string;
  /** The branch its main checkout is on, which a new project's branch starts from. */
  base: string | null;
  /** What the project says about itself in `orchestrator.json` at its main checkout; null without one, or when it is invalid. */
  adapter: ProjectAdapter | null;
  /** What is wrong with `orchestrator.json`: why it was not read, or keys it ignored. */
  adapterProblems: string[];
}

/**
 * A project's own description, read from `orchestrator.json` in its main checkout: the boundary
 * between the orchestration here and the project (docs/ORCHESTRATION.md). No project code runs here;
 * commands are named for agents' briefs, never run by the service.
 */
export interface ProjectAdapter {
  /** The key in `/api/p/:project`; the repository's folder name when the file does not say. */
  project: string;
  /** Where work lands. */
  integrationBranch: string | null;
  /** Where the project's pages are served, e.g. "http://localhost:3000". */
  preview: { base: string } | null;
  comments: { kinds: string[]; anchor: string[]; charter: string | null; leaseMinutes: number | null } | null;
  decisions: { maxQuestion: number | null } | null;
  /** Check commands by tier ("changed", "full", "release"). */
  checks: Record<string, string>;
  reviewers: { perSlice: string[]; cap: string | null } | null;
  land: { mode: string | null; publish: string | null; setup: string | null } | null;
  /** The project's standing agents, by the names its own tools use. */
  lanes: AdapterLane[];
}

/** One of a project's standing lanes as the office sees it: the adapter's name joined to an agent. */
export interface Lane {
  name: string;
  role: string | null;
  /** The office agent behind it; null when nobody matching runs or ever ran. */
  agentId: string | null;
  agentName: string | null;
  harness: Harness | null;
  model: string | null;
  state: "idle" | "working" | "blocked" | "held" | "conflict" | "offline";
  doing: string | null;
  branch: string | null;
  /** Ids of the comments it holds (filled once comments live here). */
  carrying: string[];
  why: string | null;
}

/** GET /api/p/:project/queue: who works the project's queue, and how the queue stands. */
export interface ProjectQueue {
  project: string;
  lanes: Lane[];
  counts: { waiting: number; assigned: number; working: number; held: number; fixed: number };
  held: unknown[];
  paused: boolean;
}

export interface AdapterLane {
  name: string;
  /** Absolute path of the checkout it works in (given relative to the main checkout). */
  worktree: string | null;
  /** The agent's own name, when that differs from `name`: herdr's name for it, or its Pi session name. Matched exactly. */
  agent: string | null;
  harness: Harness | null;
  model: string | null;
  /** "router" for the one that routes comments (Mission Control); otherwise a worker. */
  role: string | null;
  /**
   * The project's own command for its standing session, as argv: the office runs it with
   * `--status --json` to check the lane and `--recover ...` only on an explicit Recover
   * (docs/ORCHESTRATION.md). Null when the lane declares none.
   */
  attach: string[] | null;
}

/** What a lane's attach command answered, by its exit code and its last line of JSON. */
export interface AttachReport {
  state: "connected" | "disconnected" | "busy" | "unavailable" | "refused" | "failed";
  reason: string;
  /** The session the project registered for the lane. */
  registered: { session: string; pane: string | null } | null;
  companion: { pid: number; fresh: boolean; log: string | null } | null;
  /** The registered session's last completed turn, as the project reports it: not proof of any particular work. */
  progressAt: string | null;
  /** On recover: whether anything was written or started. */
  changed: boolean;
}

/** The founder's last explicit recovery of a lane, held only while the service runs. */
export interface LaneRecovery {
  /** `attached`: a status run started after the attach shows that session connected, in that pane and checkout, with a fresh heartbeat. */
  state: "running" | "attached" | "busy" | "unavailable" | "refused" | "failed";
  agentId: string;
  agentName: string;
  session: string;
  pane: string;
  at: string;
  reason: string | null;
  /** The companion's log, when the command named one for a failure. */
  log: string | null;
}

/** GET /api/lanes: a standing lane with an attach command, as the project and the office both see it. */
export interface StandingLane {
  project: string;
  lane: string;
  repository: string;
  worktree: string;
  /** `connected` only when the project says so and the office sees that exact session running; `unknown` is never treated as gone. */
  state: "checking" | "connected" | "disconnected" | "busy" | "unknown";
  reason: string | null;
  checkedAt: string | null;
  registered: {
    session: string;
    pane: string | null;
    agentId: string | null;
    agentName: string | null;
    teamName: string | null;
    role: AgentRole | null;
    running: boolean;
  } | null;
  companionPid: number | null;
  /** The registered session's last completed turn, when the project reports one; informational only. */
  lastTurnAt: string | null;
  /** Running agents in the lane's worktree a recovery may name, leads first. Nobody is made lead by it. */
  candidates: { agentId: string; name: string; teamName: string | null; role: AgentRole; harness: Harness }[];
  recovery: LaneRecovery | null;
}

export const DELIVERY_STATES = ["queued", "sending", "delivered", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/**
 * `instruction`: from you to a team. `message`: one agent to another agent or team.
 * `handoff`: finished work passed to a team to review. `review`: that team's verdict,
 * back to whoever handed it over.
 */
export const MESSAGE_KINDS = ["instruction", "message", "handoff", "review"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface Delivery {
  agentId: string;
  state: DeliveryState;
  error: string | null;
  updatedAt: string;
  /** While queued for an agent that is offline: who, worded for the sender ("Mission Control's lead (Alma)"). */
  offline?: string;
}

/** Something said in the office, and how it reached each agent it was meant for. */
export interface Message {
  id: string;
  kind: MessageKind;
  /** null when it is from you or the office. */
  fromAgentId: string | null;
  /** The team it was addressed to, when it was addressed to a team. */
  teamId: string | null;
  text: string;
  /** Images you attached: upload ids, served at /uploads/<id>. */
  images: string[];
  workId: string | null;
  createdAt: string;
  deliveries: Delivery[];
  /** An agent's answer or an office notice to you: it goes to nobody's terminal. */
  toFounder: boolean;
  /** Said by the office itself (such as a browser left running), not by you, though it has no agent as sender. */
  fromOffice?: boolean;
  /** Agents concerned by an office-to-founder notice, not terminal recipients. */
  aboutAgentIds?: string[];
  /** One founder instruction shared with the selected project and standing-team leads. */
  allLeads?: boolean;
}

export interface AllLeadsResult {
  message: Message;
  /** Selected offline leads still have a queued delivery, never silently skipped. */
  queuedOffline: string[];
  /** Teams without a lead cannot receive an instruction. */
  skippedTeams: string[];
}

export const WORK_STATES = ["in_review", "accepted", "changes_requested"] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** A piece of finished work handed from one team to another, and where its review stands. */
export interface Work {
  id: string;
  title: string;
  summary: string;
  fromAgentId: string;
  fromTeamId: string | null;
  toTeamId: string;
  state: WorkState;
  /** How many times it has been handed over; a resubmission after changes adds one. */
  round: number;
  reviewerId: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorldState {
  agents: WorldAgent[];
  teams: WorldTeam[];
  /** The latest messages, newest first. */
  messages: Message[];
  /** What you and the agents said to each other, newest first: kept apart so the office's own talk never pushes it out. */
  withFounder: Message[];
  /** Work under review, and the latest reviewed. */
  work: Work[];
  repositories: Repository[];
  herdr: "connected" | "unavailable";
  /** Moving agents to another harness: what each can go to, and the switches under way. */
  switches?: SwitchesView;
  /** The founder's subscription use: the limits' meters, and each agent's and team's tokens this week. */
  usage?: UsageView;
}

/**
 * One usage limit as its provider last reported it. The service names it ("Claude week"); the UI
 * shows the label and never branches on which provider it is.
 */
export interface UsageMeter {
  id: string;
  label: string;
  /** 0–100; null when no reading has been seen. */
  usedPercent: number | null;
  /** When the window starts again (ISO); null when not known. */
  resetsAt: string | null;
  /** When the reading was taken (ISO); null when there is none. */
  asOf: string | null;
  /** The reading is old enough that use may have moved since, or its window has reset since. */
  stale: boolean;
  window: "five_hour" | "week";
}

/** Use in the current weekly window, from the harnesses' own session files. */
export interface UsageShare {
  /** Input, output and cache-write tokens; cache reads are left out (cheap, and they would dwarf the rest). */
  tokens: number;
  /**
   * Estimated points of the weekly limit it took (0–100): its part of its harness's tokens this week
   * times that harness's weekly meter. A team that used both harnesses adds both parts. Null with no
   * weekly reading to scale by.
   */
  share: number | null;
  /** Weekly use split by meter id. Tokens remain known even without a limit reading (share null).
   * Older services may omit tokens; percentages cannot be used to reconstruct them. */
  parts: Array<{ meter: string; share: number | null; tokens?: number }>;
}

export interface UsageView {
  meters: UsageMeter[];
  /** Per agent id. */
  agents: Record<string, UsageShare>;
  /** Per team id. */
  teams: Record<string, UsageShare>;
}

/** What an agent learns about itself and its team from `inbox team`. */
export interface TeamBrief {
  agentId: string;
  text: string;
}


/** A headless browser running on this machine, with everything under it, and whose it is. */
export interface HeadlessBrowser {
  /** Its main process; Close signals this one only. */
  pid: number;
  /** "Cosmology lesson browser", numbered when a project has several. */
  label: string;
  /** The project (or agent) it was started from, or null when nobody in the office did. */
  project: string | null;
  teamId: string | null;
  /** Percent of one core, all its processes together. */
  cpu: number;
  memoryMb: number;
  pages: number;
  processes: number;
  ageSeconds: number;
  /** Someone on its project is working now. */
  ownerBusy: boolean;
  /** How long its project has had nobody working while it ran. */
  idleMinutes: number;
  /** Why it is one to look at: part of a sustained load, or forgotten but one the office could not close. */
  reasons: Array<"hot" | "forgotten">;
}

export interface MachineState {
  browsers: HeadlessBrowser[];
  totalCpu: number;
  /** Set when headless browsers need looking at: using a lot together, one the office could not close, or too many. */
  warning: { why: Array<"hot" | "forgotten" | "many"> } | null;
  /** Forgotten browsers the office closed today (kept in memory, so since the service started). */
  closedToday: number;
  checkedAt: string;
}

/** Where moving an agent to another harness stands: each step is said as it happens. */
export type SwitchStep = "queued" | "waiting" | "handoff" | "opening" | "starting" | "closing" | "taking_over" | "briefing" | "done" | "failed";

/** One agent moving to another harness: a new session takes over its name, team, role and what waits for it. */
export interface AgentSwitch {
  id: string;
  agentId: string;
  agentName: string;
  from: Harness;
  to: Harness;
  /** The harness it goes to, as people call it. */
  toLabel: string;
  model: string;
  effort: string;
  step: SwitchStep;
  /** What is happening now, or what happened, in a sentence. */
  says: string;
  /** The handoff the agent wrote for the one taking over; null when it was not running. */
  handoff: string | null;
  error: string | null;
  /** Set when it is one of a batch (`inbox switch --all-from`), switched one by one. */
  batchId: string | null;
  startedAt: string;
  updatedAt: string;
}

/** What an agent can be switched to, as the office offers it; `refused` says why not, when it cannot be. */
export interface SwitchOffer {
  harness: Harness;
  label: string;
  model: string;
  effort: string;
  refused: string | null;
}

export interface SwitchesView {
  /** Per agent id, for agents that run on a harness that can be switched. */
  offers: Record<string, SwitchOffer>;
  /** Switches under way, and those finished in the last few minutes. */
  recent: AgentSwitch[];
}
