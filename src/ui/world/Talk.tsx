// What people in the office say to each other and the work they hand over, as rows the team
// panel and the board both show.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Message, MessageKind, WorkState, Work, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { leftBeforeArrival } from "../../shared/delivery.ts";
import { ago } from "../format.ts";
import { AttachedImages, Images, useAttachments } from "../components/Attach.tsx";
import { SEND_HINT, sendOnEnter } from "../sendKey.ts";

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

/** Whether a message is part of your own thread: something you said, or an answer addressed to you. */
export const withMe = (m: Message) => Boolean(m.toFounder) || (!m.fromAgentId && !m.fromOffice);

/** "With me" shows only your own thread; "Everything" adds what agents said to each other. */
export type ThreadView = "me" | "all";
const VIEW_KEY = "review-inbox.thread-view";
const viewListeners = new Set<() => void>();
let view: ThreadView | null = null;

const currentView = (): ThreadView => {
  if (view === null) {
    try {
      view = localStorage.getItem(VIEW_KEY) === "all" ? "all" : "me";
    } catch {
      view = "me";
    }
  }
  return view;
};

/** The choice is one for the browser, so every thread (panels and board) follows the same toggle. */
export function useThreadView(): [ThreadView, (next: ThreadView) => void] {
  const now = useSyncExternalStore((cb) => (viewListeners.add(cb), () => void viewListeners.delete(cb)), currentView);
  const set = (next: ThreadView) => {
    view = next;
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Private windows and blocked storage: the choice still holds until the page is closed.
    }
    viewListeners.forEach((cb) => cb());
  };
  return [now, set];
}

/** The small switch at the top of a thread. */
export function ThreadToggle() {
  const [now, set] = useThreadView();
  return (
    <span className="thread-toggle" role="group" aria-label="Which messages to show">
      <button type="button" aria-pressed={now === "me"} onClick={() => set("me")}>With me</button>
      <button type="button" aria-pressed={now === "all"} onClick={() => set("all")}>Everything</button>
    </span>
  );
}

/** The quiet line where agent-to-agent talk was left out, with a way to show it. */
export function HiddenLine({ count }: { count: number }) {
  const [now, set] = useThreadView();
  if (now !== "me" || !count) return null;
  return (
    <div className="muted small-note hidden-line">
      {count} {count === 1 ? "message" : "messages"} between agents hidden · <button type="button" className="link" onClick={() => set("all")}>Show</button>
    </div>
  );
}

/** Work a team handed over or has to review, open work first. */
export function teamWork(world: WorldState, teamId: string): Work[] {
  return world.work.filter((w) => w.toTeamId === teamId || w.fromTeamId === teamId);
}

