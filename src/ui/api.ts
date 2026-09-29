import type { AgentScreen, InboxState, Item, ItemDetail, Project, Reply, ReplyAction, Task, Message, Team, WorldAgent, WorldState } from "../shared/types.ts";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `${res.status}`);
  return out;
}

export const api = {
  state: () => request<InboxState>("GET", "/api/state"),
  detail: (itemId: string) => request<ItemDetail>("GET", `/api/items/${itemId}`),
  answer: (itemId: string, body: { id: string; revision: number; action: ReplyAction; choice?: string; text?: string }) =>
    request<Reply>("POST", `/api/items/${itemId}/replies`, body),
  snooze: (itemId: string, until: Date) => request<Item>("POST", `/api/items/${itemId}/snooze`, { until: until.toISOString() }),
  resolve: (itemId: string) => request<Item>("POST", `/api/items/${itemId}/resolve`, {}),
  checkPreview: (itemId: string) => request<{ reachable: boolean; status: number | null; checkedAt: string }>("GET", `/api/items/${itemId}/preview-check`),
  retry: (replyId: string) => request<Reply>("POST", `/api/replies/${replyId}/retry`, {}),
  updateTask: (taskId: string, patch: Partial<Task>) => request<Task>("PATCH", `/api/tasks/${taskId}`, patch),
  openConversation: (taskId: string) => request<{ ok: true }>("POST", `/api/tasks/${taskId}/open`, {}),
  pin: (projectId: string, pinned: boolean) => request<Project>("POST", `/api/projects/${projectId}/pin`, { pinned }),
  world: () => request<WorldState>("GET", "/api/world"),
  createTeam: (body: { name: string; purpose?: string; handsTo?: string | null; repository?: string; standing?: boolean }) => request<Team>("POST", "/api/world/teams", body),
  updateTeam: (teamId: string, patch: { name?: string; purpose?: string; handsTo?: string | null }) => request<Team>("PATCH", `/api/world/teams/${teamId}`, patch),
  deleteTeam: (teamId: string) => request<{ ok: true; note: string }>("DELETE", `/api/world/teams/${teamId}`, {}),
  updateAgent: (agentId: string, patch: { name?: string; teamId?: string | null; role?: "lead" | "member" }) => request<WorldAgent>("PATCH", `/api/world/agents/${agentId}`, patch),
  instructTeam: (teamId: string, text: string) => request<Message>("POST", `/api/world/teams/${teamId}/messages`, { text, clientId: crypto.randomUUID() }),
  retryDelivery: (messageId: string, agentId: string) => request<Message>("POST", `/api/world/messages/${messageId}/deliveries/${agentId}/retry`, {}),
  agentScreen: (agentId: string) => request<AgentScreen>("GET", `/api/world/agents/${agentId}/screen`),
  openAgent: (agentId: string) => request<{ ok: true }>("POST", `/api/world/agents/${agentId}/open`, {}),
};
