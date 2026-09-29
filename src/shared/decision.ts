import type { SubmitInput } from "./types.ts";

/**
 * Soft length caps for what an agent writes to the founder. Past them the agent gets a hint and
 * the item still goes in: a long question is better than none, but it should read like a person
 * asking, not a report.
 */
export const SOFT_CAPS = { title: 100, request: 400 } as const;

/** One-line hints for an item over its soft caps; empty when it is within them. */
export function lengthHints(item: Pick<SubmitInput["item"], "title" | "request">): string[] {
  const hints: string[] = [];
  if (item.title.length > SOFT_CAPS.title) {
    hints.push(`The title is ${item.title.length} characters; keep it to the question itself, about ${SOFT_CAPS.title}.`);
  }
  if (item.request && item.request.length > SOFT_CAPS.request) {
    hints.push(`The request is ${item.request.length} characters; say what you need and what happens if nobody answers in about ${SOFT_CAPS.request}, and move the rest to context.`);
  }
  return hints;
}

/** The first sentence of a text, for a one-line summary. */
export function firstSentence(text: string): string {
  const match = /^.*?[.?!](?=\s|$)/s.exec(text.trim());
  return (match ? match[0] : text).trim();
}
