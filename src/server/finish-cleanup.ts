// What finishing a project closes in herdr, and what it leaves. The office closes only what its
// records say is the project's: the lead's pane, the crew it knows (`inbox pane` panes, agents
// placed on the team), every pane whose folder is the project's own worktree (about to be removed,
// so nothing can stay there), and the workspaces that go with them: one left empty, or the one
// herdr opened for the repository's main checkout when the office made the worktree. Anything
// else is left and said so. It never guesses: a plain shell in a shared main checkout that no
// record gives the team is the founder's. Never `herdr server stop`, never `workspace close --group`.

import type { DatabaseSync } from "node:sqlite";
import type { AgentSource } from "./world.ts";

/** A pane herdr has, an agent's or a plain shell's. */
export interface PaneInfo {
  paneId: string;
  workspaceId: string;
  tabId: string | null;
  cwd: string | null;
  /** Where the process in front runs, which can differ from where the shell started. */
  foregroundCwd: string | null;
}

export interface WorkspaceInfo {
  workspaceId: string;
  label: string;
  paneCount: number;
  /** The checkout the workspace is open on, when it is a repository's. */
  checkoutPath: string | null;
  repoRoot: string | null;
  linked: boolean;
}

/** What the office knows of a team and its surroundings when it is finished. */
export interface FinishScope {
  team: { id: string; name: string };
  /** The project's own worktree, which is about to go; null when it is the shared main checkout (nothing in it is the team's by place alone). */
  top: string | null;
  /** The repository's main checkout. */
  repoRoot: string | null;
  /** The team's other worktrees (its lanes), which finishing never removes: whoever works there stays. */
  lanes: string[];
  agents: Array<{ name: string; teamId: string | null; role: string; paneId: string | null; cwd: string | null }>;
  teamNames: ReadonlyMap<string, string>;
  /** The pane the project's first mate was started in. */
  leadPane: string | null;
  /** Panes opened with `inbox pane`, by the team they were opened for. */
  openedPanes: ReadonlyArray<{ paneId: string; teamId: string }>;
  /** Workspaces herdr opened beside the project's worktree when the office made it, by team. */
  openedWorkspaces: ReadonlyArray<{ workspaceId: string; teamId: string; repoRoot: string }>;
  /** The pane the office itself runs in, when it runs in one. */
  ownPane: string | null;
}

