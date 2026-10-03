// Office names reach herdr, and standing lanes lend theirs. The agent that is a lane's standing
// session is called after the lane (einstein: Einstein), and every running agent's pane in herdr
// carries its office name as a label, so the avatar and the pane read the same. Only the pane's
// display label changes: herdr's agent names, which leads and crew address in prompts, stay.
//
// Both converge rather than loop: a name moves only when the lane's holder is certain, a label is
// set only when it differs from what was last set, and a failed label waits before it is tried
// again. Failures are logged, never thrown into the office.

import { resolve } from "node:path";
import type { AdapterLane, WorldAgent, WorldState } from "../shared/types.ts";
import { herdrName, type LaneRegistration } from "./queue.ts";

/** How long a pane whose label herdr refused waits before it is tried again. */
export const LABEL_RETRY_MS = 60_000;

export interface PaneNamer {
  /** Gives `id` the name, and whoever has it now a newcomer's name instead (world.ts). */
  claimName(id: string, name: string): void;
  /** Sets the pane's display label in herdr (herdr.ts). */
  renamePane?(paneId: string, label: string): Promise<void>;
  registered: () => LaneRegistration;
  now: () => number;
  log?: (line: string) => void;
}

/** A lane's name as an office name: `galilei` is Galilei, `mission-control` Mission Control. */
export function laneTitle(lane: string): string {
  return lane.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The running agent that is the lane's standing session, or null when that is not certain (then no
 * name moves). With an attach command, the session it registered and the office verified; with
 * `agent`, the one agent herdr or Pi calls that. A lane with only a worktree is the one agent running
 * there; with several (its crew beside it), the one already called after the lane keeps it.
 */
export function laneHolder(lane: AdapterLane, agents: readonly WorldAgent[], registered: ReturnType<LaneRegistration>): WorldAgent | null {
  const running = (a: WorldAgent) => a.paneId !== null && a.status !== "offline";
  if (lane.attach) return registered?.agentId ? agents.find((a) => a.id === registered.agentId && running(a)) ?? null : null;
  const here = agents.filter((a) => running(a) && (!lane.worktree || (!!a.cwd && resolve(a.cwd) === resolve(lane.worktree))));
  if (lane.agent) {
    const named = here.filter((a) => herdrName(a.identity) === lane.agent || a.sessionName === lane.agent);
    return named.length === 1 ? named[0]! : null;
  }
  if (!lane.worktree) return null;
  const title = laneTitle(lane.name).toLowerCase();
  return here.find((a) => a.name.toLowerCase() === title) ?? (here.length === 1 ? here[0]! : null);
}

export class PaneNames {
  private namer: PaneNamer;
  /** Per pane, the label last set or tried; a failed one is retried after LABEL_RETRY_MS. */
  private labels = new Map<string, { label: string; ok: boolean; at: number }>();
  private pending = new Set<string>();

  constructor(namer: PaneNamer) {
    this.namer = namer;
  }

  /** Brings names and labels in line with `state`. Renaming an agent changes the world, so labels follow on the next run. */
  sync(state: WorldState): void {
    try {
      if (this.nameLanes(state)) return;
    } catch (err) {
      this.log(`lane names: ${(err as Error).message}`);
    }
    this.label(state.agents);
  }

  /** True when an agent was renamed. */
  private nameLanes(state: WorldState): boolean {
    // Agents address teams and agents alike by name, so a lane named like a team keeps its holder's name.
    const taken = new Set(["founder", ...state.teams.map((t) => t.name.toLowerCase())]);
    const given = new Map<string, string>();
    for (const repo of state.repositories) {
      for (const lane of repo.adapter?.lanes ?? []) {
        const title = laneTitle(lane.name);
        if (!title || taken.has(title.toLowerCase())) continue;
        const holder = laneHolder(lane, state.agents, lane.attach ? this.namer.registered()(repo.root, lane, state) : null);
        // A name is one agent's, and an agent has one name: two lanes of the same name, or one agent holding two, move nothing.
        if (!holder || [...given.values()].includes(title) || given.has(holder.id)) continue;
        given.set(holder.id, title);
      }
    }
    let renamed = false;
    for (const [id, title] of given) {
      if (state.agents.find((a) => a.id === id)?.name === title) continue;
      this.namer.claimName(id, title);
      renamed = true;
    }
    return renamed;
  }

  private label(agents: readonly WorldAgent[]): void {
    const rename = this.namer.renamePane;
    if (!rename) return;
    const now = this.namer.now();
    const panes = new Set<string>();
    for (const a of agents) {
      if (!a.paneId || a.status === "offline") continue;
      panes.add(a.paneId);
      const last = this.labels.get(a.paneId);
      if (this.pending.has(a.paneId) || (last?.label === a.name && (last.ok || now - last.at < LABEL_RETRY_MS))) continue;
      const pane = a.paneId;
      const label = a.name;
      this.pending.add(pane);
      void rename.call(this.namer, pane, label).then(
        () => void this.labels.set(pane, { label, ok: true, at: now }),
        (err: Error) => {
          this.labels.set(pane, { label, ok: false, at: now });
          this.log(`pane ${pane} could not be labelled ${label}: ${err.message}`);
        },
      ).finally(() => this.pending.delete(pane));
    }
    // A pane that closed is forgotten; one that comes back is labelled again.
    for (const pane of this.labels.keys()) if (!panes.has(pane)) this.labels.delete(pane);
  }

  private log(line: string): void {
    (this.namer.log ?? console.error)(`pane names: ${line}`);
  }
}
