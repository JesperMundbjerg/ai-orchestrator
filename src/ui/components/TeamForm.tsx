import { useEffect, useState, type ReactNode } from "react";
import type { Repository, Team } from "../../shared/types.ts";
import { projectSlug } from "../../shared/slug.ts";
import { api } from "../api.ts";
import { SEND_HINT, sendOnEnter } from "../sendKey.ts";

export interface TeamFields {
  name: string;
  purpose: string;
  handsTo: string | null;
  repository?: string;
  standing?: boolean;
  /** Editing only: what the team's lead is for, and a role file in its repository; empty clears. */
  leadRole?: string;
  leadRolePath?: string;
  /** Editing only: how the team lands work, as text and/or a command file in its repository; empty clears. */
  mergeInstruction?: string;
  mergeInstructionPath?: string;
}

/** The warning a team shows when its lead role file cannot be given to the lead. */
export const leadRoleWarning = (team: Pick<Team, "leadRolePath" | "leadRoleProblem">) =>
  team.leadRolePath && team.leadRoleProblem ? `Lead role file: ${team.leadRoleProblem}` : null;

/** The warning a team shows when its merge instruction file cannot be given to its agents. */
export const mergeInstructionWarning = (team: Pick<Team, "mergeInstructionPath" | "mergeInstructionProblem">) =>
  team.mergeInstructionPath && team.mergeInstructionProblem ? `Merge instruction file: ${team.mergeInstructionProblem}` : null;

/** What a team's leader is called: a project's first mate runs a crew, a standing team's lead dispatches to it. */
export const leadTitle = (team: Team) => (team.standing ? "Lead" : "First mate");

/**
 * Start a project or change one: its name, what it is for and who reviews its work. A new
 * project gets its own worktree in the repository you pick, with a first mate started there;
 * an always-on team (like Mission Control) is only named.
 */
