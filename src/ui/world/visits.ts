// People talking in the office. Pure: from messages that arrived since the office opened it
// returns who walks over to whom and what they say, and what you said to whom.
//
//   an agent's message, handoff or review → the sender walks to the (first) recipient, says it
//                                           when there, carrying a folder for a handoff, and walks back
//   your instruction                      → a bubble over each agent it goes to
//   a blocked team                        → its lead comes to your desk and stays until it is
//                                           unblocked or you send them back
//
// Unlike the rest, a lead at your desk is standing state, not an event: it follows from how
// the teams stand right now, so it is there when the office opens too.

import type { Message, MessageKind, WorldAgent, WorldTeam } from "../../shared/types.ts";
import { callerSpot, route, yawTo, type OfficePlan, type Spot, type Vec2 } from "./layout.ts";

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
  const text = `${LEAD[message.kind]}${message.text.replace(/\s+/g, " ").trim()}`;
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

/** A lead at your desk because their team cannot go on without you. */
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

/**
 * The leads who come to your desk: one per blocked team whose lead is running, in the order the
 * teams are listed, except those you sent back about the very same thing.
 */
export function calls(teams: WorldTeam[], agents: Map<string, WorldAgent>, sentBack: ReadonlySet<string>): Call[] {
  const out: Call[] = [];
  for (const team of teams) {
    if (team.status !== "blocked") continue;
    const lead = [...agents.values()].find((a) => a.teamId === team.id && a.role === "lead");
    if (!lead || lead.status === "offline") continue;
    const stuck = team.blockedBy.filter((id) => agents.has(id)).sort((a, b) => Number(b === lead.id) - Number(a === lead.id));
    if (!stuck.length) continue;
    const key = `${team.id}:${[...stuck].sort().map((id) => `${id}${agents.get(id)!.waitingOnYou ? "?" : "!"}`).join(",")}`;
    if (sentBack.has(key)) continue;
    out.push({ teamId: team.id, leadId: lead.id, stuckIds: stuck, key, spot: callerSpot(out.length) });
  }
  return out;
}

/** How long it takes to walk from one spot to another, in milliseconds. */
export function walkMs(from: Spot, to: Spot): number {
  return (length(from.pos, route(from.pos, from, to)) / WALK_SPEED) * 1000;
}

const length = (from: Vec2, path: Vec2[]) => path.reduce((sum, p, i) => sum + Math.hypot(p[0] - (path[i - 1] ?? from)[0], p[1] - (path[i - 1] ?? from)[1]), 0);

export function plan(messages: Message[], office: OfficePlan, now: number): { visits: Visit[]; bubbles: Bubble[] } {
  const visits: Visit[] = [];
  const bubbles: Bubble[] = [];
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
    visits.push({ messageId: m.id, fromId: m.fromAgentId, toId, kind: m.kind, text, spot, until: now + walkMs(from, spot) + TALK_MS });
  }
  return { visits, bubbles };
}
