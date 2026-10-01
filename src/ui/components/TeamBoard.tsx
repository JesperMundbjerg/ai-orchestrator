import { useEffect, useMemo, useState, type DragEvent } from "react";
import { HARNESS_INFO } from "../../shared/harnesses.ts";
import type { InboxState, SwitchesView, WorldAgent, WorldState, WorldTeam } from "../../shared/types.ts";
import { api } from "../api.ts";
import { confirmRemove, LAMP, removable, TEAM_LAMP, teamLine } from "../world/status.ts";
import { HiddenLine, MessageRow, TellTeam, ThreadToggle, useThreadView, withMe, WorkRow } from "../world/Talk.tsx";
import { TellAllLeads } from "./TellAllLeads.tsx";
import { SwitchHarness } from "./SwitchHarness.tsx";
import { MachineWarning } from "./MachineWarning.tsx";
import { finishTeam, leadTitle, TeamForm } from "./TeamForm.tsx";

const LOUNGE = "lounge";

/**
 * Projects at a glance, without walking the office: a column per project (and standing team)
 * with where it stands and who is on it (drag people between columns), the work flowing between
 * them and what was said. Starting a project makes its worktree; finishing one removes it.
 */
export function TeamBoard({ state, tick, onOffice, onCrewGuide }: { state: InboxState; tick: number; onOffice: () => void; onCrewGuide: () => void }) {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** What went wrong with the last thing you did; kept until you dismiss it, cancel or change the form it came from, or do something else, and not cleared by the next refresh. */
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [over, setOver] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let live = true;
    api.world().then((w) => live && (setWorld(w), setLoadError(null)), (e: Error) => live && setLoadError(e.message));
    return () => void (live = false);
  }, [tick]);

  const [view] = useThreadView();
  const agents = useMemo(() => new Map((world?.agents ?? []).map((a) => [a.id, a])), [world]);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), (e: Error) => setError(e.message));
  const finish = (team: WorldTeam) => run(finishTeam(team).then((said) => said && setNote(said)));

  if (!world) return <main className="board">{loadError ? <p className="warn">The office did not answer ({loadError}).</p> : <p className="muted pad">Loading…</p>}</main>;

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
  const shown = view === "me" ? world.messages.filter(withMe) : world.messages;

  return (
    <main className="board team-board">
      <header className="board-head row">
        <div>
          <h1>Projects</h1>
          <p className="muted">A project is a worktree: everyone working in it is on it, and its first mate runs the crew. Your instructions go to the first mate; finished work flows to the team it hands to.</p>
        </div>
        <span className="spacer" />
        <button className="ghost small" onClick={onCrewGuide} title="Which model each crew member runs on">Crew guide</button>
        <button className="ghost small" onClick={onOffice}>Walk into the office →</button>
        <TellAllLeads world={world} />
        <button className="primary small" onClick={() => (setError(null), setAdding(!adding))}>{adding ? "Cancel" : "+ New project"}</button>
      </header>
      <MachineWarning tick={tick} note />
      {error ? <p className="warn warn-dismiss">{error} <button className="ghost small" onClick={() => setError(null)}>OK</button></p> : loadError ? <p className="warn">The office did not answer ({loadError}).</p> : null}
      {note ? <p className="board-note">{note} <button className="ghost small" onClick={() => setNote(null)}>OK</button></p> : null}
      {adding ? (
        <div className="team-column new" onChange={() => setError(null)}>
          <TeamForm
            teams={world.teams}
            repositories={world.repositories}
            submit={starting ? "Starting…" : "Start"}
            onSubmit={(fields) => {
              setStarting(true);
              void run(api.createTeam(fields).then(() => setAdding(false))).finally(() => setStarting(false));
            }}
          />
          {starting ? <p className="muted small-note">Making the worktree and starting its first mate…</p> : null}
        </div>
      ) : null}

      <div className="team-columns">
        {world.teams.map((t) => (
          <TeamColumn key={t.id} team={t} world={world} agents={agents} state={state} over={over === t.id} target={target(t.id)} run={run} clearError={() => setError(null)} onFinish={() => finish(t)} onNote={setNote} />
        ))}
        <section className={`team-column lounge ${over === LOUNGE ? "over" : ""}`} {...target(LOUNGE)}>
          <div className="team-column-head">
            <strong>Lounge</strong>
            <span className="muted small-note">Not on a project · {lounge.length}</span>
          </div>
          <ul className="member-list">
            {lounge.map((a) => <MemberCard key={a.id} agent={a} team={null} state={state} run={run} switches={world.switches} />)}
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
          <div className="thread-head">
            <h2>What was said</h2>
            <ThreadToggle />
          </div>
          <p className="muted small-note said-key"><span className="for-you">answer to you</span> and <span className="for-you mine">you said</span> mark your own thread; the rest was between agents.</p>
          <ul className="order-list">
            {shown.slice(0, 30).map((m) => <MessageRow key={m.id} message={m} agents={agents} />)}
            {!world.messages.length ? <li className="muted small-note">Nobody has said anything yet.</li> : null}
          </ul>
          <HiddenLine count={world.messages.length - shown.length} />
        </section>
      </div>
    </main>
  );
}

