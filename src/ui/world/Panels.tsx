import { useEffect, useRef, useState, type ReactNode } from "react";
import { HARNESS_INFO } from "../../shared/harnesses.ts";
import { TEAM_STRUCTURES, type AgentScreen, type InboxState, type ItemDetail, type TeamOrder, type TeamStructure, type WorldAgent, type WorldState, type WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ItemDetailView } from "../components/ItemDetail.tsx";
import { ago, TYPE_LABEL } from "../format.ts";
import { LAMP } from "./Avatar.tsx";
import type { OfficePlan, Vec2 } from "./layout.ts";
import { TEAM_LAMP, teamLine } from "./team.ts";
import type { Waiting } from "./WorldView.tsx";

const STRUCTURE_LABEL: Record<TeamStructure, string> = {
  dispatch: "Lead + crew: the lead divides the work",
  circle: "Peers: they talk it through together",
};

/** The team list: where each team stands, open one, found a team, rename or disband one. */
export function TeamsPanel({ world, plan, agents, onOpen }: {
  world: WorldState;
  plan: OfficePlan;
  agents: Map<string, WorldAgent>;
  onOpen: (teamId: string, pos: Vec2, yaw: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lounge = world.agents.filter((a) => !a.teamId).length;
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  return (
    <aside className="world-panel teams">
      <div className="panel-head">
        <strong>Teams</strong>
        <button className="ghost small" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ New team"}</button>
      </div>
      {adding ? (
        <TeamForm
          submit="Create team"
          onSubmit={(name, structure) => run(api.createTeam({ name, structure }).then(() => setAdding(false)))}
        />
      ) : null}
      <ul className="team-list">
        {plan.corners.map(({ team, center }) => {
          const live = world.teams.find((t) => t.id === team.id)!;
          const line = teamLine(live, agents);
          return (
            <li key={team.id}>
              {editing === team.id ? (
                <TeamForm
                  initial={{ name: team.name, structure: team.structure }}
                  submit="Save"
                  onSubmit={(name, structure) => run(api.updateTeam(team.id, { name, structure }).then(() => setEditing(null)))}
                  extra={
                    <button
                      type="button"
                      className="ghost small danger"
                      onClick={() => confirm(`Disband ${team.name}? Its members go back to the lounge.`) && run(api.deleteTeam(team.id))}
                    >
                      Disband
                    </button>
                  }
                />
              ) : (
                <div className="team-row">
                  <button className={`team-go ${live.status}`} onClick={() => onOpen(team.id, [center[0], center[1] + 8.5], 0)} title="Open the team and walk over">
                    <span className="team-name">
                      <span className="lamp" style={{ background: TEAM_LAMP[live.status].color }} /> {team.name}
                    </span>
                    <span className={live.status === "blocked" ? "team-blocked" : "muted"}>{line.text}</span>
                    {live.projects.length ? <span className="muted small-note">{live.projects.join(" · ")}</span> : null}
                  </button>
                  <button className="ghost small" onClick={() => setEditing(team.id)} aria-label={`Edit ${team.name}`}>Edit</button>
                </div>
              )}
            </li>
          );
        })}
        {!plan.corners.length ? <li className="muted">No teams yet. Create one, then click an agent to seat them in it.</li> : null}
      </ul>
      <div className="muted small-note">{lounge} in the lounge. Click someone to move them into a team.</div>
      {error ? <div className="warn">{error}</div> : null}
    </aside>
  );
}

function TeamForm({ initial, submit, onSubmit, extra }: {
  initial?: { name: string; structure: TeamStructure };
  submit: string;
  onSubmit: (name: string, structure: TeamStructure) => void;
  extra?: ReactNode;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [structure, setStructure] = useState<TeamStructure>(initial?.structure ?? "dispatch");
  return (
    <form
      className="team-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim(), structure);
      }}
    >
      <input autoFocus placeholder="Team name, e.g. Mission Control" value={name} onChange={(e) => setName(e.target.value)} />
      {TEAM_STRUCTURES.map((s) => (
        <label key={s} className="radio">
          <input type="radio" name="structure" checked={structure === s} onChange={() => setStructure(s)} />
          {STRUCTURE_LABEL[s]}
        </label>
      ))}
      <div className="row">
        <button className="primary small" type="submit" disabled={!name.trim()}>{submit}</button>
        {extra}
      </div>
    </form>
  );
}

/**
 * One team up close: where it stands and who holds it up, what each member is doing, and
 * your instructions to it with how far each one got.
 */
export function TeamPanel({ team, agents, state, waiting, onAgent, onAnswer, onClose }: {
  team: WorldTeam;
  agents: Map<string, WorldAgent>;
  state: InboxState;
  waiting: Map<string, Waiting>;
  onAgent: (agentId: string) => void;
  onAnswer: (itemId: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = [...agents.values()].filter((a) => a.teamId === team.id).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"));
  const lead = members.find((m) => m.role === "lead") ?? null;
  const hearers = team.structure === "dispatch" ? (lead ? [lead] : []) : members.filter((m) => m.paneId);
  const line = teamLine(team, agents);
  const doing = (a: WorldAgent) => state.tasks.find((t) => a.taskIds.includes(t.id) && t.activity)?.activity ?? a.title ?? "";
  const send = () => {
    setSending(true);
    api.instructTeam(team.id, text).then(
      () => (setText(""), setError(null)),
      (e: Error) => setError(e.message),
    ).finally(() => setSending(false));
  };

  return (
    <aside className="world-panel agent">
      <div className="panel-head">
        <strong className="team-title">{team.name}</strong>
        <button className="ghost small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="agent-status">
        <span className="lamp" style={{ background: TEAM_LAMP[team.status].color }} />
        <span className={team.status === "blocked" ? "team-blocked" : ""}>{line.text}</span>
        <span className="muted"> · {team.structure === "dispatch" ? "lead + crew" : "peers"}{team.projects.length ? ` · ${team.projects.join(", ")}` : ""}</span>
      </div>

      {team.blockedBy.length ? (
        <div className="agent-waiting">
          {team.blockedBy.map((id) => {
            const a = agents.get(id);
            const w = waiting.get(id);
            if (!a) return null;
            return w ? (
              <button key={id} className="waiting-item" onClick={() => onAnswer(w.itemIds[0]!)}>
                <span className={`type ${w.type}`}>{TYPE_LABEL[w.type]}</span> {a.name} is waiting for your answer
              </button>
            ) : (
              <button key={id} className="waiting-item" onClick={() => onAgent(id)}>{a.name} is asking something in the terminal: look</button>
            );
          })}
        </div>
      ) : null}

      <div>
        <div className="section-label">Members</div>
        <ul className="member-list">
          {members.map((m) => (
            <li key={m.id}>
              <button className="member" onClick={() => onAgent(m.id)}>
                <span className="lamp" style={{ background: LAMP[m.status].color }} title={LAMP[m.status].label} />
                <span className="member-name">{m.name}{m.role === "lead" ? <span className="muted"> · lead</span> : null}</span>
                <span className="muted member-doing">{doing(m) || LAMP[m.status].label}</span>
              </button>
            </li>
          ))}
          {!members.length ? <li className="muted small-note">Nobody yet. Click an agent and pick this team.</li> : null}
        </ul>
      </div>

      <form
        className="instruct"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !sending) send();
        }}
      >
        <div className="section-label">Tell the team</div>
        <textarea
          value={text}
          rows={3}
          placeholder={team.structure === "dispatch" ? `What should ${team.name} do? ${lead?.name ?? "The lead"} divides it among the crew.` : `What should ${team.name} do? Every peer hears it.`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.currentTarget.form?.requestSubmit()}
        />
        <div className="row">
          <button className="primary small" type="submit" disabled={!text.trim() || sending || !hearers.length}>Send to {team.name}</button>
          <span className="muted small-note">
            {hearers.length ? `Typed into ${hearers.map((h) => h.name).join(" and ")}'s terminal once free.` : team.structure === "dispatch" ? "Pick a lead first." : "Nobody is running."}
          </span>
        </div>
        {error ? <div className="warn">{error}</div> : null}
      </form>

      {team.orders.length ? (
        <div>
          <div className="section-label">Your instructions</div>
          <ul className="order-list">
            {team.orders.map((o) => <OrderRow key={o.id} order={o} agents={agents} />)}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

const DELIVERY_LABEL = { queued: "waiting until free", sending: "typing…", delivered: "took it up", failed: "not delivered" } as const;

function OrderRow({ order, agents }: { order: TeamOrder; agents: Map<string, WorldAgent> }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="order">
      <div className="order-text">{order.text}</div>
      <div className="order-meta">
        <span className="muted">{ago(order.createdAt)}</span>
        {order.deliveries.map((d) => {
          const name = agents.get(d.agentId)?.name ?? "someone";
          return (
            <span key={d.agentId} className={`delivery ${d.state}`} title={d.error ?? undefined}>
              {name}: {DELIVERY_LABEL[d.state]}
              {d.state === "failed" ? (
                <button className="ghost small" onClick={() => void api.retryDelivery(order.id, d.agentId).catch((e: Error) => setError(e.message))}>Retry</button>
              ) : null}
            </span>
          );
        })}
      </div>
      {order.deliveries.some((d) => d.error) ? <div className="warn small-note">{order.deliveries.find((d) => d.error)!.error}</div> : null}
      {error ? <div className="warn small-note">{error}</div> : null}
    </li>
  );
}

/** One agent up close: who they are, what they are doing, their terminal, and their seat. */
export function AgentPanel({ agent, world, state, waiting, onAnswer, onGo, onClose, onTeam }: {
  agent: WorldAgent;
  world: WorldState;
  state: InboxState;
  waiting: Waiting | null;
  onAnswer: (itemId: string) => void;
  onGo: () => void;
  onClose: () => void;
  /** Back to the team panel this agent was opened from. */
  onTeam: (() => void) | null;
}) {
  const [name, setName] = useState(agent.name);
  const [error, setError] = useState<string | null>(null);
  const tasks = state.tasks.filter((t) => agent.taskIds.includes(t.id));
  const team = world.teams.find((t) => t.id === agent.teamId) ?? null;
  const items = waiting ? waiting.itemIds.map((id) => state.items.find((i) => i.id === id)!).filter(Boolean) : [];
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const rename = () => {
    if (name.trim() && name.trim() !== agent.name) void run(api.updateAgent(agent.id, { name: name.trim() }));
    else setName(agent.name);
  };

  return (
    <aside className="world-panel agent">
      {onTeam && team ? <button className="ghost small back" onClick={onTeam}>← {team.name}</button> : null}
      <div className="panel-head">
        <input
          className="agent-name"
          value={name}
          aria-label="Name"
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <button className="ghost small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="agent-status">
        <span className="lamp" style={{ background: LAMP[agent.status].color }} />
        {LAMP[agent.status].label}
        <span className="muted"> · {HARNESS_INFO[agent.harness].label}{agent.project ? ` · ${agent.project}` : ""}</span>
      </div>
      {agent.cwd ? <code className="agent-cwd" title={agent.cwd}>{agent.cwd}</code> : null}

      {items.length ? (
        <div className="agent-waiting">
          <div className="section-label">Waiting for you</div>
          {items.map((i) => (
            <button key={i.id} className="waiting-item" onClick={() => onAnswer(i.id)}>
              <span className={`type ${i.type}`}>{TYPE_LABEL[i.type]}</span> {i.title}
            </button>
          ))}
        </div>
      ) : null}

      {tasks.map((t) => (
        <div key={t.id} className="agent-task">
          <div className="section-label">{t.title}</div>
          {t.activity ? <div>Doing now: {t.activity}</div> : null}
          {t.nextMilestone ? <div className="muted">Next: {t.nextMilestone}</div> : null}
        </div>
      ))}

      <div className="agent-seat">
        <label>
          <span>Team</span>
          <select value={agent.teamId ?? ""} onChange={(e) => void run(api.updateAgent(agent.id, { teamId: e.target.value || null }))}>
            <option value="">Lounge (no team)</option>
            {world.teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        {team?.structure === "dispatch" ? (
          <label className="radio">
            <input type="checkbox" checked={agent.role === "lead"} onChange={(e) => void run(api.updateAgent(agent.id, { role: e.target.checked ? "lead" : "member" }))} />
            Lead of {team.name}
          </label>
        ) : null}
      </div>

      <div className="row">
        <button className="ghost small" onClick={onGo}>Walk over</button>
        {agent.paneId ? <button className="ghost small" onClick={() => void run(api.openAgent(agent.id))}>Open in herdr</button> : null}
      </div>
      {error ? <div className="warn">{error}</div> : null}

      {agent.paneId ? <Terminal agentId={agent.id} title={agent.title} /> : <p className="muted small-note">Not running in herdr, so there is no terminal to show.</p>}
    </aside>
  );
}

/** The agent's terminal as it is now, re-read every two seconds while the panel is open. */
function Terminal({ agentId, title }: { agentId: string; title: string | null }) {
  const [screen, setScreen] = useState<AgentScreen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = () =>
      api.agentScreen(agentId).then(
        (s) => live && (setScreen(s), setError(null)),
        (e: Error) => live && setError(e.message),
      ).finally(() => {
        if (live) timer = setTimeout(read, 2000);
      });
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [agentId]);

  // Follow the bottom like a terminal, unless you have scrolled up to read.
  useEffect(() => {
    const el = pre.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [screen?.text]);

  return (
    <div className="terminal">
      <div className="terminal-bar">{title ?? "terminal"}</div>
      <pre
        ref={pre}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {screen ? screen.text.replace(/\s+$/, "") : error ?? "Reading…"}
      </pre>
    </div>
  );
}

/** Answering at your desk: the same review view as the inbox, over the office. */
export function AnswerModal({ detail, agent, agents, onNext, onClose }: {
  detail: ItemDetail;
  agent: string | null;
  agents: Map<string, WorldAgent>;
  onNext: (() => void) | null;
  onClose: () => void;
}) {
  const who = agent ? agents.get(agent) : null;
  return (
    <div className="world-modal" role="dialog" aria-label="Answer" onClick={onClose}>
      <div className="world-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <strong>{who ? `${who.name} is asking` : "Waiting for you"}</strong>
          <button className="ghost small" onClick={onClose} aria-label="Close">✕ <kbd>Esc</kbd></button>
        </div>
        <ItemDetailView key={detail.item.id} detail={detail} onNext={onNext} />
      </div>
    </div>
  );
}

export function Legend() {
  const shown: Array<WorldAgent["status"]> = ["working", "blocked", "done", "idle", "offline"];
  return (
    <div className="world-legend">
      {shown.map((s) => (
        <span key={s}>
          <span className="lamp" style={{ background: LAMP[s].color }} />
          {LAMP[s].label}
        </span>
      ))}
    </div>
  );
}
