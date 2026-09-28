// What people in the office say to each other and the work they hand over, as rows the team
// panel and the board both show.

import { useState } from "react";
import type { Message, MessageKind, WorkState, Work, WorldAgent, WorldState } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ago } from "../format.ts";

const DELIVERY_LABEL = { queued: "waiting until free", sending: "typing…", delivered: "took it up", failed: "not delivered" } as const;

const KIND_LABEL: Record<MessageKind, string> = { instruction: "You", message: "Says", handoff: "Hands over", review: "Review" };

export const WORK_LABEL: Record<WorkState, string> = { in_review: "in review", accepted: "accepted", changes_requested: "changes requested" };

/** The messages a team took part in: addressed to it, said by a member, or heard by one. */
export function teamMessages(world: WorldState, teamId: string): Message[] {
  const members = new Set(world.agents.filter((a) => a.teamId === teamId).map((a) => a.id));
  return world.messages.filter((m) => m.teamId === teamId || (m.fromAgentId && members.has(m.fromAgentId)) || m.deliveries.some((d) => members.has(d.agentId)));
}

/** Work a team handed over or has to review, open work first. */
export function teamWork(world: WorldState, teamId: string): Work[] {
  return world.work.filter((w) => w.toTeamId === teamId || w.fromTeamId === teamId);
}

export function MessageRow({ message, agents }: { message: Message; agents: Map<string, WorldAgent> }) {
  const [error, setError] = useState<string | null>(null);
  const from = message.fromAgentId ? (agents.get(message.fromAgentId)?.name ?? "someone who left") : "You";
  const to = message.deliveries.map((d) => agents.get(d.agentId)?.name ?? "someone").join(", ");
  const failure = message.deliveries.find((d) => d.error)?.error;
  return (
    <li className={`order ${message.kind}`}>
      <div className="order-head">
        <strong>{from}</strong>
        <span className="muted"> {message.kind === "instruction" ? "→" : KIND_LABEL[message.kind].toLowerCase()} {to}</span>
        <span className="muted"> · {ago(message.createdAt)}</span>
      </div>
      <div className="order-text">{message.text}</div>
      <div className="order-meta">
        {message.deliveries.map((d) => (
          <span key={d.agentId} className={`delivery ${d.state}`} title={d.error ?? undefined}>
            {agents.get(d.agentId)?.name ?? "someone"}: {DELIVERY_LABEL[d.state]}
            {d.state === "failed" ? (
              <button className="ghost small" onClick={() => void api.retryDelivery(message.id, d.agentId).catch((e: Error) => setError(e.message))}>Retry</button>
            ) : null}
          </span>
        ))}
      </div>
      {failure ? <div className="warn small-note">{failure}</div> : null}
      {error ? <div className="warn small-note">{error}</div> : null}
    </li>
  );
}

export function WorkRow({ work, world, agents }: { work: Work; world: WorldState; agents: Map<string, WorldAgent> }) {
  const from = agents.get(work.fromAgentId)?.name ?? "someone who left";
  const to = world.teams.find((t) => t.id === work.toTeamId)?.name ?? "a disbanded team";
  const reviewer = work.reviewerId ? agents.get(work.reviewerId)?.name : null;
  return (
    <li className={`work ${work.state}`}>
      <div className="order-head">
        <span className={`work-state ${work.state}`}>{WORK_LABEL[work.state]}</span>
        <strong> {work.title}</strong>
        <span className="muted"> · {from} → {to}{work.round > 1 ? ` · round ${work.round}` : ""} · {ago(work.updatedAt)}</span>
      </div>
      <div className="order-text">{work.summary}</div>
      {work.notes ? <div className="work-notes"><span className="muted">{reviewer ?? "Reviewer"}:</span> {work.notes}</div> : null}
    </li>
  );
}
