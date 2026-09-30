import { useState, type ReactNode } from "react";
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
}

/** What a team's leader is called: a project's first mate runs a crew, a standing team's lead dispatches to it. */
export const leadTitle = (team: Team) => (team.standing ? "Lead" : "First mate");

/**
 * Start a project or change one: its name, what it is for and who reviews its work. A new
 * project gets its own worktree in the repository you pick, with a first mate started there;
 * an always-on team (like Mission Control) is only named.
 */
export function TeamForm({ initial, teams, repositories, submit, onSubmit, extra }: {
  initial?: Team;
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
  const [repository, setRepository] = useState(repositories[0]?.root ?? "");
  const others = teams.filter((t) => t.id !== initial?.id);
  const repo = repositories.find((r) => r.root === repository);
  const slug = projectSlug(name);
  const canSubmit = Boolean(name.trim()) && (Boolean(initial) || standing || Boolean(repo));
  const save = () => {
    if (!canSubmit) return;
    const fields = { name: name.trim(), purpose: purpose.trim(), handsTo: handsTo || null };
    onSubmit(initial ? fields : { ...fields, standing, repository: standing ? undefined : repository });
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
              <p className="warn small-note">No repository yet: a project's worktree is made in a repository an agent already works in.</p>
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
      <div className="row">
        <button className="primary small" type="submit" disabled={!canSubmit}>{submit}</button>
        {extra}
      </div>
    </form>
  );
}

/**
 * Finishes a project (its agents closed, its worktree removed) or disbands a standing team,
 * after you confirm. Resolves with what happened, or null when you cancelled.
 */
export async function finishTeam(team: Team): Promise<string | null> {
  const ask = team.standing
    ? `Disband ${team.name}? Its members go back to the lounge.`
    : `Finish ${team.name}?\n\nIts agents are closed and the worktree ${team.path} is removed. The branch ${team.branch ?? ""} is deleted if it is merged, otherwise kept. Nothing uncommitted is lost: it refuses while there is any.`;
  if (!confirm(ask)) return null;
  return (await api.deleteTeam(team.id)).note;
}
