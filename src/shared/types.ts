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
  createdAt: string;
}

// ── The office world ─────────────────────────────────────────────────────────────────────

/** How a team works, which is also how its corner of the office is furnished:
 * `dispatch` has a lead at the back handing work to a row of crew consoles;
 * `circle` is peers around one table who settle things between them. */
export const TEAM_STRUCTURES = ["dispatch", "circle"] as const;
export type TeamStructure = (typeof TEAM_STRUCTURES)[number];

export interface Team {
  id: string;
  name: string;
  structure: TeamStructure;
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
  status: Presence["status"] | "offline";
  title: string | null;
  paneId: string | null;
  /** Inbox tasks of this agent: their items are what it queues at your desk with. */
  taskIds: string[];
  teamId: string | null;
  role: AgentRole;
  /** It has asked you something in the inbox and says it cannot go on until you answer. */
  waitingOnYou: boolean;
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
  /** The repositories its members work in. */
  projects: string[];
  orders: TeamOrder[];
}

export const DELIVERY_STATES = ["queued", "sending", "delivered", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Your instruction to a team, and how it reached each agent it was meant for. */
export interface TeamOrder {
  id: string;
  teamId: string;
  text: string;
  createdAt: string;
  deliveries: Array<{ agentId: string; state: DeliveryState; error: string | null; updatedAt: string }>;
}

export interface WorldState {
  agents: WorldAgent[];
  teams: WorldTeam[];
  herdr: "connected" | "unavailable";
}

export interface AgentScreen {
  text: string;
  readAt: string;
}
