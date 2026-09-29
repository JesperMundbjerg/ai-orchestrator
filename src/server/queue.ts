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
 * herdr or its own session (Pi's session name) calls exactly that (both, when both are given).
 * A lane with neither is the agent herdr or the office calls by the lane's name. Someone running
 * wins over a desk left empty. Nobody matching is nobody: another agent in the same folder never stands in.
 */
export function laneAgent(lane: AdapterLane, agents: WorldAgent[]): WorldAgent | null {
  const lower = lane.name.toLowerCase();
  const matches = agents.filter((a) => {
    if (lane.worktree && (!a.cwd || resolve(a.cwd) !== resolve(lane.worktree))) return false;
    if (lane.agent) return herdrName(a.identity) === lane.agent || a.sessionName === lane.agent;
    if (lane.worktree) return true;
    return herdrName(a.identity) === lane.name || a.name.toLowerCase() === lower;
  });
  const rank = (a: WorldAgent) => (a.status === "offline" ? 2 : a.status === "working" ? 0 : 1);
  return matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))[0] ?? null;
}

/** Why nobody stands behind a lane, for a lane whose agent was not found. */
function nobody(lane: AdapterLane): string {
  const where = lane.worktree ? ` in ${lane.worktree}` : "";
  return lane.agent ? `nobody runs${where} whose herdr name or Pi session name is ${lane.agent}` : `nobody runs${where}`;
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
    // Git's word for the checkout the agent stands in, which is the lane's worktree when it has one: a standing team has no path to look it up by.
    branch: agent?.branch ?? null,
    carrying: [],
    why: !agent ? nobody(lane) : status === "offline" ? `${agent.name} is not running${where}` : status === "blocked" ? `${agent.name} is stuck at a prompt` : null,
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

/**
 * The office agent a project's lane name stands for, so a project's tools can message their
 * lanes by the names they already use (`inbox say einstein`). A name that is a lane in several
 * projects means the sender's own; null when no project has a lane by that name.
 */
export function laneRecipient(state: WorldState, from: WorldAgent, name: string): WorldAgent | null {
  const lower = name.toLowerCase();
  const found = state.repositories.flatMap((r) => (r.adapter?.lanes ?? []).filter((l) => l.name.toLowerCase() === lower).map((lane) => ({ repo: r, lane })));
  if (!found.length) return null;
  const pick = found.length === 1 ? found[0]! : found.find((f) => f.repo.name === from.project);
  if (!pick) throw new InboxError(409, `${name} is a lane in ${found.map((f) => f.repo.adapter!.project).join(" and ")}; say it from inside that project`);
  const agent = laneAgent(pick.lane, state.agents);
  if (!agent) throw new InboxError(404, `${pick.lane.name} is a lane of ${pick.repo.adapter!.project}, but ${nobody(pick.lane)}`);
  return agent;
}
