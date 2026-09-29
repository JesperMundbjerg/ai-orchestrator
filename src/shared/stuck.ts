import type { WorldAgent } from "./types.ts";

/**
 * Why the agents holding a team up are stuck, for the team's line and its notification:
 * "Tom waits for your answer", "Tom is stuck at a prompt", or both kinds joined.
 */
export function whyStuck(agents: WorldAgent[]): string {
  const names = (list: WorldAgent[]) => list.map((a) => a.name).join(" and ");
  const onYou = agents.filter((a) => a.waitingOnYou);
  const atPrompt = agents.filter((a) => !a.waitingOnYou);
  return [
    onYou.length ? `${names(onYou)} ${onYou.length === 1 ? "waits" : "wait"} for your answer` : "",
    atPrompt.length ? `${names(atPrompt)} ${atPrompt.length === 1 ? "is" : "are"} stuck at a prompt` : "",
  ].filter(Boolean).join("; ");
}
