import type { ItemDetail } from "../../shared/types.ts";
export { recommendedOption } from "../../shared/recommended-option.ts";

/** Old revisions must never look answered. Other uses the existing discuss action,
 * which also takes an item out of Needs you; later discussion keeps the original answer. */
export function decisionAnswer({ item, replies }: ItemDetail): string | null {
  if (item.state !== "answer_queued" && item.state !== "delivered") return null;
  const current = replies.filter((r) => r.revision === item.revision && r.state !== "stale" && r.state !== "failed");
  const reply = current.findLast((r) => r.action === "choose" || r.action === "answer") ?? current.find((r) => r.action === "discuss");
  if (!reply) return null;
  return reply.action === "choose" ? item.options.find((o) => o.id === reply.choice)?.label ?? reply.choice : reply.text || "Message with images";
}
