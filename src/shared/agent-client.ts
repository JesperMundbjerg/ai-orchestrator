// What every agent-side integration shares: how to reach the service, and how a reply reads
// when it lands in a conversation. The CLI, the Claude Code hook and the Pi extension use it.

import type { PendingReply, SessionInput } from "./types.ts";

export function serviceUrl(): string {
  return process.env.INBOX_URL ?? `http://127.0.0.1:${process.env.INBOX_PORT ?? 4870}`;
}

export async function call<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T> {
  const res = await fetch(`${serviceUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `inbox answered ${res.status}`);
  return out;
}

export async function get<T>(path: string, timeoutMs = 5000): Promise<T> {
  const res = await fetch(`${serviceUrl()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  const out = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? `inbox answered ${res.status}`);
  return out;
}

export const fetchReplies = (session: SessionInput, mode: "live" | "boundary" | "pull") =>
  call<PendingReply[]>("/api/agent/replies", { session, mode });

export const acknowledge = (session: SessionInput, deliveryId: string, error?: string) =>
  call("/api/agent/ack", { session, deliveryId, error });

const ACTION_LEAD: Record<PendingReply["action"], string> = {
  choose: "Decision",
  answer: "Answer",
  accept: "Milestone accepted",
  request_changes: "Changes requested",
  tried: "Tried it", // an old try-it reply, still handed over if one was queued
  discuss: "Message",
};

/** What a try-it request's answer is called: the user approved it, or it needs changes. */
const TRY_LEAD: Partial<Record<PendingReply["action"], string>> = { accept: "Approved", request_changes: "Needs changes" };

/** Attached images as the agent reads them: one absolute path per line, never the bytes, since the text may be typed into a terminal. */
export function imageLines(paths: string[]): string {
  return paths.map((p) => `Image: ${p}`).join("\n");
}

/** A reply as the owning agent reads it: which request it answers, what was chosen, what was said. */
export function formatReply(r: PendingReply): string {
  const lines = [`[Review inbox] Reply to your ${r.itemType} request "${r.itemTitle}" (key ${r.itemKey}, revision ${r.revision}).`];
  const lead = (r.itemType === "try" ? TRY_LEAD[r.action] : undefined) ?? ACTION_LEAD[r.action];
  if (r.action === "choose") lines.push(`${lead}: ${r.choiceLabel ?? r.choice}`);
  else if (r.action === "answer") lines.push(`${lead}: ${r.text}`);
  else lines.push(`${lead}.`);
  if (r.text && r.action !== "answer") lines.push("", r.text);
  if (r.images?.length) lines.push("", imageLines(r.images));
  lines.push("", "This is the user's answer. It authorizes only what it says; act on it, then submit a new review item when there is something new to look at.");
  return lines.join("\n");
}