export function TeamForm({ initial, teams, repositories, submit, onSubmit, extra, manage }: {
  initial?: Team;
  /** Editing: the team's worktrees and Merge into…, run through the caller's error line; `onMerged` gets what happened. */
  manage?: { run: (p: Promise<unknown>) => unknown; onMerged: (note: string) => void };
  /** Every team, for where this one hands its finished work. */
  teams: Team[];
  repositories: Repository[];
  submit: string;
  onSubmit: (fields: TeamFields) => void;
  extra?: ReactNode;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [purpose, setPurpose] = useState(initial?.purpose ?? "");
  const [handsTo, setHandsTo] = useState(initial?.handsTo ?? "");
  const [standing, setStanding] = useState(false);
  const [leadRole, setLeadRole] = useState(initial?.leadRole ?? "");
  const [leadRolePath, setLeadRolePath] = useState(initial?.leadRolePath ?? "");
  const [mergeInstruction, setMergeInstruction] = useState(initial?.mergeInstruction ?? "");
  const [mergeInstructionPath, setMergeInstructionPath] = useState(initial?.mergeInstructionPath ?? "");
  const [repository, setRepository] = useState(repositories[0]?.root ?? "");
  const others = teams.filter((t) => t.id !== initial?.id);
  const repo = repositories.find((r) => r.root === repository);
  const slug = projectSlug(name);
  const canSubmit = Boolean(name.trim()) && (Boolean(initial) || standing || Boolean(repo));
  const save = () => {
    if (!canSubmit) return;
    const fields = { name: name.trim(), purpose: purpose.trim(), handsTo: handsTo || null };
    onSubmit(initial ? { ...fields, leadRole: leadRole.trim(), leadRolePath: leadRolePath.trim(), mergeInstruction: mergeInstruction.trim(), mergeInstructionPath: mergeInstructionPath.trim() } : { ...fields, standing, repository: standing ? undefined : repository });
  };
  return (
    <form
      className="team-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input autoFocus placeholder={initial?.standing || standing ? "Team name, e.g. Mission Control" : "Project name, e.g. Atoms light"} value={name} onChange={(e) => setName(e.target.value)} />
      {initial ? null : (
        <>
          <label className="radio">
            <input type="radio" name="kind" checked={!standing} onChange={() => setStanding(false)} />
            A project: its own worktree, with a first mate who runs the crew
          </label>
          <label className="radio">
            <input type="radio" name="kind" checked={standing} onChange={() => setStanding(true)} />
            Always on, like Mission Control: its agents keep their own checkouts
          </label>
          {!standing ? (
            repositories.length ? (
              <label className="field">
                <span>Repository</span>
                <select value={repository} onChange={(e) => setRepository(e.target.value)}>
                  {repositories.map((r) => <option key={r.root} value={r.root}>{r.name}</option>)}
                </select>
                {repo && slug ? <span className="muted small-note">Worktree {repo.name}-{slug} on branch worktree-{slug}, from {repo.base ?? "the main checkout"}.</span> : null}
              </label>
            ) : (
              <p className="warn small-note">No repository yet: a project's worktree is made in a repository an agent works in, or one beside it.</p>
            )
          ) : null}
        </>
      )}
      <textarea rows={2} placeholder={standing || initial?.standing ? "What the team is for; every member is told" : "What the project is for; the first mate starts on it right away"} value={purpose} onChange={(e) => setPurpose(e.target.value)} onKeyDown={sendOnEnter(save)} />
      <span className="muted small-note">{SEND_HINT}</span>
      <label className="field">
        <span>Hands finished work to</span>
        <select value={handsTo} onChange={(e) => setHandsTo(e.target.value)}>
          <option value="">Nobody: it finishes its own work</option>
          {others.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </label>
      {initial ? (
        <div className="field lead-role">
          <span>Lead role</span>
          <textarea rows={3} aria-label="Lead role" placeholder="What this team's lead is for. The office gives it to the lead on every start, with the rule that a lead only delegates." value={leadRole} onChange={(e) => setLeadRole(e.target.value)} />
          <input aria-label="Lead role file" placeholder="…or a file in the team's repository, e.g. .claude/commands/mission-control.md" value={leadRolePath} onChange={(e) => setLeadRolePath(e.target.value)} />
          {leadRoleWarning({ leadRolePath, leadRoleProblem: leadRolePath === initial.leadRolePath ? initial.leadRoleProblem : null }) ? (
            <span className="warn small-note" role="alert" style={{ overflowWrap: "anywhere" }}>{leadRoleWarning(initial)}</span>
          ) : null}
          <span className="muted small-note">The file is read when the lead starts, so an edit to it reaches the next start. Every lead is also told: plan, split and hand every change to the crew; never edit, fix or build itself.</span>
        </div>
      ) : null}
      {initial ? (
        <div className="field merge-instruction">
          <span>Merge instruction</span>
          <textarea rows={2} aria-label="Merge instruction" placeholder='How this team lands work, e.g. "land <checkout> <sha>". Given to every lead and crew brief, and to an agent that idles with work that never landed.' value={mergeInstruction} onChange={(e) => setMergeInstruction(e.target.value)} />
          <input aria-label="Merge instruction file" placeholder="…or a command file in the team's repository, e.g. .claude/commands/worktree-sync.md" value={mergeInstructionPath} onChange={(e) => setMergeInstructionPath(e.target.value)} />
          {mergeInstructionWarning({ mergeInstructionPath, mergeInstructionProblem: mergeInstructionPath === initial.mergeInstructionPath ? initial.mergeInstructionProblem : null }) ? (
            <span className="warn small-note" role="alert" style={{ overflowWrap: "anywhere" }}>{mergeInstructionWarning(initial)}</span>
          ) : null}
          <span className="muted small-note">Without one, an agent that idles with unlanded work is told to land it on the team's landing branch the way its team lands work.</span>
        </div>
      ) : null}
      {initial && manage ? <TeamWorktrees team={initial} teams={teams} {...manage} /> : null}
      <div className="row">
        <button className="primary small" type="submit" disabled={!canSubmit}>{submit}</button>
        {extra}
      </div>
    </form>
  );
}

/**
 * Finishes a project (its agents closed, its worktree removed) or disbands a standing team,
 * after you confirm. Resolves with what happened, or null when you cancelled. A project whose work
 * has not landed is refused, and its lead told: that refusal rejects as a `FinishRefused`.
 */
export async function finishTeam(team: Team): Promise<string | null> {
  const ask = team.standing
    ? `Disband ${team.name}? Its members go back to the lounge.`
    : `Finish ${team.name}?\n\nIts agents are closed and the worktree ${team.path} is removed. The branch ${team.branch ?? ""} is deleted if it is merged, otherwise kept. It refuses while anything is uncommitted or not yet landed, and tells the project's lead to land it.`;
  if (!confirm(ask)) return null;
  return deleteTeam(team, false);
}

/** Finishes past commits that have not landed: the branch is kept with them. Uncommitted changes still refuse. */
export function finishAnyway(team: Team): Promise<string> {
  return deleteTeam(team, true);
}

/** Finishing refused because work has not landed; `canForce` when only commits (not uncommitted changes) are missing. */
export class FinishRefused extends Error {
  teamId: string;
  canForce: boolean;
  constructor(teamId: string, message: string, canForce: boolean) {
    super(message);
    this.teamId = teamId;
    this.canForce = canForce;
  }
}

async function deleteTeam(team: Team, force: boolean): Promise<string> {
  try {
    return (await api.deleteTeam(team.id, force)).note;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "finish_unlanded" || code === "finish_uncommitted") throw new FinishRefused(team.id, (err as Error).message, code === "finish_unlanded");
    throw err;
  }
}

/** A worktree by its folder's name; its full path is in the title. */
const folder = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/**
 * The worktrees a team works in: its own, and others of its repository it owns (lanes), whose
 * agents are on it as members. Adding or removing one never touches the folder. Merge into… folds
 * a project made for a worktree into another team, keeping everything on disk.
 */
function TeamWorktrees({ team, teams, run, onMerged }: { team: Team; teams: Team[]; run: (p: Promise<unknown>) => unknown; onMerged: (note: string) => void }) {
  const [available, setAvailable] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [into, setInto] = useState("");
  const lanes = team.worktrees.join("\n");
  useEffect(() => {
    let live = true;
    api.teamWorktrees(team.id).then((w) => live && setAvailable(w.available), () => live && setAvailable([]));
    return () => void (live = false);
  }, [team.id, lanes]);
  const others = teams.filter((t) => t.id !== team.id);
  const target = others.find((t) => t.id === into);
  const add = () => {
    const path = adding.trim();
    if (path) run(api.addWorktree(team.id, path).then(() => setAdding("")));
  };
  const merge = () => {
    if (!target) return;
    const where = team.path ? `Its worktree ${team.path} becomes one of ${target.name}'s` : `It has no worktree of its own`;
    if (!confirm(`Merge ${team.name} into ${target.name}?\n\n${where}, and its agents join ${target.name} as members. ${team.name} is then forgotten. Nothing on disk is touched: no worktree, branch, pane or process is removed.`)) return;
    run(api.mergeTeam(team.id, target.id).then((r) => onMerged(r.note)));
  };
  return (
    <div className="team-worktrees">
      <span>Worktrees</span>
      <ul>
        {team.path ? <li><code title={team.path}>{folder(team.path)}</code> <span className="muted small-note">its own</span></li> : null}
        {team.worktrees.map((w) => (
          <li key={w}>
            <code title={w}>{folder(w)}</code>
            <button type="button" className="ghost small" onClick={() => run(api.removeWorktree(team.id, w))} title="The folder stays; agents working there are no longer placed on this team by it">Remove</button>
          </li>
        ))}
        {!team.path && !team.worktrees.length ? <li className="muted small-note">None: its agents work wherever they are.</li> : null}
      </ul>
      <div className="row">
        <input
          list={`worktrees-${team.id}`}
          placeholder="Add a worktree of the same repository"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <datalist id={`worktrees-${team.id}`}>{available.map((p) => <option key={p} value={p}>{folder(p)}</option>)}</datalist>
        <button type="button" className="ghost small" disabled={!adding.trim()} onClick={add}>Add</button>
      </div>
      <span className="muted small-note">Agents working in one of these are on {team.name}. Removing one, or finishing, never deletes an added worktree.</span>
      {others.length ? (
        <div className="row">
          <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into">
            <option value="">Merge into…</option>
            {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button type="button" className="ghost small" disabled={!target} onClick={merge}>Merge</button>
        </div>
      ) : null}
    </div>
  );
}
