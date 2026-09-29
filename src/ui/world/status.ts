// How an agent's and a team's status read: the lamps and lines shared by the office, its
// panels and the team board.

import type { TeamStatus, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { whyStuck } from "../../shared/stuck.ts";

/** The status lamp above each head. */
export const LAMP: Record<WorldAgent["status"], { color: string; label: string; glow: number }> = {
  working: { color: "#3ddc84", label: "working", glow: 1 },
  blocked: { color: "#ffb020", label: "waiting at a prompt", glow: 1 },
  done: { color: "#5b9dff", label: "finished a turn", glow: 0.8 },
  idle: { color: "#d7dde4", label: "idle", glow: 0.35 },
  unknown: { color: "#6b7280", label: "status unknown", glow: 0.15 },
  offline: { color: "#3a3f47", label: "offline", glow: 0 },
};

export const TEAM_LAMP: Record<TeamStatus, { color: string; label: string }> = {
  blocked: { color: "#ff5a4f", label: "blocked" },
  working: { color: "#3ddc84", label: "working" },
  idle: { color: "#b8c2cc", label: "idle" },
  offline: { color: "#6b7280", label: "offline" },
};

/** One line: who holds the team up when it is blocked, else how many are working. */
export function teamLine(team: WorldTeam, agents: Map<string, WorldAgent>): { text: string; color: string } {
  const color = TEAM_LAMP[team.status].color;
  const members = [...agents.values()].filter((a) => a.teamId === team.id);
  if (team.status === "blocked") return { text: `Blocked · ${whyStuck(team.blockedBy.flatMap((id) => agents.get(id) ?? []))}`, color };
  if (team.status === "working") return { text: `${members.filter((m) => m.status === "working").length} working now`, color };
  if (team.status === "idle") return { text: "Idle · ready for work", color };
  return { text: "Everyone offline", color };
}

/** Someone with nothing running behind them: the office can let them go. */
export const removable = (agent: WorldAgent) => agent.status === "offline" && !agent.paneId;

export function confirmRemove(agent: WorldAgent): boolean {
  return confirm(`Remove ${agent.name} from the office? Nothing runs behind ${agent.name}. What they said stays; messages still waiting for them are dropped.${agent.role === "lead" ? " Their team's longest-standing running member leads it next." : ""}`);
}
