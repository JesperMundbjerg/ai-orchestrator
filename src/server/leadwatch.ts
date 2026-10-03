// A team nobody can move: its lead is offline (or it has none) while others wait on it. Detected
// from what the office already keeps (queued deliveries, work under review, pipeline steps reported
// to the lead), shown on the board, and put to the founder as one inbox decision per stalled team:
// "Make <member> lead". Nothing changes until the founder clicks; the click goes through the
// ordinary make-lead path. The item is the durable latch: no table of its own.
import type { DatabaseSync } from "node:sqlite";
import type { PipelineRun } from "../shared/pipeline.ts";
import type { Inbox } from "./inbox.ts";
import type { ItemSummary, SubmitInput, TeamStall, WorldAgent, WorldState } from "../shared/types.ts";

/** How long something must have waited on a team with no lead online before it counts as stalled. */
export const STALL_MS = 10 * 60_000;
/** The office's own inbox session: its decisions are answered by the founder and applied here, never typed anywhere. */
export const LEAD_WATCH_SESSION = { harness: "manual", sessionId: "office:lead-watch" } as const;
const KEY = "no-lead-";
const WAIT = "wait";
const MAKE = "lead:";
const OPEN: ReadonlySet<ItemSummary["state"]> = new Set(["needs_attention", "snoozed"]);
const CLOSED: ReadonlySet<ItemSummary["state"]> = new Set(["resolved", "withdrawn"]);

/** Something waiting on a team's lead: who is held up and since when. */
export interface Waiter {
  teamId: string;
  /** The agent held up; null for the founder. */
  fromAgentId: string | null;
  since: number;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));

/** Pure: which teams have no lead online while something has waited on them past the threshold. */
export function stalls(state: Pick<WorldState, "agents" | "teams">, waiters: Waiter[], now: number, threshold = STALL_MS): Map<string, TeamStall> {
  const out = new Map<string, TeamStall>();
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  for (const team of state.teams) {
    const members = state.agents.filter((a) => a.teamId === team.id);
    const lead = members.find((a) => a.role === "lead") ?? null;
    if (lead && lead.status !== "offline") continue;
    const waiting = waiters.filter((w) => w.teamId === team.id && Number.isFinite(w.since));
    if (!waiting.length) continue;
    const since = Math.min(...waiting.map((w) => w.since));
    if (now - since < threshold) continue;
    const blocking = new Set<string>();
    const blockingAgentIds = new Set<string>();
    for (const w of waiting) {
      if (!w.fromAgentId) { blocking.add("you"); continue; }
      const from = agents.get(w.fromAgentId);
      if (!from) continue;
      blockingAgentIds.add(from.id);
      const theirs = from.teamId && from.teamId !== team.id ? state.teams.find((t) => t.id === from.teamId) : undefined;
      blocking.add(theirs ? theirs.name : from.name);
    }
    const candidates = members.filter((a) => a.id !== lead?.id)
      .sort((a, b) => Number(a.status === "offline") - Number(b.status === "offline") || a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, name: a.name, running: a.status !== "offline" }));
    out.set(team.id, {
      teamId: team.id, teamName: team.name, leadId: lead?.id ?? null, leadName: lead?.name ?? null,
      since: new Date(since).toISOString(), waiting: waiting.length,
      blocking: [...blocking].sort((a, b) => Number(a === "you") - Number(b === "you") || a.localeCompare(b)),
      blockingAgentIds: [...blockingAgentIds].sort(), candidates,
    });
  }
  return out;
}

