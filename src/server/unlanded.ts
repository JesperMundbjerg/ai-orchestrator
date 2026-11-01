// Unlanded work: an agent that goes idle with changes in its worktree that are not committed, or
// commits the team's landing branch does not have, is told once to land them; if nothing changes it
// is the lead's problem, and later the founder's. Deterministic like unpresented.ts: git and office
// presence only, no model; polled, sampled at most every few seconds, rechecked before anything is
// sent, and the history of what was said survives a service restart, so nothing is said twice.
//
//   idle N1 (5 min), state unlanded      -> the agent(s) idle there, once
//   same state, N2 (15 min) after that  -> the team's lead, once
//   same state, N3 (60 min) after that  -> the founder, once, in one line
//
// A state is the checkout's head plus a fingerprint of what is uncommitted. Any change to it, landing
// it or cleaning it, starts over. An agent seen working (or waiting on the founder, or being switched
// to another harness) restarts the idle clocks, but never repeats what was already said about the same
// state. The main checkout is not watched: only worktrees made beside it, which is where agents work.
//
// The setting that says how to land is the team's merge instruction (unlanded-merge.ts).

import type { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import type { UnlandedStage, UnlandedWork, WorldAgent, WorldState, WorldTeam } from "../shared/types.ts";
import { withInboxPath } from "./inboxtext.ts";
import { currentBranch, dirtyState, git, notLanded, type Checkout } from "./worktrees.ts";

const MINUTE = 60_000;

export interface UnlandedTiming {
  /** An agent idle this long with unlanded work is told to land it. */
  agentAfterMs: number;
  /** The same state this long after that, and the agent still idle: its lead is told. */
  leadAfterMs: number;
  /** The same state this long after the agent was told, still idle: the founder is told. */
  founderAfterMs: number;
  /** A checkout is read from git at most this often, except right before something is said. */
  sampleMs: number;
}

export const DEFAULT_TIMING: UnlandedTiming = { agentAfterMs: 5 * MINUTE, leadAfterMs: 15 * MINUTE, founderAfterMs: 60 * MINUTE, sampleMs: 20_000 };

/** An open pipeline run whose candidate is in the checkout, for the nudge to name. */
export interface OpenRun {
  id: string;
  head: string;
  /** Its next step that is not done, such as "verify (ready)"; null when none is left. */
  next: string | null;
}

export interface UnlandedDeps {
  /** The office state now, read again before anything is sent. */
  state(): WorldState;
  checkout(cwd: string): Checkout | null;
  landing(checkout: Checkout): { ref: string; name: string };
  /** The team's merge instruction as an agent is given it (unlanded-merge.ts); null when it has none. */
  merge(team: WorldTeam | null, top: string): string | null;
  runs(teamId: string, top: string): OpenRun[];
  /** Agents being switched to another harness; the office does not touch their checkouts meanwhile. */
  switching(state: WorldState): ReadonlySet<string>;
  tell(agentId: string, text: string): void;
  tellFounder(text: string, agentIds: string[], at: number): void;
}

interface Sample { key: string; head: string; branch: string | null; uncommitted: number; ahead: number; landing: string }
interface Row { checkout: string; state_key: string; first_seen: number; agent_at: number | null; lead_at: number | null; founder_at: number | null }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (agents: Pick<WorldAgent, "name">[]) => agents.map((a) => a.name).join(" and ");
const IDLE = new Set(["idle", "done"]);

/** What is unlanded, in words: "2 uncommitted files and 1 commit not on dev". */
function what(s: Pick<Sample, "uncommitted" | "ahead" | "landing">): string {
  const parts = [s.uncommitted ? plural(s.uncommitted, "uncommitted file") : "", s.ahead ? `${plural(s.ahead, "commit")} not on ${s.landing}` : ""].filter(Boolean);
  return s.ahead ? parts.join(" and ") : `${parts.join("")}, not on ${s.landing}`;
}

export class Unlanded {
  private db: DatabaseSync;
  private deps: UnlandedDeps;
  private timing: UnlandedTiming;
  private samples = new Map<string, { at: number; value: Sample | null }>();
  /** When every agent in a checkout was first seen idle, this stretch. */
  private idle = new Map<string, number>();
  private current: UnlandedWork[] = [];

  constructor(db: DatabaseSync, deps: UnlandedDeps, timing: Partial<UnlandedTiming> = {}) {
    this.db = db;
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    db.exec(`CREATE TABLE IF NOT EXISTS unlanded_watch (
      checkout TEXT PRIMARY KEY,
      state_key TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      agent_at INTEGER,
      lead_at INTEGER,
      founder_at INTEGER
    )`);
  }

  /** The idle agents' checkouts that hold unlanded work now, for the team panel. */
  list(): UnlandedWork[] {
    return this.current;
  }

  private row(top: string): Row | undefined {
    return this.db.prepare("SELECT * FROM unlanded_watch WHERE checkout = ?").get(top) as Row | undefined;
  }

  private begin(top: string, key: string, now: number): Row {
    this.db.prepare(`INSERT INTO unlanded_watch (checkout, state_key, first_seen) VALUES (?, ?, ?)
      ON CONFLICT(checkout) DO UPDATE SET state_key = excluded.state_key, first_seen = excluded.first_seen, agent_at = NULL, lead_at = NULL, founder_at = NULL`).run(top, key, now);
    return this.row(top)!;
  }

  private clear(top: string): void {
    this.db.prepare("DELETE FROM unlanded_watch WHERE checkout = ?").run(top);
  }

  private latch(top: string, column: "agent_at" | "lead_at" | "founder_at", at: number): void {
    this.db.prepare(`UPDATE unlanded_watch SET ${column} = ? WHERE checkout = ?`).run(at, top);
  }

  /** The checkout as git says it now; at most every few seconds unless `force`. Null when git cannot say. */
  private sample(checkout: Checkout, now: number, force = false): Sample | null {
    const cached = this.samples.get(checkout.top);
    if (!force && cached && now - cached.at < this.timing.sampleMs) return cached.value;
    let value: Sample | null = null;
    try {
      const head = git(checkout.top, ["rev-parse", "HEAD"]);
      const dirty = dirtyState(checkout.top);
      const landing = this.deps.landing(checkout);
      const ahead = notLanded(checkout.repoRoot, checkout.top, landing.ref);
      value = { key: `${head}:${dirty.fingerprint}`, head, branch: currentBranch(checkout), uncommitted: dirty.count, ahead, landing: landing.name };
    } catch { /* A checkout git cannot read has nothing to say about. */ }
    this.samples.set(checkout.top, { at: now, value });
    return value;
  }

  /** The agents in a checkout when all of them are idle (and not being switched), else null. */
  private idleIn(state: WorldState, top: string, switching: ReadonlySet<string>): WorldAgent[] | null {
    const here = state.agents.filter((a) => a.paneId && a.cwd && this.deps.checkout(a.cwd)?.top === top);
    if (!here.length || here.some((a) => !IDLE.has(a.status) || a.waitingOnYou || switching.has(a.id))) return null;
    return here;
  }

  /**
   * Called by office reactions and the regular poll. Returns whether the list shown in the office
   * changed. `notice` calls are made only after the stage is latched, so a failure cannot repeat one.
   */
  tick(state: WorldState, now: number): boolean {
    const switching = this.deps.switching(state);
    const checkouts = new Map<string, Checkout>();
    for (const a of state.agents) {
      if (!a.paneId || !a.cwd) continue;
      const checkout = this.deps.checkout(a.cwd);
      // The main checkout is where work lands, not where it is made.
      if (checkout?.linked) checkouts.set(checkout.top, checkout);
    }
    const next: UnlandedWork[] = [];
    for (const [top, checkout] of checkouts) {
      const here = this.idleIn(state, top, switching);
      if (!here) {
        this.idle.delete(top);
        continue;
      }
      if (!this.idle.has(top)) this.idle.set(top, now);
      const sample = this.sample(checkout, now);
      if (!sample) continue;
      if (!sample.uncommitted && !sample.ahead) {
        if (this.row(top)) this.clear(top);
        continue;
      }
      let row = this.row(top);
      if (!row || row.state_key !== sample.key) row = this.begin(top, sample.key, now);
      const team = state.teams.find((t) => here.some((a) => a.teamId === t.id)) ?? null;
      const lead = team ? state.agents.find((a) => a.teamId === team.id && a.role === "lead") ?? null : null;
      row = this.escalate({ top, checkout, here, team, lead, sample, row, since: this.idle.get(top)! }, now) ?? row;
      next.push(...here.map((a): UnlandedWork => ({
        agentId: a.id, agentName: a.name, teamId: a.teamId, checkout: top, branch: sample.branch, landing: sample.landing,
        uncommitted: sample.uncommitted, ahead: sample.ahead, since: new Date(row.first_seen).toISOString(), stage: stageOf(row),
      })));
    }
    // A checkout that is gone leaves nothing to say.
    for (const r of this.db.prepare("SELECT checkout FROM unlanded_watch").all() as Array<{ checkout: string }>) {
      if (!existsSync(r.checkout)) this.clear(r.checkout);
    }
    for (const top of this.idle.keys()) if (!checkouts.has(top)) this.idle.delete(top);
    for (const top of this.samples.keys()) if (!checkouts.has(top)) this.samples.delete(top);
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    return changed;
  }

  /** Says what is due for this state, one stage at a time and each once. Returns the row as it is after. */
  private escalate(c: { top: string; checkout: Checkout; here: WorldAgent[]; team: WorldTeam | null; lead: WorldAgent | null; sample: Sample; row: Row; since: number }, now: number): Row | null {
    const { top, row } = c;
    const dueAgent = row.agent_at == null && now - c.since >= this.timing.agentAfterMs;
    // The clocks of the later stages run from the agent being told, or from the latest idle stretch.
    const waited = row.agent_at == null ? 0 : now - Math.max(row.agent_at, c.since);
    const dueLead = row.agent_at != null && row.lead_at == null && waited >= this.timing.leadAfterMs;
    const dueFounder = row.agent_at != null && row.founder_at == null && waited >= this.timing.founderAfterMs;
    if (!dueAgent && !dueLead && !dueFounder) return null;
    // The state may have changed, or someone started working, inside the polling window.
    const fresh = this.sample(c.checkout, now, true);
    const latest = this.deps.state();
    const here = this.idleIn(latest, top, this.deps.switching(latest));
    if (!fresh || fresh.key !== c.sample.key || !here) return null;
    const runs = c.team ? this.deps.runs(c.team.id, top) : [];
    const run = runs.length ? ` Pipeline run ${runs.map((r) => `${r.id} (candidate ${r.head.slice(0, 7)}${r.next ? `; next step: ${r.next}` : ""})`).join(", ")} ${runs.length === 1 ? "is" : "are"} open with the candidate not delivered.` : "";
    const where = `${top} (branch ${fresh.branch ?? "detached"})`;
    const minutes = (ms: number) => Math.max(1, Math.floor(ms / MINUTE));
    if (dueAgent) {
      this.latch(top, "agent_at", now);
      const merge = this.deps.merge(c.team, top);
      const who = c.lead && !here.some((a) => a.id === c.lead!.id) ? c.lead.name : "founder";
      const how = merge ? `Commit it and land it now with ${c.team?.name ?? "your team"}'s merge instruction:\n${merge}\n` : `Commit it and land it on ${fresh.landing} the way your team lands work. `;
      const text = `Unlanded work: you have been idle for ${minutes(now - c.since)} minutes and ${where} holds ${what(fresh)}.${run} ${how}If it must not land yet, say why in one line: inbox say ${who} "…".`;
      for (const a of here) this.deps.tell(a.id, withInboxPath(text));
    }
    if (dueLead) {
      const lead = c.lead && !here.some((a) => a.id === c.lead!.id) ? c.lead : null;
      this.latch(top, "lead_at", lead ? now : 0);
      if (lead) this.deps.tell(lead.id, withInboxPath(`Unlanded work on your team: ${names(here)} ${here.length === 1 ? "has" : "have"} been idle for ${minutes(waited)} minutes since being told to land it, and nothing has changed. ${where} holds ${what(fresh)}.${run} Get it landed, or find out why not: inbox say ${here[0]!.name} "…".`));
    }
    if (dueFounder) {
      const told = this.row(top)?.lead_at;
      this.atomic(() => {
        this.latch(top, "founder_at", now);
        const lead = c.lead && !here.some((a) => a.id === c.lead!.id) ? c.lead : null;
        this.deps.tellFounder(`${names(here)}${c.team ? ` (${c.team.name})` : ""} left unlanded work for ${minutes(waited)} minutes: ${what(fresh)} in ${basename(top)}${lead && told ? `; ${lead.name} was told` : ""}.`, here.map((a) => a.id), now);
      });
    }
    return this.row(top) ?? null;
  }

  private atomic(fn: () => void): void {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try { fn(); this.db.exec("COMMIT"); } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }
}

function stageOf(row: Row): UnlandedStage {
  return row.founder_at != null ? "founder" : row.lead_at ? "lead" : row.agent_at != null ? "agent" : "watching";
}
