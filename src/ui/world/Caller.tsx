// A lead at your desk: what their team is stuck on, and what you can do about it from here.
//
//   someone waits for your answer → the same answer card as the inbox, screenshots first when it has them
//   someone is stuck at a prompt  → who, in one line, and: let the lead handle it, or open that agent
//
// A prompt in a terminal is answered where it is. The office cannot see what it asks (and never
// shows the terminal), so it offers no allow or deny: pressing a key blind could approve anything.

import { useState } from "react";
import type { WorldAgent, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ItemDetailView } from "../components/ItemDetail.tsx";
import { useItemDetail } from "../hooks.ts";
import { TYPE_LABEL } from "../format.ts";
import type { Call } from "./visits.ts";
import type { Waiting } from "./WorldView.tsx";

/** What a lead is asked to do when you leave someone's prompt to them. */
export function handleIt(stuck: WorldAgent): string {
  return `${stuck.name} is stuck at a prompt in their herdr pane. Look at it and answer it if it is yours to answer, or tell me in one line what you need from me.`;
}

export function CallerCard({ call, team, agents, waiting, tick, onOpen, onDismiss }: {
  call: Call;
  team: WorldTeam;
  agents: Map<string, WorldAgent>;
  waiting: Map<string, Waiting>;
  tick: number;
  onOpen: (agentId: string) => void;
  onDismiss: () => void;
}) {
  const lead = agents.get(call.leadId)!;
  const stuck = call.stuckIds.flatMap((id) => agents.get(id) ?? []);
  // One question at a time, as at the inbox: the first that waits for you, the rest as a list.
  const asking = stuck.filter((a) => waiting.has(a.id));
  const [itemId, setItemId] = useState<string | null>(null);
  const shown = itemId && asking.some((a) => waiting.get(a.id)!.itemIds.includes(itemId)) ? itemId : (asking[0] ? waiting.get(asking[0].id)!.itemIds[0]! : null);
  const detail = useItemDetail(shown, tick);
  const atPrompt = stuck.filter((a) => !waiting.has(a.id));
  const others = asking.flatMap((a) => waiting.get(a.id)!.itemIds.map((id) => ({ agent: a, id }))).filter((x) => x.id !== shown);

  return (
    <aside className="world-caller" role="dialog" aria-label={`${lead.name} came over`}>
      <div className="panel-head">
        <strong>{lead.name} came over from {team.name}</strong>
        <button className="ghost small" onClick={onDismiss} title={`${lead.name} goes back to their desk`}>Not now <kbd>Esc</kbd></button>
      </div>
      <p className="caller-says">“{said(lead, stuck, waiting)}”</p>

      {atPrompt.map((a) => <AtPrompt key={a.id} agent={a} lead={lead} onOpen={onOpen} onHandled={onDismiss} />)}

      {others.length ? (
        <div className="agent-waiting">
          {others.map(({ agent, id }) => (
            <button key={id} className="waiting-item" onClick={() => setItemId(id)}>
              <span className={`type ${waiting.get(agent.id)!.type}`}>{TYPE_LABEL[waiting.get(agent.id)!.type]}</span> Also from {agent.name}
            </button>
          ))}
        </div>
      ) : null}

      {detail ? <div className="caller-item"><ItemDetailView key={detail.item.id} detail={detail} onNext={null} /></div> : shown ? <div className="muted">Opening the question…</div> : null}
    </aside>
  );
}

/** A line while the lead is still walking over, so the walk is never unexplained. It goes when the call does. */
export function CallerNote({ call, agents }: { call: Call; agents: Map<string, WorldAgent> }) {
  const lead = agents.get(call.leadId);
  const stuck = call.stuckIds.flatMap((id) => agents.get(id) ?? []);
  if (!lead || !stuck.length) return null;
  const why = stuck
    .map((a) => {
      const own = a.id === lead.id;
      if (a.waitingOnYou) return own ? "needs your answer" : `${a.name} needs your answer`;
      return own ? "stuck at their own prompt" : `${a.name} is stuck at a prompt`;
    })
    .join(", ");
  return (
    <div
      role="status"
      style={{ position: "absolute", zIndex: 4, left: "50%", bottom: 64, transform: "translateX(-50%)", maxWidth: "calc(100% - 24px)", padding: "6px 14px", borderRadius: 999, background: "var(--panel)", boxShadow: "0 8px 24px rgba(0,0,0,0.25)", borderLeft: "4px solid #ff5a4f", fontSize: 13 }}
    >
      <strong>{lead.name}</strong> is coming over: {why}
    </div>
  );
}

/** What the lead says when they arrive, in their own voice. */
function said(lead: WorldAgent, stuck: WorldAgent[], waiting: Map<string, Waiting>): string {
  const who = (a: WorldAgent) => (a.id === lead.id ? "I" : a.name);
  const parts = stuck.map((a) => {
    if (waiting.has(a.id)) return `${who(a)} need${a.id === lead.id ? "" : "s"} your answer to go on`;
    return a.id === lead.id ? "I am stuck at a prompt in my terminal" : `${a.name} is stuck at a prompt in their terminal`;
  });
  return `${parts.join(", and ")}.`;
}

function AtPrompt({ agent, lead, onOpen, onHandled }: { agent: WorldAgent; lead: WorldAgent; onOpen: (id: string) => void; onHandled: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = agent.id === lead.id;
  // A lead who is stuck themselves cannot take a message until they are free again.
  const leadCanHandle = !own && lead.status !== "blocked" && !lead.waitingOnYou;
  const handOver = () => {
    setSending(true);
    api.tellAgent(lead.id, handleIt(agent)).then(onHandled, (e: Error) => (setError(e.message), setSending(false)));
  };
  return (
    <div className="caller-prompt">
      <div>
        <strong>{agent.name}</strong> {own ? "is" : `(${agent.role === "lead" ? "lead" : "crew"}) is`} waiting at a question in their terminal
        {agent.doing ? <span className="muted"> · last seen doing {agent.doing}</span> : null}
      </div>
      <div className="muted small-note">
        {leadCanHandle ? `${lead.name} can look at it and answer it, or tell you what it needs.` : `It is answered in ${agent.name}'s terminal in herdr.`}
      </div>
      <div className="row">
        {leadCanHandle ? <button className="primary small" disabled={sending} onClick={handOver}>Let {lead.name} handle it</button> : null}
        <button className="ghost small" onClick={() => onOpen(agent.id)}>Open {agent.name}</button>
      </div>
      {error ? <div className="warn">{error}</div> : null}
    </div>
  );
}
