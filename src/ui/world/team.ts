// How a team's status reads, the same on its wall screen and in the panels.

import type { TeamStatus, WorldAgent, WorldTeam } from "../../shared/types.ts";

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
  if (team.status === "blocked") return { text: `Blocked · waiting on ${team.blockedBy.map((id) => agents.get(id)?.name ?? "someone").join(" and ")}`, color };
  if (team.status === "working") return { text: `${members.filter((m) => m.status === "working").length} working now`, color };
  if (team.status === "idle") return { text: "Idle · ready for work", color };
  return { text: "Everyone offline", color };
}