function TeamColumn({ team, world, agents, state, over, target, run, clearError, onFinish, onNote }: {
  team: WorldTeam;
  world: WorldState;
  agents: Map<string, WorldAgent>;
  state: InboxState;
  over: boolean;
  target: Record<string, (e: DragEvent) => void>;
  run: (p: Promise<unknown>) => void;
  /** Dismiss the board's error: the form it came from was changed, cancelled or closed. */
  clearError: () => void;
  onFinish: () => void;
  onNote: (note: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const members = world.agents.filter((a) => a.teamId === team.id).sort((a, b) => Number(b.role === "lead") - Number(a.role === "lead"));
  const line = teamLine(team, agents);
  const handsTo = team.handsTo ? world.teams.find((t) => t.id === team.handsTo)?.name : null;
  const toReview = world.work.filter((w) => w.toTeamId === team.id && w.state === "in_review").length;
  return (
    <section className={`team-column ${team.status} ${over ? "over" : ""}`} {...target} onChange={clearError}>
      {editing ? (
        <TeamForm
          initial={team}
          teams={world.teams}
          repositories={world.repositories}
          submit="Save"
          onSubmit={(fields) => run(api.updateTeam(team.id, fields).then(() => setEditing(false)))}
          manage={{ run, onMerged: (said) => (setEditing(false), onNote(said)) }}
          extra={
            <>
              <button type="button" className="ghost small" onClick={() => (clearError(), setEditing(false))}>Cancel</button>
              <button type="button" className="ghost small danger" onClick={onFinish}>{team.standing ? "Disband" : "Finish project"}</button>
            </>
          }
        />
      ) : (
        <div className="team-column-head">
          <div className="row">
            <span className="lamp" style={{ background: TEAM_LAMP[team.status].color }} />
            <strong>{team.name}</strong>
            <span className="spacer" />
            <button className="ghost small" onClick={() => (clearError(), setEditing(true))}>Edit</button>
          </div>
          <span className={team.status === "blocked" ? "team-blocked" : "muted"}>{line.text}</span>
          <span className="muted small-note" title={team.path ?? undefined}>{team.standing ? "Always on" : `Worktree on ${team.branch ?? "an unknown branch"}`}{team.worktrees.length ? ` · ${team.worktrees.length}${team.standing ? "" : " more"} ${team.worktrees.length === 1 ? "worktree" : "worktrees"}` : ""}</span>
          {!!team.unpresentedCommits && <span className="muted small-note">{team.unpresentedCommits} {team.unpresentedCommits === 1 ? "commit" : "commits"} not shown to you yet</span>}
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
        {members.map((a) => <MemberCard key={a.id} agent={a} team={team} state={state} run={run} switches={world.switches} />)}
        {!members.length ? <li className="muted small-note drop-hint">{team.standing ? "Drag someone here." : "Nobody working in it. Drag someone here, or start an agent in its worktree."}</li> : null}
      </ul>
      <TellTeam team={team} members={members} />
    </section>
  );
}

function MemberCard({ agent, team, state, run, switches }: { agent: WorldAgent; team: WorldTeam | null; state: InboxState; run: (p: Promise<unknown>) => void; switches: SwitchesView | undefined }) {
  const doing = agent.doing ?? state.tasks.find((t) => agent.taskIds.includes(t.id) && t.activity)?.activity ?? agent.title ?? LAMP[agent.status].label;
  return (
    <li className="member card-member" draggable onDragStart={(e) => e.dataTransfer.setData("text/agent", agent.id)} title="Drag to another team">
      <span className="lamp" style={{ background: LAMP[agent.status].color }} title={LAMP[agent.status].label} />
      <span className="member-name">
        {agent.name}
        {agent.waitingOnYou ? <span className="type decide"> waits for you</span> : null}
      </span>
      {!team ? <span /> : agent.role === "lead" ? (
        <span className="lead-toggle on" title="Hears your instructions and runs the others">{leadTitle(team)}</span>
      ) : (
        <button className="ghost small lead-toggle" title={`Make ${agent.name} the ${leadTitle(team).toLowerCase()}`} onClick={() => run(api.updateAgent(agent.id, { role: "lead" }))}>
          Make {leadTitle(team).toLowerCase()}
        </button>
      )}
      <span className="muted member-doing">
        {removable(agent) ? <button className="ghost small danger member-remove" title={`Nothing runs behind ${agent.name}`} onClick={() => confirmRemove(agent) && run(api.removeAgent(agent.id))}>Remove</button> : null}
        {doing}
        {agent.helpers.length ? ` · ${agent.helpers.length} ${agent.helpers.length === 1 ? "helper" : "helpers"}` : ""}
        {agent.model ? <span title={agent.model.id}> · {HARNESS_INFO[agent.harness].label} · {agent.model.label}</span> : null}
        {agent.effort?.current ? ` · effort ${agent.effort.current}` : ""}
        {agent.effort?.request?.state === "pending" ? ` (${agent.effort.request.level} pending)` : ""}
        {agent.project ? ` · ${agent.project}` : ""}
      </span>
      <SwitchHarness agent={agent} switches={switches} compact />
    </li>
  );
}