/** "Cosmology, ECG and you". */
const spoken = (names: string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");

/** The founder's one decision about a stalled team. Stable while who is on it and who waits do not change. */
export function stallItem(stall: TeamStall): SubmitInput["item"] {
  const lead = stall.leadName ? `${stall.leadName}, its lead, is offline` : "It has no lead";
  return {
    type: "decide",
    title: `${stall.teamName} has no lead online`,
    request: `${lead}, and ${spoken(stall.blocking)} ${stall.blocking.length === 1 && stall.blocking[0] !== "you" ? "is" : "are"} waiting on it. Make someone on ${stall.teamName} lead now, or wait.`,
    context: `Waiting on ${stall.teamName}: messages to its lead, work handed to it for review and pipeline steps reported to its lead. `
      + "Making someone lead hands them the messages addressed to the team that the old lead never took up; messages sent to the old lead by name stay theirs. "
      + "This item is withdrawn by itself once a lead is running again.",
    blocking: true,
    options: [
      ...stall.candidates.map((c) => ({
        id: `${MAKE}${c.id}`, label: `Make ${c.name} lead`,
        consequence: c.running ? `${c.name} is running and takes over the team's waiting messages and work now.` : `${c.name} is offline too, so the work still waits until they are back.`,
      })),
      { id: WAIT, label: `Wait for ${stall.leadName ?? "a lead"}`, consequence: "Nothing changes and what waits keeps waiting. You are asked again only if the team stalls again." },
    ],
  };
}

export interface LeadWatchEffects {
  /** The ordinary make-lead path (World.updateAgent with role lead). */
  makeLead(agentId: string): void;
  /** Hands the old lead's queued, team-addressed messages to the new lead; returns how many moved. */
  handOver(teamId: string, fromAgentId: string, toAgentId: string): number;
  /** The team's open pipeline runs. */
  openRuns(teamId: string): PipelineRun[];
}

export class LeadWatch {
  private db: DatabaseSync;
  private now: () => Date;
  private effects: LeadWatchEffects;
  private current = new Map<string, TeamStall>();
  /** The inbox the founder's decision lives in; the service wires it in. Without it the board still shows stalls. */
  inbox: Pick<Inbox, "submit" | "pendingReplies" | "acknowledge" | "closeItem" | "state"> | null = null;

  constructor(db: DatabaseSync, now: () => Date, effects: LeadWatchEffects) {
    this.db = db;
    this.now = now;
    this.effects = effects;
  }

  /** The latest observed stall for a team, for the board; null while it has a lead online or nothing waits long. */
  stall(teamId: string): TeamStall | null {
    return this.current.get(teamId) ?? null;
  }

  /** Every stall the last tick saw. */
  all(): TeamStall[] {
    return [...this.current.values()];
  }

  /** What waits on each team's lead, from durable records only, so a restart sees the same ages. */
  waiters(state: WorldState): Waiter[] {
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const leaderless = (teamId: string | null) => !!teamId && !state.agents.some((a) => a.teamId === teamId && a.role === "lead");
    const out: Waiter[] = [];
    const rows = this.db.prepare(`SELECT d.agent_id, d.updated_at, m.created_at, m.from_agent_id FROM message_deliveries d
      JOIN messages m ON m.id = d.message_id WHERE d.state = 'queued' AND m.from_office = 0`).all() as Row[];
    for (const r of rows) {
      const to = agents.get(str(r.agent_id));
      // A message to the lead, or to anyone on a team that has no lead, waits on the team.
      if (!to?.teamId || !(to.role === "lead" || leaderless(to.teamId))) continue;
      out.push({ teamId: to.teamId, fromAgentId: r.from_agent_id ? str(r.from_agent_id) : null, since: Math.max(Date.parse(str(r.created_at)), Date.parse(str(r.updated_at))) });
    }
    for (const w of state.work) if (w.state === "in_review") out.push({ teamId: w.toTeamId, fromAgentId: w.fromAgentId, since: Date.parse(w.updatedAt) });
    for (const team of state.teams) {
      const lead = state.agents.find((a) => a.teamId === team.id && a.role === "lead");
      if (lead && lead.status !== "offline") continue;
      for (const run of this.effects.openRuns(team.id)) {
        for (const step of run.steps) if (step.state === "reported") out.push({ teamId: team.id, fromAgentId: step.assignedTo, since: Date.parse(run.updatedAt) });
      }
    }
    return out;
  }

  /**
   * Observe stalls, keep one founder decision per stalled team (raised, revised, withdrawn when a
   * lead runs again) and apply the founder's answers. Returns whether anything visible changed.
   */
  tick(state: WorldState): boolean {
    const found = stalls(state, this.waiters(state), this.now().getTime());
    const led = this.inbox ? this.apply(state) : null;
    // A team just given a lead is judged afresh on the next tick, from the new state.
    for (const teamId of led?.teams ?? []) found.delete(teamId);
    let changed = Boolean(led?.answered) || JSON.stringify([...found.values()]) !== JSON.stringify([...this.current.values()]);
    this.current = found;
    if (!this.inbox) return changed;
    const items = this.items();
    for (const stall of found.values()) {
      if (!stall.candidates.length) continue; // Nobody to offer: the board still says so.
      const active = items.find((i) => i.key.startsWith(`${KEY}${stall.teamId}-`) && !CLOSED.has(i.state));
      // An answered decision ("wait") holds for this episode; only an unanswered one is revised.
      if (active && !OPEN.has(active.state)) continue;
      const key = active?.key ?? `${KEY}${stall.teamId}-${this.now().getTime()}`;
      const result = this.inbox.submit({ session: LEAD_WATCH_SESSION, project: { name: "The office" }, task: { title: "The office" }, item: { ...stallItem(stall), key } });
      changed = result.changed || changed;
    }
    for (const item of items) {
      if (!item.key.startsWith(KEY) || CLOSED.has(item.state)) continue;
      if ([...found.keys(), ...led!.teams].some((teamId) => item.key.startsWith(`${KEY}${teamId}-`))) continue;
      this.inbox.closeItem(LEAD_WATCH_SESSION, item.id, OPEN.has(item.state) ? "withdrawn" : "resolved");
      changed = true;
    }
    return changed;
  }

  private items(): ItemSummary[] {
    const state = this.inbox!.state();
    const task = state.tasks.find((t) => t.binding.harness === LEAD_WATCH_SESSION.harness && t.binding.sessionId === LEAD_WATCH_SESSION.sessionId);
    return task ? state.items.filter((i) => i.taskId === task.id) : [];
  }

  /** The founder's answers: make that member lead through the usual path, or wait. Each is acknowledged once applied. */
  private apply(state: WorldState): { answered: boolean; teams: Set<string> } {
    const replies = this.inbox!.pendingReplies(LEAD_WATCH_SESSION, "pull");
    const teams = new Set<string>();
    for (const reply of replies) {
      const teamId = reply.itemKey.startsWith(KEY) ? reply.itemKey.slice(KEY.length).replace(/-\d+$/, "") : "";
      let error: string | undefined;
      if (reply.choice?.startsWith(MAKE)) {
        const id = reply.choice.slice(MAKE.length);
        const agent: WorldAgent | undefined = state.agents.find((a) => a.id === id);
        const team = state.teams.find((t) => t.id === teamId);
        const old = state.agents.find((a) => a.teamId === teamId && a.role === "lead");
        if (!agent || !team || agent.teamId !== teamId) error = `${agent?.name ?? "That agent"} is no longer on ${team?.name ?? "that team"}`;
        else {
          this.effects.makeLead(agent.id);
          teams.add(teamId);
          if (old && old.id !== agent.id) this.effects.handOver(teamId, old.id, agent.id);
        }
      }
      this.inbox!.acknowledge(LEAD_WATCH_SESSION, reply.deliveryId, error);
      // A new lead ends this decision; if the team is still stalled (an offline pick), the next tick asks afresh.
      if (!error && reply.choice?.startsWith(MAKE)) this.inbox!.closeItem(LEAD_WATCH_SESSION, reply.itemId, "resolved");
    }
    return { answered: replies.length > 0, teams };
  }
}
