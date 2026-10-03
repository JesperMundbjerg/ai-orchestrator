import type { CrewTreeUpdate, CrewTreeState } from "../shared/crewtree.ts";
import type { AgentSwitch, AllLeadsResult, AutoApproveState, AutomationMode, InboxState, Item, ItemDetail, MachineState, PageCheck, Project, Reply, ReplyAction, StandingLane, Task, Message, Team, WorldAgent, WorldState } from "../shared/types.ts";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await res.json()) as T & { error?: string };
  // The error's code (ApiErrorBody) lets a caller tell one refusal from another.
  if (!res.ok) throw Object.assign(new Error(out.error ?? `${res.status}`), { code: (out as { code?: string }).code });
  return out;
}

export const api = {
  autoApprove: () => request<AutoApproveState>("GET", "/api/auto-approve"),
  /** `qaModel` has the office start a QA agent on that model (null: none). */
  setAutoApprove: (mode: AutomationMode, qaModel?: { harness: string; model: string; effort: string } | null) => request<AutoApproveState>("POST", "/api/auto-approve", { mode, qaModel }),
  state: () => request<InboxState>("GET", "/api/state"),
  detail: (itemId: string) => request<ItemDetail>("GET", `/api/items/${itemId}`),
  answer: (itemId: string, body: { id: string; revision: number; action: ReplyAction; choice?: string; text?: string; images?: string[] }) =>
    request<Reply>("POST", `/api/items/${itemId}/replies`, body),
  backOfQueue: (itemId: string) => request<Item>("POST", `/api/items/${itemId}/back-of-queue`, {}),
  snooze: (itemId: string, until: Date) => request<Item>("POST", `/api/items/${itemId}/snooze`, { until: until.toISOString() }),
  resolve: (itemId: string) => request<Item>("POST", `/api/items/${itemId}/resolve`, {}),
  checkPage: (itemId: string, index: number) => request<PageCheck>("GET", `/api/items/${itemId}/pages/${index}/check`),
  retry: (replyId: string) => request<Reply>("POST", `/api/replies/${replyId}/retry`, {}),
  updateTask: (taskId: string, patch: Partial<Task>) => request<Task>("PATCH", `/api/tasks/${taskId}`, patch),
  openConversation: (taskId: string) => request<{ ok: true }>("POST", `/api/tasks/${taskId}/open`, {}),
  pin: (projectId: string, pinned: boolean) => request<Project>("POST", `/api/projects/${projectId}/pin`, { pinned }),
  world: () => request<WorldState>("GET", "/api/world"),
  createTeam: (body: { name: string; purpose?: string; handsTo?: string | null; repository?: string; standing?: boolean }) => request<Team>("POST", "/api/world/teams", body),
  updateTeam: (teamId: string, patch: { name?: string; purpose?: string; handsTo?: string | null }) => request<Team>("PATCH", `/api/world/teams/${teamId}`, patch),
  /** `force` finishes past commits not on the integration branch (the branch is kept); uncommitted changes always refuse. */
  deleteTeam: (teamId: string, force = false) => request<{ ok: true; note: string }>("DELETE", `/api/world/teams/${teamId}`, force ? { force } : {}),
  teamWorktrees: (teamId: string) => request<{ worktrees: string[]; available: string[] }>("GET", `/api/world/teams/${teamId}/worktrees`),
  addWorktree: (teamId: string, path: string) => request<Team>("POST", `/api/world/teams/${teamId}/worktrees`, { path }),
  removeWorktree: (teamId: string, path: string) => request<Team>("POST", `/api/world/teams/${teamId}/worktrees/remove`, { path }),
  mergeTeam: (teamId: string, into: string) => request<{ ok: true; note: string; team: Team }>("POST", `/api/world/teams/${teamId}/merge`, { into }),
  updateAgent: (agentId: string, patch: { name?: string; teamId?: string | null; role?: "lead" | "member"; takeName?: boolean }) => request<WorldAgent>("PATCH", `/api/world/agents/${agentId}`, patch),
  setEffort: (agentId: string, level: string) => request("POST", `/api/world/agents/${agentId}/effort`, { level }),
  switchAgent: (agentId: string, body: { to?: string; model?: string; effort?: string } = {}) => request<AgentSwitch>("POST", "/api/world/switches", { agent: agentId, ...body }),
  removeAgent: (agentId: string) => request<{ removed: string }>("DELETE", `/api/world/agents/${agentId}`, {}),
  instructTeam: (teamId: string, text: string, images: string[] = []) => request<Message>("POST", `/api/world/teams/${teamId}/messages`, { text, images, clientId: crypto.randomUUID() }),
  tellAllLeads: (body: { text: string; images: string[]; leadIds: string[]; clientId: string }) => request<AllLeadsResult>("POST", "/api/world/all-leads/messages", body),
  retryDelivery: (messageId: string, agentId: string) => request<Message>("POST", `/api/world/messages/${messageId}/deliveries/${agentId}/retry`, {}),
  tellAgent: (agentId: string, text: string, images: string[] = []) => request<Message>("POST", `/api/world/agents/${agentId}/messages`, { text, images, clientId: crypto.randomUUID() }),
  crewTree: () => request<CrewTreeState>("GET", "/api/world/crew-tree"),
  saveCrewTree: (tree: CrewTreeUpdate) => request<CrewTreeState>("PUT", "/api/world/crew-tree", tree),
  lanes: () => request<StandingLane[]>("GET", "/api/lanes"),
  recoverLane: (project: string, lane: string, agentId: string) => request<StandingLane>("POST", `/api/p/${project}/lanes/${lane}/recover`, { agentId }),
  machine: () => request<MachineState>("GET", "/api/machine"),
  closeBrowser: (pid: number) => request<{ ok: true; closed: number }>("POST", `/api/machine/browsers/${pid}/close`, {}),
  /** An image you pasted or dropped, sent as base64; answers and messages then name it by id. */
  upload: (data: string) => request<{ id: string; url: string; size: number }>("POST", "/api/uploads", { data }),
};
