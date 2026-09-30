import type { ItemType, Presence, Reply, ReplyAction } from "../shared/types.ts";

export const TYPE_LABEL: Record<ItemType, string> = { decide: "Decide", try: "Try it", milestone: "Review" };

export const ACTION_LABEL: Record<ReplyAction, string> = {
  choose: "Decided",
  answer: "Answered",
  accept: "Accepted",
  request_changes: "Requested changes",
  tried: "Tried it",
  discuss: "Said",
};

/** What a reply is called in the thread; a try-it request is approved or needs changes rather than accepted. */
export function actionLabel(action: ReplyAction, type: ItemType): string {
  if (type === "try" && action === "accept") return "Approved";
  if (type === "try" && action === "request_changes") return "Needs changes";
  return ACTION_LABEL[action];
}

export const PRESENCE_LABEL: Record<Presence["status"], string> = {
  idle: "idle",
  working: "working",
  blocked: "waiting at a prompt",
  done: "finished a turn",
  unknown: "unknown",
};

export function deliveryLabel(r: Reply): string {
  if (r.state === "delivered") return `Delivered ${clock(r.deliveredAt)}`;
  if (r.state === "stale") return "Not sent: the item changed after this answer";
  if (r.state === "failed") return `Delivery failed${r.error ? `: ${r.error}` : ""}`;
  return r.error ? `Uncertain: ${r.error}` : "Queued for the agent";
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function clock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

export function snoozeChoices(now = new Date()): Array<{ label: string; until: Date }> {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: "1 hour", until: new Date(now.getTime() + 3_600_000) },
    { label: "3 hours", until: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "Tomorrow 9:00", until: tomorrow },
  ];
}
