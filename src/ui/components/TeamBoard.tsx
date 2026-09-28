import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { InboxState, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { LAMP, TEAM_LAMP, teamLine } from "../world/status.ts";
import { MessageRow, TellTeam, WorkRow } from "../world/Talk.tsx";
import { TeamForm } from "./TeamForm.tsx";

const LOUNGE = "lounge";

/**
 * Teams at a glance, without walking the office: a column per team with where it stands and
 * who is in it (drag people between columns), the work flowing between teams and what was said.
 */
export function TeamBoard({ state, tick, onOffice }: { state: InboxState; tick: number; onOffice: () => void }) {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.world().then((w) => live && (setWorld(w), setError(null)), (e: Error) => live && setError(e.message));
    return () => void (live = false);
  }, [tick]);

  const agents = useMemo(() => new Map((world?.agents ?? []).map((a) => [a.id, a])), [world]);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));

  if (!world) return <main className="board">{error ? <p className="warn">The office did not answer ({error}).</p> : <p className="muted pad">Loading…</p>}</main>;

  const drop = (column: string) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData("text/agent");
    const teamId = column === LOUNGE ? null : column;
    if (id && agents.get(id)?.teamId !== teamId) void run(api.updateAgent(id, { teamId }));
  };
  const target = (column: string) => ({
    onDragOver: (e: DragEvent) => (e.preventDefault(), setOver(column)),
    onDragLeave: () => setOver((o) => (o === column ? null : o)),
    onDrop: drop(column),
  });
  const lounge = world.agents.filter((a) => !a.teamId);

  return (
    <main className="board team-board">
      <header className="board-head row">
        <div>
          <h1>Teams</h1>
          <p className="muted">Drag people between teams. Your instructions go to a team's lead, or to every peer; finished work flows to the team it hands to.</p>
        </div>
        <span className="spacer" />
        <button className="ghost small" onClick={onOffice}>Walk into the office →</button>
        <button className="primary small" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "+ New team"}</button>
      </header>
      {error ? <p className="warn">{error}</p> : null}
      {adding ? (
        <div className="team-column new">
          <TeamForm teams={world.teams} submit="Create team" onSubmit={(fields) => run(api.createTeam(fields).then(() => setAdding(false)))} />
        </div>
      ) : null}

      <div className="team-columns">
        {world.teams.map((t) => (
          <TeamColumn key={t.id} team={t} world={world} agents={agents} state={state} over={over === t.id} target={target(t.id)} run={run} />
        ))}
        <section className={`team-column lounge ${over === LOUNGE ? "over" : ""}`} {...target(LOUNGE)}>
          <div className="team-column-head">
            <strong>Lounge</strong>
            <span className="muted small-note">Not in a team · {lounge.length}</span>
          </div>
          <ul className="member-list">
            {lounge.map((a) => <MemberCard key={a.id} agent={a} team={null} state={state} run={run} />)}
          </ul>
        </section>
      </div>

      <div className="team-activity">
        <section>
          <h2>Work handed over</h2>
          <ul className="order-list">
            {world.work.map((w) => <WorkRow key={w.id} work={w} world={world} agents={agents} />)}
            {!world.work.length ? <li className="muted small-note">Nothing yet. A team hands work on with <code>inbox handoff</code>.</li> : null}
          </ul>
        </section>
        <section>
          <h2>What was said</h2>
          <ul className="order-list">
            {world.messages.slice(0, 30).map((m) => <MessageRow key={m.id} message={m} agents={agents} />)}
            {!world.messages.length ? <li className="muted small-note">Nobody has said anything yet.</li> : null}
          </ul>
        </section>
      </div>
    </main>
  );
}

function TeamColumn({ team, world, agents, state, over, target, run }: {
  team: WorldTeam;
  world: WorldState;
  agents: Map<string, WorldAgent>;
  state: InboxState;
  over: boolean;
  target: Record<string, (e: DragEvent) => void>;
  run: (p: Promise<unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const members = world.agents.filter((a) => a.teamId === team.id).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"));
  const line = teamLine(team, agents);
  const handsTo = team.handsTo ? world.teams.find((t) => t.id === team.handsTo)?.name : null;
  const toReview = world.work.filter((w) => w.toTeamId === team.id && w.state === "in_review").length;
  return (
    <section className={`team-column ${team.status} ${over ? "over" : ""}`} {...target}>
      {editing ? (
        <TeamForm
          initial={team}
          teams={world.teams}
          submit="Save"
          onSubmit={(fields) => run(api.updateTeam(team.id, fields).then(() => setEditing(false)))}
          extra={
            <>
              <button type="button" className="ghost small" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" className="ghost small danger" onClick={() => confirm(`Disband ${team.name}? Its members go back to the lounge.`) && run(api.deleteTeam(team.id))}>Disband</button>
            </>
          }
        />
      ) : (
        <div className="team-column-head">
          <div className="row">
            <span className="lamp" style={{ background: TEAM_LAMP[team.status].color }} />
            <strong>{team.name}</strong>
            <span className="spacer" />
            <button className="ghost small" onClick={() => setEditing(true)}>Edit</button>
          </div>
          <span className={team.status === "blocked" ? "team-blocked" : "muted"}>{line.text}</span>
          <span className="muted small-note">{team.structure === "dispatch" ? "Lead + crew" : "Peers"}{team.projects.length ? ` · ${team.projects.join(", ")}` : ""}</span>
          {team.purpose ? <p className="team-purpose">{team.purpose}</p> : null}
          {handsTo || toReview ? (
            <div className="team-flow">
              {toReview ? <span className="work-state in_review">{toReview} to review</span> : null}
              {handsTo ? <span className="muted">hands its work to {handsTo} →</span> : null}
            </div>
          ) : null}
        </div>
      )}
      <ul className="member-list">
        {members.map((a) => <MemberCard key={a.id} agent={a} team={team} state={state} run={run} />)}
        {!members.length ? <li className="muted small-note drop-hint">Drag someone here.</li> : null}
      </ul>
      <TellTeam team={team} members={members} />
    </section>
  );
}

function MemberCard({ agent, team, state, run }: { agent: WorldAgent; team: WorldTeam | null; state: InboxState; run: (p: Promise<unknown>) => void }) {
  const doing = agent.doing ?? state.tasks.find((t) => agent.taskIds.includes(t.id) && t.activity)?.activity ?? agent.title ?? LAMP[agent.status].label;
  return (
    <li className="member card-member" draggable onDragStart={(e) => e.dataTransfer.setData("text/agent", agent.id)} title="Drag to another team">
      <span className="lamp" style={{ background: LAMP[agent.status].color }} title={LAMP[agent.status].label} />
      <span className="member-name">
        {agent.name}
        {agent.waitingOnYou ? <span className="type decide"> waits for you</span> : null}
      </span>
      {team?.structure === "dispatch" ? (
        <button
          className={`ghost small lead-toggle ${agent.role === "lead" ? "on" : ""}`}
          title={agent.role === "lead" ? "Leads the team: hears your instructions" : "Make this agent the lead"}
          onClick={() => run(api.updateAgent(agent.id, { role: agent.role === "lead" ? "member" : "lead" }))}
        >
          {agent.role === "lead" ? "Lead" : "Make lead"}
        </button>
      ) : <span />}
      <span className="muted member-doing">
        {doing}
        {agent.helpers.length ? ` · ${agent.helpers.length} ${agent.helpers.length === 1 ? "helper" : "helpers"}` : ""}
        {agent.project ? ` · ${agent.project}` : ""}
      </span>
    </li>
  );
}
