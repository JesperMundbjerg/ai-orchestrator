import type { Delivery, WorldAgent } from "./types.ts";

/** A departed recipient is not a transport failure the founder can fix with Retry. */
export function leftBeforeArrival(delivery: Delivery, agent: Pick<WorldAgent, "paneId"> | undefined): boolean {
  return delivery.state === "failed" && (!agent?.paneId || /^\s*(?:closed|not[ _-]?found)\s*$|PTY actor closed|(?:pane|agent|terminal)[^\n]*(?:closed|not[ _-]?found|does not exist|no longer exists|gone)|(?:no such|unknown|not[ _-]?found)[^\n]*(?:pane|agent|terminal)/i.test(delivery.error ?? ""));
}
