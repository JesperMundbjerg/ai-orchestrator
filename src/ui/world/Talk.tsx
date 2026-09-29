// What people in the office say to each other and the work they hand over, as rows the team
// panel and the board both show.

import { useEffect, useRef, useState } from "react";
import type { Message, MessageKind, WorkState, Work, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ago } from "../format.ts";

const DELIVERY_LABEL = { queued: "waiting until free", sending: "typing…", delivered: "took it up", failed: "not delivered" } as const;

/** Between the sender and the people it went to: "Karl hands over to Agnes". */
const VERB: Record<MessageKind, string> = { instruction: "to", message: "to", handoff: "hands over to", review: "reviewed the work of" };

export const WORK_LABEL: Record<WorkState, string> = { in_review: "in review", accepted: "accepted", changes_requested: "changes requested" };

/** The messages a team took part in: addressed to it, said by a member, or heard by one. */
export function teamMessages(world: WorldState, teamId: string): Message[] {
  const members = new Set(world.agents.filter((a) => a.teamId === teamId).map((a) => a.id));
  return world.messages.filter((m) => m.teamId === teamId || (m.fromAgentId && members.has(m.fromAgentId)) || m.deliveries.some((d) => members.has(d.agentId)));
}

/** The messages an agent sent or was sent, newest first. */
export function agentMessages(world: WorldState, agentId: string): Message[] {
  return world.messages.filter((m) => m.fromAgentId === agentId || m.deliveries.some((d) => d.agentId === agentId));
}

/** You and an agent talking: what you said to it (or to the team it leads) and its answers, oldest first. */
export function conversation(world: WorldState, agentId: string): Message[] {
  return world.withFounder.filter((m) => (m.toFounder ? m.fromAgentId === agentId : m.deliveries.some((d) => d.agentId === agentId))).reverse();
}

/** Work a team handed over or has to review, open work first. */
export function teamWork(world: WorldState, teamId: string): Work[] {
  return world.work.filter((w) => w.toTeamId === teamId || w.fromTeamId === teamId);
}

export function MessageRow({ message, agents }: { message: Message; agents: Map<string, WorldAgent> }) {
  const [error, setError] = useState<string | null>(null);
  const from = message.fromAgentId ? (agents.get(message.fromAgentId)?.name ?? "someone who left") : "You";
  const to = message.toFounder ? "you" : message.deliveries.map((d) => agents.get(d.agentId)?.name ?? "someone").join(", ");
  const failure = message.deliveries.find((d) => d.error)?.error;
  return (
    <li className={`order ${message.kind}`}>
      <div className="order-head">
        <strong>{from}</strong>
        <span className="muted"> {VERB[message.kind]} {to}</span>
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

/** Your instruction to a team: typed into its first mate's (or lead's) terminal once free. */
export function TellTeam({ team, members }: { team: WorldTeam; members: WorldAgent[] }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lead = members.find((m) => m.role === "lead") ?? null;
  const send = () => {
    setSending(true);
    api.instructTeam(team.id, text).then(
      () => (setText(""), setError(null)),
      (e: Error) => setError(e.message),
    ).finally(() => setSending(false));
  };
  return (
    <form
      className="instruct"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !sending) send();
      }}
    >
      <div className="section-label">Tell {team.name}</div>
      <textarea
        value={text}
        rows={3}
        placeholder={`What should ${team.name} do? ${lead?.name ?? (team.standing ? "The lead" : "The first mate")} ${team.standing ? "divides it among the crew" : "plans it and runs the crew"}.`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.currentTarget.form?.requestSubmit()}
      />
      <div className="row">
        <button className="primary small" type="submit" disabled={!text.trim() || sending || !lead}>Send to {team.name}</button>
        <span className="muted small-note">{lead ? `Typed into ${lead.name}'s terminal once free.` : "Nobody on it yet."}</span>
      </div>
      {error ? <div className="warn">{error}</div> : null}
    </form>
  );
}

/** The thread between you and an agent, newest at the bottom, kept in view as it grows. */
export function Conversation({ agent, messages }: { agent: WorldAgent; messages: Message[] }) {
  const list = useRef<HTMLOListElement>(null);
  const last = messages.at(-1)?.id;
  // Only the thread scrolls to its newest line; the panel around it stays where it is.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [last]);
  if (!messages.length) return null;
  return (
    <ol ref={list} className="chat" aria-label={`You and ${agent.name}`}>
      {messages.map((m) => {
        const mine = !m.fromAgentId;
        const delivery = mine ? m.deliveries.find((d) => d.agentId === agent.id) : undefined;
        return (
          <li key={m.id} className={`say ${mine ? "you" : "them"}`}>
            <div className="say-head">
              {mine ? "You" : agent.name}
              {m.kind === "instruction" ? " to the project" : ""} · {ago(m.createdAt)}
              {delivery && delivery.state !== "delivered" ? ` · ${DELIVERY_LABEL[delivery.state]}` : ""}
            </div>
            <div className="say-text">{m.text}</div>
          </li>
        );
      })}
    </ol>
  );
}

/** Your message to one agent: typed into its terminal once it is free. */
export function TellAgent({ agent }: { agent: WorldAgent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = () => {
    setSending(true);
    api.tellAgent(agent.id, text).then(
      () => (setText(""), setError(null)),
      (e: Error) => setError(e.message),
    ).finally(() => setSending(false));
  };
  return (
    <form
      className="instruct"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !sending) send();
      }}
    >
      <textarea
        value={text}
        rows={3}
        autoFocus
        aria-label={`Message ${agent.name}`}
        placeholder={`Write to ${agent.name}…`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <div className="row">
        <button className="primary small" type="submit" disabled={!text.trim() || sending}>Send</button>
        <span className="muted small-note">{agent.paneId ? `Typed into ${agent.name}'s terminal once free · ⌘↵` : `${agent.name} is not running; it waits until they are.`}</span>
      </div>
      {error ? <div className="warn">{error}</div> : null}
    </form>
  );
}