/** Long text folded to a few lines with a fade and a toggle; text that fits shows no toggle. */
function Clamp({ text, className }: { text: string; className: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Folded is the resting state, so measure against it; open keeps whatever was found.
    const measure = () => !open && setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [text, open]);
  return (
    <>
      <div ref={box} className={`${className} clamp${open ? "" : " folded"}${long && !open ? " faded" : ""}`}>{text}</div>
      {long ? <button type="button" className="ghost small clamp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button> : null}
    </>
  );
}

export function MessageRow({ message, agents }: { message: Message; agents: Map<string, WorldAgent> }) {
  const [error, setError] = useState<string | null>(null);
  const from = message.fromAgentId ? (agents.get(message.fromAgentId)?.name ?? "someone who left") : message.fromOffice ? "The office" : "You";
  const mine = !message.fromAgentId && !message.fromOffice;
  const to = message.toFounder ? "you" : message.deliveries.map((d) => agents.get(d.agentId)?.name ?? "someone").join(", ");
  const failure = message.deliveries.find((d) => d.error && !leftBeforeArrival(d, agents.get(d.agentId)))?.error;
  return (
    <li className={`order ${message.kind}${message.toFounder ? " to-you" : mine ? " from-you" : ""}`}>
      <div className="order-head">
        {message.toFounder ? <span className="for-you">answer to you</span> : mine ? <span className="for-you mine">you said</span> : null}
        {message.allLeads ? <span className="for-you mine">All-leads broadcast</span> : null}
        <strong>{from}</strong>
        <span className="muted"> {VERB[message.kind]} {to}</span>
        <span className="muted"> · {ago(message.createdAt)}</span>
      </div>
      {/* Anything said to or by you is shown whole; only agents' talk to each other folds. */}
      {message.toFounder || !message.fromAgentId ? (message.text ? <div className="order-text">{message.text}</div> : null) : <Clamp text={message.text} className="order-text" />}
      <Images ids={message.images} />
      <div className="order-meta">
        {message.deliveries.map((d) => (
          <span key={d.agentId} className={`delivery ${d.state}`} title={d.error ?? undefined}>
            {agents.get(d.agentId)?.name ?? "someone"}: {leftBeforeArrival(d, agents.get(d.agentId)) ? "left before it arrived" : DELIVERY_LABEL[d.state]}
            {d.state === "failed" && !leftBeforeArrival(d, agents.get(d.agentId)) ? (
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
      <Clamp text={work.summary} className="order-text" />
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
  const attachments = useAttachments();
  const ready = Boolean((text.trim() || attachments.ids.length) && !attachments.uploading);
  const canSend = ready && !sending && Boolean(lead);
  const send = () => {
    if (!canSend) return;
    setSending(true);
    api.instructTeam(team.id, text, attachments.ids).then(
      () => (setText(""), attachments.clear(), setError(null)),
      (e: Error) => setError(e.message),
    ).finally(() => setSending(false));
  };
  return (
    <form
      className={`instruct${attachments.dragging ? " dropping" : ""}`}
      {...attachments.drop}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="section-label">Tell {team.name}</div>
      <textarea
        value={text}
        rows={3}
        placeholder={`What should ${team.name} do? ${lead?.name ?? (team.standing ? "The lead" : "The first mate")} ${team.standing ? "divides it among the crew" : "plans it and runs the crew"}.`}
        onChange={(e) => setText(e.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={sendOnEnter(send)}
      />
      <AttachedImages attachments={attachments} />
      <div className="row">
        <button className="primary small" type="submit" disabled={!canSend}>Send to {team.name}</button>
        <span className="muted small-note">{lead ? `Typed into ${lead.name}'s terminal once free · ${SEND_HINT}. Paste or drop images to show them.` : "Nobody on it yet."}</span>
      </div>
      {error ? <div className="warn">{error}</div> : null}
    </form>
  );
}

/** The thread between you and an agent, newest at the bottom, kept in view as it grows. */
export function Conversation({ agent, messages, between }: { agent: WorldAgent; messages: Message[]; between: number }) {
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const last = messages.at(-1)?.id;
  // The thread is as tall as it is; the panel scrolls. Bring the newest line into view on open and on a reply.
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [last]);
  const wrote = messages.some((m) => !m.fromAgentId);
  const answered = messages.some((m) => m.fromAgentId);
  return (
    <>
      <div className="thread-head">
        <div className="section-label thread-title">You and {agent.name}</div>
        <ThreadToggle />
      </div>
      {wrote && !answered ? <div className="muted small-note thread-empty">{agent.name} hasn't answered you yet.</div> : null}
      {messages.length ? (
    <ol ref={list} className="chat" aria-label={`You and ${agent.name}`}>
      {messages.map((m) => {
        const mine = !m.fromAgentId;
        const delivery = mine ? m.deliveries.find((d) => d.agentId === agent.id) : undefined;
        return (
          <li key={m.id} className={`say ${mine ? "you" : "them"}`}>
            <div className="say-head">
              {mine ? "You" : <>{agent.name} <span className="for-you">to you</span></>}
              {m.allLeads ? " · All-leads broadcast" : m.kind === "instruction" ? " to the project" : ""} · {ago(m.createdAt)}
              {delivery && delivery.state !== "delivered" ? ` · ${leftBeforeArrival(delivery, agent) ? "left before it arrived" : DELIVERY_LABEL[delivery.state]}` : ""}
              {delivery?.state === "failed" && !leftBeforeArrival(delivery, agent) ? <button className="ghost small" onClick={() => void api.retryDelivery(m.id, agent.id).catch((e: Error) => setError(e.message))}>Retry</button> : null}
            </div>
            {m.text ? <div className="say-text">{m.text}</div> : null}
            <Images ids={m.images} />
          </li>
        );
      })}
    </ol>
      ) : null}
      {error ? <div className="warn small-note">{error}</div> : null}
      <HiddenLine count={between} />
    </>
  );
}

/** What agents said to each other about one agent: quieter than your thread, folded away when long. */
export function BetweenAgents({ messages, agents }: { messages: Message[]; agents: Map<string, WorldAgent> }) {
  const [view] = useThreadView();
  const long = messages.length > 3;
  const [open, setOpen] = useState(!long);
  if (!messages.length || view === "me") return null;
  return (
    <section className="between">
      <button type="button" className="section-label between-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden>{open ? "▾" : "▸"}</span> Between agents · {messages.length}
      </button>
      {open ? (
        <ul className="order-list">
          {messages.slice(0, 30).map((m) => <MessageRow key={m.id} message={m} agents={agents} />)}
        </ul>
      ) : null}
    </section>
  );
}

/** Your message to one agent: typed into its terminal once it is free. */
export function TellAgent({ agent }: { agent: WorldAgent }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const ready = Boolean((text.trim() || attachments.ids.length) && !attachments.uploading);
  const canSend = ready && !sending;
  const send = () => {
    if (!canSend) return;
    setSending(true);
    api.tellAgent(agent.id, text, attachments.ids).then(
      () => (setText(""), attachments.clear(), setError(null)),
      (e: Error) => setError(e.message),
    ).finally(() => setSending(false));
  };
  return (
    <form
      className={`instruct${attachments.dragging ? " dropping" : ""}`}
      {...attachments.drop}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        value={text}
        rows={3}
        autoFocus
        aria-label={`Message ${agent.name}`}
        placeholder={`Write to ${agent.name}… Paste or drop images to show them.`}
        onChange={(e) => setText(e.target.value)}
        onPaste={attachments.onPaste}
        onKeyDown={(e) => {
          sendOnEnter(send)(e);
          if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <AttachedImages attachments={attachments} />
      <div className="row">
        <button className="primary small" type="submit" disabled={!canSend}>Send</button>
        <span className="muted small-note">{agent.paneId ? `Typed into ${agent.name}'s terminal once free · ${SEND_HINT}` : `${agent.name} is not running; it waits until they are.`}</span>
      </div>
      {error ? <div className="warn">{error}</div> : null}
    </form>
  );
}
