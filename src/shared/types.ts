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

/** What the user did. `accept` / `request_changes` answer a milestone, `choose` a decision,
 * `tried` a try-it request; `discuss` is free conversation on any type. */
export const REPLY_ACTIONS = ["choose", "accept", "request_changes", "tried", "discuss"] as const;
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
  checkedAt: string;
}

export type EvidenceKind = "image" | "url" | "document";

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
}

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
  thumbnail: string | null;
  lastReply: Reply | null;
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
}

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
  /** The model its harness last reported for this session; null when it has not said. */
  model: AgentModel | null;
  /** The name its session goes by in its own harness (Pi's session name, shown in its title), as the harness reported it; null when it has not said. */
  sessionName: string | null;
  /** It has been seen running in herdr; a record that never has is a name with nobody behind it. */
  ran: boolean;
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
  kind: "tool" | "tool_end" | "idle" | "helper_start" | "helper_stop" | "model" | "session_name";
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
}

/** A sub-agent working for an agent while it runs. */
export interface Helper {
  id: string;
  /** Its kind, such as "architecture-reviewer". */
  type: string;
  startedAt: string;
}

/**
 * Where a team stands, as one word. `blocked` means the team cannot go on without you: its
 * lead is stuck, or someone is and nobody else is still working.
 */
export type TeamStatus = "blocked" | "working" | "idle" | "offline";

export interface WorldTeam extends Team {
  status: TeamStatus;
  /** Who holds the team up, when it is blocked. */
  blockedBy: string[];
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
}

/** Something said in the office, and how it reached each agent it was meant for. */
export interface Message {
  id: string;
  kind: MessageKind;
  /** null when it is from you. */
  fromAgentId: string | null;
  /** The team it was addressed to, when it was addressed to a team. */
  teamId: string | null;
  text: string;
  /** Images you attached: upload ids, served at /uploads/<id>. */
  images: string[];
  workId: string | null;
  createdAt: string;
  deliveries: Delivery[];
  /** An agent answering you: it goes to nobody's terminal. */
  toFounder: boolean;
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
}

/** What an agent learns about itself and its team from `inbox team`. */
export interface TeamBrief {
  agentId: string;
  text: string;
}

