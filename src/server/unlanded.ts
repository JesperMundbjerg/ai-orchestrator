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
// An agent, or the lead of the team whose worktree it is, may put the watch on hold for the state as it is
// now, with a reason (`inbox unlanded hold "why"`): the founder is told the reason once, and nothing more
// is said to anyone about that state. A hold is only ever on one state: any change to it ends the hold and
// starts over, and so does releasing it (`inbox unlanded release`), which restarts the clocks.
//
// The setting that says how to land is the team's merge instruction (unlanded-merge.ts).

import type { DatabaseSync } from "node:sqlite";
import { basename, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { UnlandedAnswer, UnlandedHold, UnlandedStage, UnlandedWork, WorldAgent, WorldState, WorldTeam } from "../shared/types.ts";
import { inboxCommand } from "../shared/pipeline-cli.ts";
import { InboxError } from "./inbox.ts";
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
interface Row {
  checkout: string; state_key: string; first_seen: number; agent_at: number | null; lead_at: number | null; founder_at: number | null;
  /** Set while the state is on hold: why, who said so (their name) and when. Gone with the state. */
  hold_reason: string | null; hold_by: string | null; held_at: number | null;
  /** When the hold on this state was released; the clocks of the stages run from no earlier than this. */
  resume_at: number | null;
}

/** The longest hold reason; it is one line in the founder's notices and the team panel. */
export const HOLD_REASON_MAX_CHARS = 300;

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
    // The hold on a state: columns of this table, added once, so nothing outside this file migrates.
    const have = new Set((db.prepare("PRAGMA table_info(unlanded_watch)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of [["hold_reason", "TEXT"], ["hold_by", "TEXT"], ["held_at", "INTEGER"], ["resume_at", "INTEGER"]] as const) {
      if (!have.has(name)) db.exec(`ALTER TABLE unlanded_watch ADD COLUMN ${name} ${type}`);
    }
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
      ON CONFLICT(checkout) DO UPDATE SET state_key = excluded.state_key, first_seen = excluded.first_seen, agent_at = NULL, lead_at = NULL, founder_at = NULL,
        hold_reason = NULL, hold_by = NULL, held_at = NULL, resume_at = NULL`).run(top, key, now);
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

  /** The agents with a pane in a checkout. */
  private agentsIn(state: WorldState, top: string): WorldAgent[] {
    return state.agents.filter((a) => a.paneId && a.cwd && this.deps.checkout(a.cwd)?.top === top);
  }

  /**
   * The agents in a checkout when all of them are idle (and not being switched), else null. `held`: one of them
   * waits on the founder's answer, so it is not nagged, but the work is still the lead's to know about.
   */
  private idleIn(state: WorldState, top: string, switching: ReadonlySet<string>): { agents: WorldAgent[]; held: boolean } | null {
    const here = this.agentsIn(state, top);
    if (!here.length || here.some((a) => !IDLE.has(a.status) || switching.has(a.id))) return null;
    return { agents: here, held: here.some((a) => a.waitingOnYou) };
  }

  /** One agent's entry for the team panel. */
  private entry(a: WorldAgent, top: string, sample: Sample, row: Row): UnlandedWork {
    const hold = holdOf(row);
    return {
      agentId: a.id, agentName: a.name, teamId: a.teamId, checkout: top, branch: sample.branch, landing: sample.landing,
      uncommitted: sample.uncommitted, ahead: sample.ahead, since: new Date(row.first_seen).toISOString(), stage: stageOf(row),
      ...(hold ? { held: hold } : {}),
    };
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
      const idle = this.idleIn(state, top, switching);
      if (!idle) {
        this.idle.delete(top);
        next.push(...this.listHeld(state, top, checkout, now));
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
      const { agents: here, held } = idle;
      const team = state.teams.find((t) => here.some((a) => a.teamId === t.id)) ?? null;
      const lead = team ? state.agents.find((a) => a.teamId === team.id && a.role === "lead") ?? null : null;
      const idleSince = this.idle.get(top)!;
      // A state on hold is listed, and nothing is said about it to anyone.
      if (row.hold_reason == null) row = this.escalate({ top, checkout, here, held, team, lead, sample, row, since: Math.max(idleSince, row.resume_at ?? 0), idleSince }, now) ?? row;
      next.push(...here.map((a) => this.entry(a, top, sample, row)));
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
  private escalate(c: { top: string; checkout: Checkout; here: WorldAgent[]; held: boolean; team: WorldTeam | null; lead: WorldAgent | null; sample: Sample; row: Row; since: number; idleSince: number }, now: number): Row | null {
    const { top, row } = c;
    // Someone waiting on the founder is not nagged and the founder is not told what they are already holding;
    // the lead hears of the unlanded work after the founder's hour.
    const dueAgent = !c.held && row.agent_at == null && now - c.since >= this.timing.agentAfterMs;
    // The clocks of the later stages run from the agent being told, or from the latest idle stretch.
    const waited = row.agent_at == null ? 0 : now - Math.max(row.agent_at, c.since);
    const dueLead = c.held ? row.lead_at == null && now - c.since >= this.timing.founderAfterMs
      : row.agent_at != null && row.lead_at == null && waited >= this.timing.leadAfterMs;
    const dueFounder = !c.held && row.agent_at != null && row.founder_at == null && waited >= this.timing.founderAfterMs;
    if (!dueAgent && !dueLead && !dueFounder) return null;
    // The state may have changed, or someone started working, inside the polling window.
    const fresh = this.sample(c.checkout, now, true);
    const latest = this.deps.state();
    const idle = this.idleIn(latest, top, this.deps.switching(latest));
    if (!fresh || fresh.key !== c.sample.key || !idle || idle.held !== c.held) return null;
    const here = idle.agents;
    const runs = c.team ? this.deps.runs(c.team.id, top) : [];
    const run = runs.length ? ` Pipeline run ${runs.map((r) => `${r.id} (candidate ${r.head.slice(0, 7)}${r.next ? `; next step: ${r.next}` : ""})`).join(", ")} ${runs.length === 1 ? "is" : "are"} open with the candidate not delivered.` : "";
    const where = `${top} (branch ${fresh.branch ?? "detached"})`;
    const minutes = (ms: number) => Math.max(1, Math.floor(ms / MINUTE));
    if (dueAgent) {
      this.latch(top, "agent_at", now);
      const merge = this.deps.merge(c.team, top);
      const who = c.lead && !here.some((a) => a.id === c.lead!.id) ? c.lead.name : "founder";
      const hold = inboxCommand('unlanded hold "why"');
      const how = merge ? `Commit it and land it now with ${c.team?.name ?? "your team"}'s merge instruction:\n${merge}\n` : `Commit it and land it on ${fresh.landing} the way your team lands work. `;
      const text = `Unlanded work: you have been idle for ${minutes(now - c.idleSince)} minutes and ${where} holds ${what(fresh)}.${run} ${how}If it must not land yet, hold these reminders for this state with the reason in one line: ${hold}. The founder is told the reason once and nothing more is sent about this state until it changes. To ask for a decision instead: inbox say ${who} "…".`;
      for (const a of here) this.deps.tell(a.id, withInboxPath(text));
    }
    if (dueLead) {
      const lead = c.lead && !here.some((a) => a.id === c.lead!.id) ? c.lead : null;
      this.latch(top, "lead_at", lead ? now : 0);
      const have = here.length === 1 ? "has" : "have";
      const intro = c.held ? `${names(here)} ${have} waited ${minutes(now - c.idleSince)} minutes for the founder's answer with unlanded work.`
        : `${names(here)} ${have} been idle for ${minutes(waited)} minutes since being told to land it, and nothing has changed.`;
      if (lead) this.deps.tell(lead.id, withInboxPath(`Unlanded work on your team: ${intro} ${where} holds ${what(fresh)}.${run} Get it landed, or find out why not: inbox say ${here[0]!.name} "…". If it must stay as it is, you can hold the reminders for this state: ${inboxCommand(`unlanded hold "why" --path ${top}`)}.`));
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

  /** The entries for every agent in a checkout whose state is on hold, whatever they are doing; none when it is not (or no longer). */
  private listHeld(state: WorldState, top: string, checkout: Checkout, now: number): UnlandedWork[] {
    const row = this.row(top);
    if (!row || row.hold_reason == null) return [];
    const sample = this.sample(checkout, now);
    if (!sample) return [];
    // Landed or changed: the hold is over, and the next idle stretch begins afresh.
    if ((!sample.uncommitted && !sample.ahead) || sample.key !== row.state_key) {
      this.clear(top);
      return [];
    }
    return this.agentsIn(state, top).map((a) => this.entry(a, top, sample, row));
  }

  /** Brings the list up to date for one checkout right after a hold or release, so the answer and the panel agree at once. */
  private refresh(top: string, checkout: Checkout, now: number): void {
    const state = this.deps.state();
    const row = this.row(top);
    const sample = this.sample(checkout, now);
    // Listed as the tick lists it: all its agents idle, or its state on hold.
    const listed = !!row && !!sample && sample.key === row.state_key && (row.hold_reason != null || !!this.idleIn(state, top, this.deps.switching(state)));
    const entries = listed ? this.agentsIn(state, top).map((a) => this.entry(a, top, sample!, row!)) : [];
    this.current = [...this.current.filter((w) => w.checkout !== top), ...entries];
  }

  /** The team whose worktree this is: its own, one of its lanes, or one its agents work in. */
  private ownerOf(state: WorldState, top: string): WorldTeam | null {
    const tops = (paths: Array<string | null | undefined>) => paths.some((p) => p && this.deps.checkout(p)?.top === top);
    return state.teams.find((t) => tops([t.path, ...(t.worktrees ?? [])]) || state.agents.some((a) => a.teamId === t.id && tops([a.cwd]))) ?? null;
  }

  /** The checkout a hold or release is about, once the caller is allowed to speak for it. */
  private target(me: WorldAgent, path: string | undefined): { top: string; checkout: Checkout; team: WorldTeam | null } {
    const where = path?.trim() || me.cwd;
    if (!where) throw new InboxError(400, "which worktree? Run it inside the worktree, or pass --path DIR", "unlanded_path");
    if (!isAbsolute(where)) throw new InboxError(400, `${where} is not an absolute path`, "unlanded_path");
    const checkout = this.deps.checkout(where);
    if (!checkout) throw new InboxError(404, `${where} is not inside a git checkout`, "unlanded_path");
    if (!checkout.linked) throw new InboxError(409, `${checkout.top} is the main checkout, where work lands; only worktrees beside it are watched`, "unlanded_main");
    const state = this.deps.state();
    const team = this.ownerOf(state, checkout.top);
    const mine = me.cwd ? this.deps.checkout(me.cwd)?.top : null;
    if (mine !== checkout.top && !(me.role === "lead" && me.teamId && team?.id === me.teamId)) {
      throw new InboxError(403, `${checkout.top} is not yours: only an agent working there, or the lead of the team whose worktree it is, may hold or release its unlanded-work reminders${team ? ` (it is ${team.name}'s)` : ""}`, "unlanded_not_yours");
    }
    return { top: checkout.top, checkout, team };
  }

  /**
   * Puts the reminders for this worktree's state on hold, with a reason: the founder is told it once (one office
   * notice line), and the agent, the lead and the founder hear nothing more about this state. A different
   * state, from any change to the head or to what is uncommitted, ends the hold. Holding again with the same
   * reason changes nothing and says nothing; with another reason it replaces it and tells the founder that.
   */
  hold(me: WorldAgent, reason: string, path: string | undefined, now = Date.now()): UnlandedAnswer {
    const why = String(reason ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
    if (!why) throw new InboxError(400, 'say why it must wait: inbox unlanded hold "why"', "unlanded_reason");
    if (Array.from(why).length > HOLD_REASON_MAX_CHARS) throw new InboxError(400, `the reason is one line of at most ${HOLD_REASON_MAX_CHARS} characters`, "unlanded_reason");
    const { top, checkout, team } = this.target(me, path);
    const sample = this.sample(checkout, now, true);
    if (!sample) throw new InboxError(409, `git cannot say what ${top} holds right now`, "unlanded_unreadable");
    if (!sample.uncommitted && !sample.ahead) throw new InboxError(409, `${top} holds nothing unlanded, so there is nothing to hold`, "unlanded_nothing");
    this.atomic(() => {
      let row = this.row(top);
      if (!row || row.state_key !== sample.key) row = this.begin(top, sample.key, now);
      if (row.hold_reason === why) return;
      this.db.prepare("UPDATE unlanded_watch SET hold_reason = ?, hold_by = ?, held_at = ?, resume_at = NULL WHERE checkout = ?").run(why, me.name, now, top);
      const whose = team?.name ?? this.deps.state().teams.find((t) => t.id === me.teamId)?.name ?? me.name;
      this.deps.tellFounder(`${whose}: ${top} held unlanded: ${why}`, [me.id], now);
    });
    this.refresh(top, checkout, now);
    return this.answer(me, top);
  }

  /** Ends the hold on this worktree's state: the reminders go on, their clocks starting again from now. */
  release(me: WorldAgent, path: string | undefined, now = Date.now()): UnlandedAnswer {
    const { top, checkout } = this.target(me, path);
    const row = this.row(top);
    if (!row || row.hold_reason == null) throw new InboxError(409, `nothing is on hold in ${top}`, "unlanded_not_held");
    this.db.prepare("UPDATE unlanded_watch SET hold_reason = NULL, hold_by = NULL, held_at = NULL, resume_at = ? WHERE checkout = ?").run(now, top);
    this.refresh(top, checkout, now);
    return this.answer(me, top);
  }

  /** What is watched or held for the caller's team (or, without one, the caller's own worktree). */
  answer(me: WorldAgent, top: string | null = null): UnlandedAnswer {
    const mine = me.cwd ? this.deps.checkout(me.cwd)?.top : null;
    const items = this.current.filter((w) => (me.teamId ? w.teamId === me.teamId : w.checkout === mine));
    const row = top ? this.row(top) : undefined;
    return { checkout: top, held: row ? holdOf(row) : null, items };
  }

  private atomic(fn: () => void): void {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try { fn(); this.db.exec("COMMIT"); } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }
}

function holdOf(row: Row): UnlandedHold | null {
  return row.hold_reason == null ? null : { reason: row.hold_reason, by: row.hold_by ?? "", at: new Date(row.held_at ?? row.first_seen).toISOString() };
}

function stageOf(row: Row): UnlandedStage {
  return row.founder_at != null ? "founder" : row.lead_at ? "lead" : row.agent_at != null ? "agent" : "watching";
}
