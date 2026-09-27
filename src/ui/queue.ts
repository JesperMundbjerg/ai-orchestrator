// Which items need the user, in what order. The order is deliberately simple and stated in
// the UI: pinned projects first, then items an agent is blocked on, then longest waiting.

import type { InboxState, ItemSummary, ItemType, Project, Task } from "../shared/types.ts";

export type Filter = "all" | ItemType;

export interface Entry {
  item: ItemSummary;
  task: Task;
  project: Project;
}

export const SORT_EXPLANATION = "Pinned projects first, then items an agent is waiting on, then the longest waiting.";

export function needsYou(state: InboxState, filter: Filter, projectId: string | null): Entry[] {
  return entries(state)
    .filter(({ item, task }) => item.state === "needs_attention" && !task.parked)
    .filter(({ item, project }) => (filter === "all" || item.type === filter) && (!projectId || project.id === projectId))
    .sort((a, b) =>
      Number(b.project.pinned) - Number(a.project.pinned) ||
      Number(b.item.blocking) - Number(a.item.blocking) ||
      a.item.updatedAt.localeCompare(b.item.updatedAt));
}

/** Counts per filter chip, over what needs the user. */
export function filterCounts(state: InboxState, projectId: string | null): Record<Filter, number> {
  const list = needsYou(state, "all", projectId);
  return {
    all: list.length,
    decide: list.filter((e) => e.item.type === "decide").length,
    try: list.filter((e) => e.item.type === "try").length,
    milestone: list.filter((e) => e.item.type === "milestone").length,
  };
}

/** The next item needing the user after the one open now, wrapping around. */
export function nextNeeding(list: Entry[], currentId: string | null): string | null {
  if (!list.length) return null;
  const at = list.findIndex((e) => e.item.id === currentId);
  return list[(at + 1) % list.length]!.item.id;
}

export function entries(state: InboxState): Entry[] {
  const tasks = new Map(state.tasks.map((t) => [t.id, t]));
  const projects = new Map(state.projects.map((p) => [p.id, p]));
  return state.items.flatMap((item) => {
    const task = tasks.get(item.taskId);
    const project = task && projects.get(task.projectId);
    return task && project ? [{ item, task, project }] : [];
  });
}

/** Open items per task that are not waiting on the user: answered, awaiting pickup, or snoozed. */
export function openItemsOf(state: InboxState, taskId: string): ItemSummary[] {
  return state.items.filter((i) => i.taskId === taskId && !["resolved", "withdrawn"].includes(i.state));
}
