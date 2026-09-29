import { useState } from "react";
import { HARNESS_INFO } from "../../shared/harnesses.ts";
import type { InboxState, ItemDetail, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ItemDetailView } from "../components/ItemDetail.tsx";
import { finishTeam, leadTitle, TeamForm } from "../components/TeamForm.tsx";
import { ago, TYPE_LABEL } from "../format.ts";
import type { OfficePlan, Vec2 } from "./layout.ts";
import { agentMessages, MessageRow, teamMessages, teamWork, TellAgent, TellTeam, WorkRow } from "./Talk.tsx";
import { LAMP, TEAM_LAMP, teamLine } from "./status.ts";
import type { Waiting } from "./WorldView.tsx";

/** The project list: where each stands, open one, start a project, change or finish one. */
export function TeamsPanel({ world, plan, agents, onOpen }: {
  world: WorldState;
  plan: OfficePlan;
  agents: Map<string, WorldAgent>;
  onOpen: (teamId: string, pos: Vec2, yaw: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lounge = world.agents.filter((a) => !a.teamId).length;
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  return (
    <aside className="world-panel teams">
      <div className="panel-head">
        <strong>Projects</strong>
        <button className="ghost small" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ New project"}</button>
      </div>
      {adding ? (
        <TeamForm
          submit="Start"
          teams={world.teams}
          repositories={world.repositories}
          onSubmit={(fields) => run(api.createTeam(fields).then(() => setAdding(false)))}
        />
      ) : null}
      {note ? <div className="board-note small-note">{note}<button className="ghost small" onClick={() => setNote(null)}>OK</button></div> : null}
      <ul className="team-list">
        {plan.corners.map(({ team, center }) => {
          const live = world.teams.find((t) => t.id === team.id)!;
          const line = teamLine(live, agents);
          return (
            <li key={team.id}>
              {editing === team.id ? (
                <TeamForm
                  initial={team}
                  teams={world.teams}
                  repositories={world.repositories}
                  submit="Save"
                  onSubmit={(fields) => run(api.updateTeam(team.id, fields).then(() => setEditing(null)))}
                  extra={
                    <button type="button" className="ghost small danger" onClick={() => void run(finishTeam(live).then((said) => said && (setNote(said), setEditing(null))))}>
                      {team.standing ? "Disband" : "Finish project"}
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
                    <span className="muted small-note">{team.standing ? "Always on" : team.branch}</span>
                  </button>
                  <button className="ghost small" onClick={() => setEditing(team.id)} aria-label={`Edit ${team.name}`}>Edit</button>
                </div>
              )}
            </li>
          );
        })}
        {!plan.corners.length ? <li className="muted">No projects yet. Start one, or start an agent in a worktree.</li> : null}
      </ul>
      <div className="muted small-note">{lounge} in the lounge, not working in a project's worktree. Click someone to move them.</div>
      {error ? <div className="warn">{error}</div> : null}
    </aside>
  );
}

/**
 * One team up close: where it stands and who holds it up, what each member is doing, the
 * work it handed over or has to review, and what was said in it with how far each got.
 */
export function TeamPanel({ team, world, agents, state, waiting, onAgent, onAnswer, onClose }: {
  team: WorldTeam;
  world: WorldState;
  agents: Map<string, WorldAgent>;
  state: InboxState;
  waiting: Map<string, Waiting>;
  onAgent: (agentId: string) => void;
  onAnswer: (itemId: string) => void;
  onClose: () => void;
}) {
  const members = [...agents.values()].filter((a) => a.teamId === team.id).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"));
  const line = teamLine(team, agents);
  const doing = (a: WorldAgent) => a.doing ?? state.tasks.find((t) => a.taskIds.includes(t.id) && t.activity)?.activity ?? a.title ?? "";
  const work = teamWork(world, team.id);
  const talk = teamMessages(world, team.id).slice(0, 15);

  return (
    <aside className="world-panel agent">
      <div className="panel-head">
        <strong className="team-title">{team.name}</strong>
        <button className="ghost small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="agent-status">
        <span className="lamp" style={{ background: TEAM_LAMP[team.status].color }} />
        <span className={team.status === "blocked" ? "team-blocked" : ""}>{line.text}</span>
        <span className="muted" title={team.path ?? undefined}> · {team.standing ? "always on" : `worktree on ${team.branch ?? "an unknown branch"}`}</span>
      </div>

      {team.purpose ? <p className="team-purpose">{team.purpose}</p> : null}
      {team.handsTo ? <div className="muted small-note">Hands its finished work to {world.teams.find((t) => t.id === team.handsTo)?.name ?? "another team"}.</div> : null}

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
              <button key={id} className="waiting-item" onClick={() => onAgent(id)}>{a.name} is stuck at a question: open them</button>
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
                <span className="member-name">{m.name}{m.role === "lead" ? <span className="muted"> · {leadTitle(team).toLowerCase()}</span> : null}</span>
                <span className="muted member-doing">{doing(m) || LAMP[m.status].label}{m.helpers.length ? ` · ${m.helpers.length} ${m.helpers.length === 1 ? "helper" : "helpers"}` : ""}</span>
              </button>
            </li>
          ))}
          {!members.length ? <li className="muted small-note">Nobody yet. Start an agent in its worktree, or click an agent and pick this project.</li> : null}
        </ul>
      </div>

      <TellTeam team={team} members={members} />

      {work.length ? (
        <div>
          <div className="section-label">Work handed over</div>
          <ul className="order-list">
            {work.map((w) => <WorkRow key={w.id} work={w} world={world} agents={agents} />)}
          </ul>
        </div>
      ) : null}

      {talk.length ? (
        <div>
          <div className="section-label">Said in and to {team.name}</div>
          <ul className="order-list">
            {talk.map((m) => <MessageRow key={m.id} message={m} agents={agents} />)}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

/** One agent up close: who they are, what they are doing, a box to message them, and their seat. */
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
  const agents = new Map(world.agents.map((a) => [a.id, a]));
  const said = agentMessages(world, agent.id).slice(0, 8);
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
      <TellAgent agent={agent} />
      {agent.cwd ? <code className="agent-cwd" title={agent.cwd}>{agent.cwd}</code> : null}
      {agent.doing ? <div className="agent-doing">{agent.doing}</div> : null}
      {agent.helpers.length ? (
        <div className="agent-helpers">
          <span className="muted">Helpers running:</span> {agent.helpers.map((h) => `${h.type}, started ${ago(h.startedAt)}`).join(", ")}
        </div>
      ) : null}

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
          <span>Project</span>
          <select value={agent.teamId ?? ""} onChange={(e) => void run(api.updateAgent(agent.id, { teamId: e.target.value || null }))}>
            <option value="">Its own worktree's project, or the lounge</option>
            {world.teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
        {team && agent.role !== "lead" ? (
          <button className="ghost small" onClick={() => void run(api.updateAgent(agent.id, { role: "lead" }))}>Make {agent.name} the {leadTitle(team).toLowerCase()}</button>
        ) : team ? <span className="muted small-note">{leadTitle(team)} of {team.name}</span> : null}
      </div>

      <div className="row">
        <button className="ghost small" onClick={onGo}>Walk over</button>
      </div>
      {error ? <div className="warn">{error}</div> : null}

      {said.length ? (
        <>
          <div className="section-label">Said to and by {agent.name}</div>
          <ul className="order-list">
            {said.map((m) => <MessageRow key={m.id} message={m} agents={agents} />)}
          </ul>
        </>
      ) : null}
    </aside>
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
