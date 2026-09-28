// People talking in the office. Pure: from messages that arrived since the office opened it
// returns who walks over to whom and what they say, and what you said to whom.
//
//   an agent's message, handoff or review → the sender walks to the (first) recipient, says it
//                                           when there, carrying a folder for a handoff, and walks back
//   your instruction                      → a bubble over each agent it goes to

import type { Message, MessageKind } from "../../shared/types.ts";
import { route, yawTo, type OfficePlan, type Spot, type Vec2 } from "./layout.ts";

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
    const walk = length(from.pos, route(from.pos, from, spot)) / WALK_SPEED;
    visits.push({ messageId: m.id, fromId: m.fromAgentId, toId, kind: m.kind, text, spot, until: now + walk * 1000 + TALK_MS });
  }
  return { visits, bubbles };
}
