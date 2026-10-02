// People talking in the office. Pure: from messages that arrived since the office opened it
// returns who walks over to whom and what they say, and what you said to whom.
//
//   an agent's message, handoff or review → the sender walks to the (first) recipient, says it
//                                           when there, carrying a folder for a handoff, and walks back
//   your instruction                      → a bubble over each agent it goes to
//   a blocked team                        → its lead comes to the clearing and stays until it is
//                                           unblocked or you send them back
//
// Unlike the rest, a lead at the clearing is standing state, not an event: it follows from how
// the teams stand right now, so it is there when the office opens too.

import type { Message, MessageKind, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { routeIn, type BuildingPlan, type RouteFn } from "./building.ts";
import { yawTo, type Spot, type Vec2 } from "./spatial.ts";

export interface Visit {
  messageId: string;
  fromId: string;
  toId: string;
  kind: MessageKind;
  text: string;
  /** Where the visitor stands while talking. */
  spot: Spot;
  until: number;
}

export interface Bubble {
  agentId: string;
  text: string;
  kind: MessageKind;
  until: number;
}

const WALK_SPEED = 1.9;
const TALK_MS = 7000;
const BUBBLE_MS = 9000;

const LEAD: Record<MessageKind, string> = { instruction: "You: ", message: "", handoff: "Handing over: ", review: "" };

/** A short line of what was said, for a speech bubble. */
export function bubbleText(message: Message): string {
  const n = message.images.length;
  // An image said on its own still gets a bubble.
  const said = message.text.replace(/\s+/g, " ").trim() || (n ? (n === 1 ? "(an image)" : `(${n} images)`) : "");
  const text = `${LEAD[message.kind]}${said}`;
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

/** Beside the person being talked to, turned towards them. */
export function visitSpot(target: Spot): Spot {
  const [x, z] = target.pos;
  const f = target.facing;
  // Half a step back from where they face and most of a seat to their right.
  const pos: Vec2 = [x + Math.cos(f) * 0.75 - Math.sin(f) * 0.35, z - Math.sin(f) * 0.75 - Math.cos(f) * 0.35];
  return { pos, facing: yawTo(pos, target.pos), zone: target.zone, group: target.group, approach: target.approach };
}

/** A lead at the clearing because their team cannot go on without you. */
export interface Call {
  teamId: string;
  leadId: string;
  /** Who holds the team up, the lead first when they are one of them. */
  stuckIds: string[];
  /**
   * What the call is about. Sending the lead back holds only while it stays the same: when
   * someone else gets stuck, or someone stops waiting on you and is at a prompt instead, they
   * come again.
   */
  key: string;
  spot: Spot;
}

/** How long a crew member may sit at a prompt before their lead comes to you: leads answer crew prompts within 1–5 minutes. */
export const GRACE_MS = 6 * 60 * 1000;

/**
 * The leads who come to the clearing: one per blocked team whose lead is running, in the order the
 * teams are listed, except those you sent back about the very same thing.
 *
 * A lead who is blocked, and anyone waiting on your answer, bring the lead at once. A crew member
 * at a prompt does so only once `blockedSince` (when each agent became blocked) says they have
 * been there GRACE_MS by `now`; one it does not know counts as just blocked. Without `grace`
 * nobody waits. `spotAt` says where the i-th of them stands (see callerIn).
 */
export function calls(
  teams: WorldTeam[],
  agents: Map<string, WorldAgent>,
  sentBack: ReadonlySet<string>,
  spotAt: (i: number) => Spot,
  grace?: { blockedSince: ReadonlyMap<string, number>; now: number },
): Call[] {
  const out: Call[] = [];
  for (const team of teams) {
    if (team.status !== "blocked") continue;
    const lead = [...agents.values()].find((a) => a.teamId === team.id && a.role === "lead");
    if (!lead || lead.status === "offline") continue;
    const due = (id: string) => {
      const a = agents.get(id)!;
      return !grace || a.id === lead.id || a.waitingOnYou || grace.now - (grace.blockedSince.get(id) ?? grace.now) >= GRACE_MS;
    };
    const stuck = team.blockedBy.filter((id) => agents.has(id) && due(id)).sort((a, b) => Number(b === lead.id) - Number(a === lead.id));
    if (!stuck.length) continue;
    const key = `${team.id}:${[...stuck].sort().map((id) => `${id}${agents.get(id)!.waitingOnYou ? "?" : "!"}`).join(",")}`;
    if (sentBack.has(key)) continue;
    out.push({ teamId: team.id, leadId: lead.id, stuckIds: stuck, key, spot: spotAt(out.length) });
  }
  return out;
}

/** How long it takes to walk from one spot to another along the building's paths, in milliseconds. */
export function walkMs(from: Spot, to: Spot, walk: RouteFn): number {
  return (length(from.pos, walk(from.pos, from, to)) / WALK_SPEED) * 1000;
}

const length = (from: Vec2, path: Vec2[]) => path.reduce((sum, p, i) => sum + Math.hypot(p[0] - (path[i - 1] ?? from)[0], p[1] - (path[i - 1] ?? from)[1]), 0);

export function plan(messages: Message[], office: BuildingPlan, now: number): { visits: Visit[]; bubbles: Bubble[] } {
  const visits: Visit[] = [];
  const bubbles: Bubble[] = [];
  const walk = routeIn(office);
  for (const m of messages) {
    const text = bubbleText(m);
    if (!m.fromAgentId) {
      for (const d of m.deliveries) bubbles.push({ agentId: d.agentId, text, kind: m.kind, until: now + BUBBLE_MS });
      continue;
    }
    const toId = m.deliveries[0]?.agentId;
    const from = office.spots.get(m.fromAgentId);
    const target = toId ? office.spots.get(toId) : undefined;
    if (!toId || !from || !target || toId === m.fromAgentId) continue;
    const spot = visitSpot(target);
    visits.push({ messageId: m.id, fromId: m.fromAgentId, toId, kind: m.kind, text, spot, until: now + walkMs(from, spot, walk) + TALK_MS });
  }
  return { visits, bubbles };
}
