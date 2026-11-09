// The words for a stalled team (a team with no lead online), shown on the board and the team panel.
import type { TeamStall } from "../shared/types.ts";
import { ago } from "./format.ts";

/** "Mission Control has no lead online; blocking: Cosmology, ECG." */
export function stallLine(stall: TeamStall): string {
  return `${stall.teamName} has no lead online; blocking: ${stall.blocking.join(", ")}`;
}

export function stallDetail(stall: TeamStall, now = Date.now()): string {
  // A desktop session is idle between turns, not gone: the office never offers to replace it.
  if (stall.leadLastSpokeAt) return `Led from a desktop session, last spoke ${ago(stall.leadLastSpokeAt, now)} · ${stall.waiting} waiting, the oldest from ${ago(stall.since, now)}`;
  const who = stall.leadName ? `${stall.leadName} is offline` : "Nobody leads it";
  const ask = stall.candidates.length ? "Your decision is in Needs you." : "Nobody else is on it to make lead.";
  return `${who} · ${stall.waiting} waiting, the oldest from ${ago(stall.since, now)} · ${ask}`;
}
