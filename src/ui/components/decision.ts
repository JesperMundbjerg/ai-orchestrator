import type { ItemDetail, Option } from "../../shared/types.ts";

/** Recommendations are prose, not a protocol field naming an option. Only mark an
 * unambiguous leading label/id; never guess from a label mentioned in the reason. */
export function recommendedOption(options: Option[], recommendation: string): string | null {
  const lead = recommendation.trim().replace(/^I recommend\s+/i, "");
  const explicitId = /^option\s+/i.test(lead);
  const text = lead.replace(/^option\s+/i, "").toLocaleLowerCase();
  const matches = options.filter((option) => {
    const label = option.label.trim().toLocaleLowerCase();
    const id = option.id.toLocaleLowerCase();
    const labelMatches = text.startsWith(label) && /^(?:$|[:,.\s—–-])/.test(text.slice(label.length));
    // A sentence starting with the article “A” is not necessarily option A.
    const idMatches = text.startsWith(id) && (explicitId ? /^(?:$|[:,.\s—–-])/ : /^(?:$|[:,.—–-]|\s+(?:because|since)\b)/).test(text.slice(id.length));
    return labelMatches || idMatches;
  });
  return matches.length === 1 ? matches[0]!.id : null;
}

/** Old revisions must never look answered. Other uses the existing discuss action,
 * which also takes an item out of Needs you; later discussion keeps the original answer. */
export function decisionAnswer({ item, replies }: ItemDetail): string | null {
  if (item.state !== "answer_queued" && item.state !== "delivered") return null;
  const current = replies.filter((r) => r.revision === item.revision && r.state !== "stale" && r.state !== "failed");
  const reply = current.findLast((r) => r.action === "choose" || r.action === "answer") ?? current.find((r) => r.action === "discuss");
  if (!reply) return null;
  return reply.action === "choose" ? item.options.find((o) => o.id === reply.choice)?.label ?? reply.choice : reply.text || "Message with images";
}
