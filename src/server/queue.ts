// A project's work queue as its own tools see it: its standing lanes (named in its adapter)
// joined to the office's agents, and the state of its comments. Comments do not live here yet
// (docs/ORCHESTRATION.md, step 5), so the counts are empty; the lanes are real.

import { resolve } from "node:path";
import type { AdapterLane, Lane, ProjectQueue, Repository, WorldAgent, WorldState } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";

/** The name herdr knows an agent by, kept at the end of its identity: `claude:/repo@dispatch-einstein`. */
export function herdrName(identity: string): string | null {
  return identity.match(/@([a-z][a-z0-9_-]*)(?:#\d+)?$/)?.[1] ?? null;
}

/**
 * The agent behind a lane. A lane with a worktree is whoever works in it; with `agent`, the one
 * herdr knows by that name (both, when both are given). A lane with neither is the agent herdr or
 * the office calls by the lane's name. Someone running wins over a desk left empty.
 */
export function laneAgent(lane: AdapterLane, agents: WorldAgent[]): WorldAgent | null {
  const lower = lane.name.toLowerCase();
  const matches = agents.filter((a) => {
    if (lane.worktree && (!a.cwd || resolve(a.cwd) !== resolve(lane.worktree))) return false;
    if (lane.agent) return herdrName(a.identity) === lane.agent;
    if (lane.worktree) return true;
    return herdrName(a.identity) === lane.name || a.name.toLowerCase() === lower;
  });
  const rank = (a: WorldAgent) => (a.status === "offline" ? 2 : a.status === "working" ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] ?? null;
}

function laneOf(lane: AdapterLane, state: WorldState): Lane {
  const agent = laneAgent(lane, state.agents);
  const where = lane.worktree ? ` in ${lane.worktree}` : "";
  const status = agent?.status ?? "offline";
  return {
    name: lane.name,
    role: lane.role,
    agentId: agent?.id ?? null,
    agentName: agent?.name ?? null,
    harness: agent?.harness ?? lane.harness,
    model: agent?.model?.label ?? lane.model,
    state: status === "working" ? "working" : status === "blocked" ? "blocked" : status === "offline" ? "offline" : "idle",
    doing: agent && status !== "offline" ? agent.doing ?? agent.title : null,
    branch: state.teams.find((t) => agent?.cwd && t.path === agent.cwd)?.branch ?? null,
    carrying: [],
    why: !agent ? `nobody runs${where}` : status === "offline" ? `${agent.name} is not running${where}` : status === "blocked" ? `${agent.name} is stuck at a prompt` : null,
  };
}

/** The repository whose adapter names `project`. A repository with an adapter too broken to read says why. */
export function repositoryFor(state: WorldState, project: string): Repository & { adapter: NonNullable<Repository["adapter"]> } {
  const found = state.repositories.find((r) => r.adapter?.project === project);
  if (found?.adapter) return found as Repository & { adapter: NonNullable<Repository["adapter"]> };
  const broken = state.repositories.find((r) => !r.adapter && r.adapterProblems.length && r.name.toLowerCase() === project.toLowerCase());
  if (broken) throw new InboxError(422, `${broken.root}/orchestrator.json cannot be used: ${broken.adapterProblems.join("; ")}`);
  throw new InboxError(404, `no project "${project}": a project is a repository someone works in whose main checkout has an orchestrator.json naming it`);
}

export function projectQueue(state: WorldState, project: string): ProjectQueue {
  const repo = repositoryFor(state, project);
  return {
    project,
    lanes: repo.adapter.lanes.map((lane) => laneOf(lane, state)),
    counts: { waiting: 0, assigned: 0, working: 0, held: 0, fixed: 0 },
    held: [],
    paused: false,
  };
}
