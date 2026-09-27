import type { InboxState, Item, ItemDetail, Project, Reply, ReplyAction, Task } from "../shared/types.ts";

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
};