/** Workspaces herdr opened beside a project's worktree when the office made it, by team: finishing the project closes them. */
export function ensureWorkspaceRecords(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS office_workspaces (
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    repo_root TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, team_id)
  )`);
}

interface Candidate { why: string; inside: boolean }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class FinishCleanup {
  /** Set when something that is not the team's works in the folder being removed: nothing is closed then. */
  refusal: string | null = null;
  readonly closed: string[] = [];
  readonly left: string[] = [];
  /** How many of the closed panes worked in the worktree being removed. */
  private closedInWorktree = 0;
  private source: AgentSource;
  private scope: FinishScope;
  private candidates = new Map<string, Candidate>();
  private panes: PaneInfo[] | null = null;
  private touched = new Set<string>();

  private constructor(source: AgentSource, scope: FinishScope) {
    this.source = source;
    this.scope = scope;
  }

  private inside(cwd: string | null | undefined, top = this.scope.top): boolean {
    return !!top && !!cwd && (cwd === top || cwd.startsWith(`${top}/`));
  }

  /** Works out, before anything is closed, which panes go and which are left. */
  static async plan(source: AgentSource, scope: FinishScope): Promise<FinishCleanup> {
    const c = new FinishCleanup(source, scope);
    await c.work();
    return c;
  }

  private async work(): Promise<void> {
    const { scope } = this;
    if (this.source.panes) {
      try { this.panes = await this.source.panes(); } catch (err) { this.left.push(`herdr's pane list could not be read (${message(err)}), so plain shells were not looked for`); }
    } else this.left.push("herdr's pane list is not available here, so plain shells were not looked for");
    const live = this.source.live();
    const liveBy = new Map(live.map((l) => [l.paneId, l]));
    /** The team each pane is known to belong to, by the office's records. */
    const owner = new Map<string, string>();
    for (const a of scope.agents) if (a.paneId && a.teamId) owner.set(a.paneId, a.teamId);
    for (const o of scope.openedPanes) if (!owner.has(o.paneId)) owner.set(o.paneId, o.teamId);
    const exists = (paneId: string) => !this.panes || this.panes.some((p) => p.paneId === paneId) || liveBy.has(paneId);
    const strangers: string[] = [];
    const consider = (paneId: string, why: string, inside: boolean, who: string) => {
      if (this.candidates.has(paneId) || !exists(paneId)) return;
      const belongs = owner.get(paneId);
      if (paneId === scope.ownPane) {
        if (inside) strangers.push(`${who} is the office's own pane`);
        else this.left.push(`${who} (${paneId}) is the office's own pane`);
      } else if (belongs && belongs !== scope.team.id) {
        const team = scope.teamNames.get(belongs) ?? "another team";
        if (inside) strangers.push(`${who} belongs to ${team}`);
        else this.left.push(`${who} (${paneId}) belongs to ${team}`);
      } else this.candidates.set(paneId, { why, inside });
    };
    const agentName = (paneId: string) => scope.agents.find((a) => a.paneId === paneId)?.name ?? liveBy.get(paneId)?.name ?? "an agent";
    // What runs in the folder going away.
    for (const l of live) if (this.inside(l.cwd)) consider(l.paneId, `${agentName(l.paneId)} working in the worktree`, true, agentName(l.paneId));
    for (const p of this.panes ?? []) if (this.inside(p.cwd) || this.inside(p.foregroundCwd)) consider(p.paneId, `a shell in the worktree`, true, `a shell`);
    // What the office knows is the team's, wherever it is.
    for (const a of scope.agents) {
      if (!a.paneId || a.teamId !== scope.team.id) continue;
      const lane = scope.lanes.find((l) => this.inside(a.cwd, l));
      if (lane && exists(a.paneId) && !this.inside(a.cwd)) this.left.push(`${a.name} (${a.paneId}) works in the lane ${lane}, which stays`);
      else consider(a.paneId, `${a.name}, ${a.role === "lead" ? "the lead" : "crew"}`, this.inside(a.cwd), a.name);
    }
    if (scope.leadPane) consider(scope.leadPane, "the lead's pane", false, "the lead's pane");
    for (const o of scope.openedPanes) if (o.teamId === scope.team.id) consider(o.paneId, "a pane opened for the crew", false, "a pane opened for the crew");
    if (strangers.length) this.refusal = `${strangers.join(" and ")} and works in ${scope.top}, which is being removed`;
    else for (const paneId of this.candidates.keys()) this.touched.add(this.workspaceOf(paneId) ?? "");
    this.touched.delete("");
  }

  private workspaceOf(paneId: string): string | null {
    return this.panes?.find((p) => p.paneId === paneId)?.workspaceId ?? paneId.split(":")[0] ?? null;
  }

  /** Closes the panes. One in the folder being removed must close (throws); another that cannot is left, said so. */
  async closePanes(): Promise<void> {
    for (const [paneId, c] of this.candidates) {
      try {
        await this.source.closePane(paneId);
        this.closed.push(`${c.why} (${paneId})`);
        if (c.inside) this.closedInWorktree++;
      } catch (err) {
        if (c.inside) throw err;
        this.left.push(`${c.why} (${paneId}) could not be closed: ${message(err)}`);
      }
    }
  }

  /**
   * After the worktree is gone: the workspaces left empty by the closed panes, and the one herdr opened for the
   * main checkout when the office made this project (herdr refuses to close it while a sibling worktree workspace is open,
   * so it waits for the last project of the repository). Returns the workspaces handed on to the repository's other
   * projects. Nothing here throws: a workspace that stays is said in `left`.
   */
  async closeWorkspaces(): Promise<{ handOn: Array<{ workspaceId: string; repoRoot: string }> }> {
    const handOn: Array<{ workspaceId: string; repoRoot: string }> = [];
    const { scope } = this;
    const record = new Map(scope.openedWorkspaces.filter((w) => w.teamId === scope.team.id).map((w) => [w.workspaceId, w.repoRoot]));
    const recorded = new Set(record.keys());
    if (!this.source.workspaces || !this.source.closeWorkspace) {
      if (recorded.size) this.left.push(`workspace ${[...recorded].join(", ")} opened by the office: this herdr cannot list or close workspaces`);
      return { handOn };
    }
    let workspaces: WorkspaceInfo[];
    let panes: PaneInfo[];
    try {
      workspaces = await this.source.workspaces();
      panes = this.source.panes ? await this.source.panes() : [];
    } catch (err) {
      this.left.push(`workspaces could not be read (${message(err)}), so none was closed`);
      return { handOn };
    }
    const live = new Map(this.source.live().map((l) => [l.paneId, l]));
    const ownWorkspace = panes.find((p) => p.paneId === scope.ownPane)?.workspaceId ?? null;
    const label = (w: WorkspaceInfo) => `${w.label ? `"${w.label}" ` : ""}(${w.workspaceId})`;
    const siblingsOf = (repo: string) => workspaces.filter((w) => w.linked && w.repoRoot === repo && w.checkoutPath !== scope.top);
    for (const w of workspaces) {
      // The project's own workspace went with its worktree.
      if (scope.top && w.checkoutPath === scope.top) continue;
      // A record counts only while the workspace is still the main checkout it was opened on: herdr may give an id to something else later.
      const opened = recorded.has(w.workspaceId) && !w.linked && w.checkoutPath === record.get(w.workspaceId);
      const mainOfRepo = !w.linked && !!w.checkoutPath && w.checkoutPath === scope.repoRoot;
      const emptied = this.touched.has(w.workspaceId);
      if (!opened && !emptied) {
        if (mainOfRepo) this.left.push(`workspace ${label(w)} on the main checkout is kept: the office did not open it for ${scope.team.name}, so it is the founder's`);
        continue;
      }
      const inside = panes.filter((p) => p.workspaceId === w.workspaceId);
      if (w.workspaceId === ownWorkspace) { this.left.push(`workspace ${label(w)} is kept: the office itself runs in it`); continue; }
      const others = inside.filter((p) => live.has(p.paneId) || this.ownerElsewhere(p.paneId));
      if (others.length) {
        this.left.push(`workspace ${label(w)} is kept: ${others.length === 1 ? "an agent or pane that is not" : "agents or panes that are not"} ${scope.team.name}'s still run${others.length === 1 ? "s" : ""} in it`);
        continue;
      }
      if (inside.length && !opened) {
        this.left.push(`workspace ${label(w)} is kept: ${inside.length} ${inside.length === 1 ? "pane is" : "panes are"} still open in it that the office did not open for ${scope.team.name}`);
        continue;
      }
      if (opened && siblingsOf(w.checkoutPath!).length) {
        this.left.push(`workspace ${label(w)} is kept: herdr groups it with the repository's other project workspaces, which are still open; it closes with the last one`);
        handOn.push({ workspaceId: w.workspaceId, repoRoot: w.checkoutPath! });
        continue;
      }
      try {
        await this.source.closeWorkspace(w.workspaceId);
        const shells = inside.map((p) => p.paneId);
        this.closed.push(opened
          ? `workspace ${label(w)}, opened by the office for ${scope.team.name}${shells.length ? ` (its ${shells.length === 1 ? "idle shell" : "idle shells"} ${shells.join(", ")} went with it)` : ""}`
          : `workspace ${label(w)}, left empty`);
      } catch (err) {
        this.left.push(`workspace ${label(w)} could not be closed: ${message(err)}`);
      }
    }
    return { handOn };
  }

  /** Whether the office's records give a pane to a team other than the one being finished (or to the office itself). */
  private ownerElsewhere(paneId: string): boolean {
    const { scope } = this;
    return paneId === scope.ownPane
      || scope.agents.some((a) => a.paneId === paneId && a.teamId && a.teamId !== scope.team.id)
      || scope.openedPanes.some((o) => o.paneId === paneId && o.teamId !== scope.team.id);
  }

  /** Whether nothing was done or left in herdr beyond the panes working in the worktree that went with it. */
  onlyWorktree(): boolean {
    return !this.left.length && this.closed.length === this.closedInWorktree;
  }

  /** The sentence for the finish note and the founder's notice: what was closed in herdr and what was left. */
  summary(): string {
    const closed = this.closed.length ? ` Closed in herdr: ${this.closed.join("; ")}.` : "";
    const left = this.left.length ? ` Left in herdr: ${this.left.join("; ")}.` : "";
    return `${closed}${left}`;
  }
}
