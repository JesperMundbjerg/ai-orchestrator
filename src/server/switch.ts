// Moving an agent to another harness, so that nobody notices: the agent writes a handoff (it is
// asked to; no model is called here), a session on the other harness starts beside it in the same
// checkout, takes over its office identity (name, team, role, and what waits for it), is told to
// read the handoff, and only then is the old pane closed. Every step is kept in the database as it
// happens, so a restart picks a switch up where it was, and a failure before the old pane closes
// closes the new one and leaves the agent as it was.
//
// The office is told only two things: which panes not to see (a new session before it takes over,
// an old one being closed) and whose deliveries to hold until the new session has its brief.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSwitch, Harness, SwitchOffer, SwitchStep, SwitchesView, WorldAgent } from "../shared/types.ts";
import { HARNESS_INFO } from "../shared/harnesses.ts";
import { DEFAULT_LEAD, MIXED, defaultBackup, type CrewChoice, type CrewRule, type CrewTree } from "../shared/crewtree.ts";
import { startFlags } from "./crewtree.ts";
import { InboxError } from "./inbox.ts";
import { agentId, hookSettings, liveIdentity, type AgentSource, type LiveAgent, type World } from "./world.ts";

/** What a switch needs from herdr beyond what the office already uses. */
export interface SwitchSource extends AgentSource {
  /** A shell pane in `cwd`: beside `beside` in its tab, or in a workspace of its own when there is none. */
  openPane(cwd: string, beside: string | null, label: string): Promise<string>;
  /** Gives a running agent the name herdr knows it by. */
  renameAgent(paneId: string, name: string): Promise<void>;
}

export interface SwitchTiming {
  /** How long a busy agent is waited for before the switch gives up. */
  freeMs: number;
  /** How long its handoff is waited for once it has been asked. */
  handoffMs: number;
  /** A handoff left unchanged this long counts as written, even while its writer is still on its turn. */
  quietMs: number;
  pollMs: number;
}

export const SWITCH_TIMING: SwitchTiming = { freeMs: 30 * 60_000, handoffMs: 10 * 60_000, quietMs: 30_000, pollMs: 2000 };

/** The harnesses crew run as, and so the ones an agent can be switched between. */
const SWITCHABLE: readonly Harness[] = ["claude", "pi"];
const FREE: ReadonlySet<string> = new Set(["idle", "done"]);
const FINISHED: ReadonlySet<SwitchStep> = new Set(["done", "failed"]);
/** Until the old pane is closed, a failure closes the new one and the agent is as it was. */
const UNDOABLE: ReadonlySet<SwitchStep> = new Set(["queued", "waiting", "handoff", "opening", "starting", "closing"]);
/** A finished switch stays on show this long. */
const RECENT_MS = 10 * 60_000;
const label = (h: Harness) => HARNESS_INFO[h].label;
const other = (h: Harness): Harness => (h === "claude" ? "pi" : "claude");
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,80}$/;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const opt = (v: unknown): string | null => (v == null ? null : String(v));

/** A failure the switch reports as it is; anything else is reported by its message. */
class Refused extends Error {}

/** Two names for one model: the crew tree says "opus", the harness reports "claude-opus-5-5" or "anthropic/claude-opus-5-5". */
function sameModel(a: string, b: string): boolean {
  const bare = (m: string) => m.toLowerCase().split("/").pop()!.replace(/:.*$/, "");
  const [x, y] = [bare(a), bare(b)];
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/**
 * What an agent runs on after switching to `to`: the other half of the crew tree's pair it runs as
 * (the lead's pair first for a lead, then the rules, then the fallback), or the standard stand-in
 * for its model when no pair names it. Deterministic, and the founder's tree decides.
 */
export function switchChoice(tree: Pick<CrewTree, "rules" | "fallback" | "lead"> | null, from: { harness: Harness; model: string | null; lead: boolean }, to: Harness): CrewChoice {
  const pairs: Array<[CrewChoice, CrewChoice]> = [];
  const lead = tree?.lead ?? DEFAULT_LEAD;
  if (from.lead) pairs.push([lead.use, lead.backup]);
  const walk = (rules: CrewRule[]) => rules.forEach((r) => { if (r.use && r.backup) pairs.push([r.use, r.backup]); walk(r.children ?? []); });
  walk(tree?.rules ?? []);
  const fallback = tree ? [tree.fallback, tree.fallback.backup] as [CrewChoice, CrewChoice] : null;
  if (fallback) pairs.push(fallback);
  if (!from.lead) pairs.push([lead.use, lead.backup]);
  const across = ([a, b]: [CrewChoice, CrewChoice], model: string | null): CrewChoice | null => {
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      if (mine.harness === from.harness && theirs.harness === to && (model === null || sameModel(mine.model, model))) return theirs;
    }
    return null;
  };
  if (from.model) {
    for (const pair of pairs) {
      const found = across(pair, from.model);
      if (found) return { ...found };
    }
    const standIn = defaultBackup({ harness: from.harness, model: from.model, effort: "high" });
    if (standIn.harness === to) return standIn;
  }
  // The model is not known: the lead's pair for a lead, the fallback's for anyone else.
  const pair = from.lead ? [lead.use, lead.backup] as [CrewChoice, CrewChoice] : fallback ?? [lead.use, lead.backup] as [CrewChoice, CrewChoice];
  return { ...(across(pair, null) ?? (pair[0].harness === to ? pair[0] : pair[1].harness === to ? pair[1] : defaultBackup({ harness: from.harness, model: "", effort: "high" }))) };
}

/** A name herdr can start an agent under: lowercase, starting with a letter. */
function herdrName(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(slug) ? slug : `a-${slug}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Switches {
  private db: DatabaseSync;
  private world: World;
  private source: SwitchSource | null;
  private dir: string;
  private now: () => Date;
  private timing: SwitchTiming;
  private hidden = new Set<string>();
  private held = new Set<string>();
  private driving = new Map<string, Promise<void>>();
  private batches = new Map<string, Promise<void>>();
  private tree: { at: number; tree: CrewTree | null } | null = null;

  /** `dir` is the service's data directory: handoffs are written under it. */
  constructor(db: DatabaseSync, world: World, source: SwitchSource | null, dir: string, opts: { now?: () => Date; timing?: Partial<SwitchTiming> } = {}) {
    this.db = db;
    this.world = world;
    this.source = source;
    this.dir = dir;
    this.now = opts.now ?? (() => new Date());
    this.timing = { ...SWITCH_TIMING, ...opts.timing };
    world.hiddenPanes = () => this.hidden;
    world.messages.held = () => this.held;
    world.switches = this;
    this.recount();
  }

  /** Picks up every switch a restart interrupted, where it was. */
  async resume(): Promise<void> {
    await this.source?.refresh?.().catch(() => {});
    const open = (this.db.prepare("SELECT id, batch_id FROM agent_switches WHERE step NOT IN ('done', 'failed') ORDER BY seq, started_at").all() as Row[]);
    for (const batch of new Set(open.flatMap((r) => (r.batch_id ? [str(r.batch_id)] : [])))) void this.runBatch(batch);
    for (const r of open) if (!r.batch_id) void this.drive(str(r.id));
  }

  /** Starts switching one agent, named as the office shows it or by id. Refused at once when it cannot be done. */
  start(ref: string, opts: { to?: unknown; model?: unknown; effort?: unknown } = {}): AgentSwitch {
    const agent = this.find(ref);
    const id = this.insert(agent, this.plan(agent, opts), null, 0);
    void this.drive(id);
    return this.get(id);
  }

  /** Switches every running agent on `from`, one by one; those that cannot be are said, not switched. */
  allFrom(from: unknown, opts: { to?: unknown; model?: unknown; effort?: unknown } = {}): { batchId: string; switches: AgentSwitch[]; skipped: Array<{ name: string; why: string }> } {
    if (typeof from !== "string" || !SWITCHABLE.includes(from as Harness)) throw new InboxError(400, `name the harness to switch away from: ${SWITCHABLE.join(" or ")}`);
    const running = this.world.state().agents.filter((a) => a.harness === from && a.paneId);
    if (!running.length) throw new InboxError(404, `nobody is running on ${label(from as Harness)}`);
    const batchId = randomUUID();
    const skipped: Array<{ name: string; why: string }> = [];
    const ids: string[] = [];
    for (const agent of running) {
      try {
        ids.push(this.insert(agent, this.plan(agent, opts), batchId, ids.length));
      } catch (err) {
        skipped.push({ name: agent.name, why: (err as Error).message });
      }
    }
    if (ids.length) void this.runBatch(batchId);
    return { batchId, switches: ids.map((id) => this.get(id)), skipped };
  }

  get(id: string): AgentSwitch {
    const row = this.row(id);
    if (!row) throw new InboxError(404, `no switch ${id}`);
    return toSwitch(row);
  }

  list(): AgentSwitch[] {
    return (this.db.prepare("SELECT * FROM agent_switches ORDER BY started_at DESC, seq DESC LIMIT 100").all() as Row[]).map(toSwitch);
  }

  /** Resolves once the switch has finished, done or failed. */
  async settled(id: string): Promise<AgentSwitch> {
    const s = this.get(id);
    if (s.batchId) await this.batches.get(s.batchId);
    await this.driving.get(id);
    return this.get(id);
  }

  view(agents: WorldAgent[]): SwitchesView {
    const offers: Record<string, SwitchOffer> = {};
    for (const a of agents) {
      if (!SWITCHABLE.includes(a.harness)) continue;
      const to = other(a.harness);
      const choice = this.choiceFor(a, to);
      offers[a.id] = { harness: to, label: label(to), model: choice.model, effort: choice.effort, refused: this.refusal(a, to) };
    }
    const since = new Date(this.now().getTime() - RECENT_MS).toISOString();
    const recent = (this.db.prepare("SELECT * FROM agent_switches WHERE step NOT IN ('done', 'failed') OR updated_at >= ? ORDER BY started_at, seq").all(since) as Row[]).map(toSwitch);
    return { offers, recent };
  }

  /** What to start and where, or why not. */
  private plan(agent: WorldAgent, opts: { to?: unknown; model?: unknown; effort?: unknown }): CrewChoice {
    if (opts.to !== undefined && opts.to !== null && !SWITCHABLE.includes(opts.to as Harness)) throw new InboxError(400, `switch to ${SWITCHABLE.join(" or ")}`);
    const to = (opts.to as Harness | undefined) ?? other(agent.harness);
    const why = this.refusal(agent, to);
    if (why) throw new InboxError(409, why);
    const choice = this.choiceFor(agent, to);
    if (opts.model !== undefined && opts.model !== null && opts.model !== "") {
      if (typeof opts.model !== "string" || !MODEL.test(opts.model)) throw new InboxError(400, "a model is letters, digits and . _ / : - only");
      choice.model = opts.model;
    }
    if (opts.effort !== undefined && opts.effort !== null && opts.effort !== "") {
      if (typeof opts.effort !== "string" || !/^[a-z]{1,16}$/.test(opts.effort)) throw new InboxError(400, "an effort is a word such as high");
      choice.effort = opts.effort;
    }
    return choice;
  }

  private refusal(agent: WorldAgent, to: Harness): string | null {
    if (!SWITCHABLE.includes(agent.harness)) return `${agent.name} runs on ${label(agent.harness)}; only ${SWITCHABLE.map(label).join(" and ")} agents can be switched`;
    if (agent.harness === to) return `${agent.name} already runs on ${label(to)}`;
    const mode = this.crewTree()?.mode ?? MIXED;
    if (mode !== MIXED && mode !== to) return `the founder has switched ${label(to)} off in the crew guide`;
    if (!agent.cwd) return `${agent.name} has no checkout for a new session to start in`;
    if (!this.source?.available()) return "herdr is not running, and the switch goes through it";
    const active = this.db.prepare("SELECT to_harness FROM agent_switches WHERE agent_id = ? AND step NOT IN ('done', 'failed')").get(agent.id) as Row | undefined;
    if (active) return `${agent.name} is already being switched to ${label(str(active.to_harness) as Harness)}`;
    return null;
  }

  private choiceFor(agent: WorldAgent, to: Harness): CrewChoice {
    return switchChoice(this.crewTree(), { harness: agent.harness, model: agent.model?.id ?? null, lead: agent.role === "lead" }, to);
  }

  /** The crew tree, read at most every two seconds: the office asks for it with every redraw. */
  private crewTree(): CrewTree | null {
    const at = this.now().getTime();
    if (!this.tree || at - this.tree.at > 2000) this.tree = { at, tree: this.world.crew?.state().tree ?? null };
    return this.tree.tree;
  }

  private find(ref: string): WorldAgent {
    const name = String(ref ?? "").trim().toLowerCase();
    const agents = this.world.state().agents;
    const found = agents.find((a) => a.id === ref) ?? agents.find((a) => a.name.toLowerCase() === name);
    if (!found) throw new InboxError(404, `nobody called ${ref} in the office`);
    return found;
  }

  private insert(agent: WorldAgent, choice: CrewChoice, batchId: string | null, seq: number): string {
    const id = randomUUID().slice(0, 8);
    const at = this.now().toISOString();
    const to = choice.harness as Harness;
    const says = batchId && seq > 0 ? `Waiting for its turn: the others on ${label(agent.harness)} are switched first` : this.waitingSays(agent);
    this.db.prepare(`INSERT INTO agent_switches (id, agent_id, agent_name, cwd, from_harness, to_harness, model, effort, step, says, batch_id, seq, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, agent.id, agent.name, agent.cwd!, agent.harness, to, choice.model, choice.effort, batchId ? "queued" : "waiting", says, batchId, seq, at, at);
    this.changed();
    return id;
  }

  private waitingSays(agent: WorldAgent): string {
    return agent.paneId ? `Waiting for ${agent.name} to be free` : `${agent.name} is not running, so there is no handoff to write`;
  }

  /** A batch goes one agent at a time, in the order it was asked. */
  private runBatch(batchId: string): Promise<void> {
    const running = this.batches.get(batchId);
    if (running) return running;
    const run = (async () => {
      const rows = this.db.prepare("SELECT id FROM agent_switches WHERE batch_id = ? ORDER BY seq").all(batchId) as Row[];
      for (const r of rows) {
        const s = this.row(str(r.id))!;
        if (FINISHED.has(s.step as SwitchStep)) continue;
        if (s.step === "queued") {
          const agent = this.world.state().agents.find((a) => a.id === str(s.agent_id));
          this.update(str(s.id), { step: "waiting", says: agent ? this.waitingSays(agent) : `Waiting for ${str(s.agent_name)}` });
        }
        await this.drive(str(r.id));
      }
    })().finally(() => this.batches.delete(batchId));
    this.batches.set(batchId, run);
    return run;
  }

  private drive(id: string): Promise<void> {
    const running = this.driving.get(id);
    if (running) return running;
    const run = (async () => {
      for (;;) {
        const s = this.row(id);
        if (!s || FINISHED.has(s.step as SwitchStep) || s.step === "queued") return;
        let next: "wait" | "next";
        try {
          next = await this.advance(s);
        } catch (err) {
          await this.fail(id, err);
          return;
        }
        if (next === "wait") await sleep(this.timing.pollMs);
      }
    })().catch((err: Error) => console.error(`switch ${id}: ${err.message}`)).finally(() => this.driving.delete(id));
    this.driving.set(id, run);
    return run;
  }

  /** One step of a switch: done, then the next is recorded; or "wait" to look again shortly. */
  private async advance(s: Row): Promise<"wait" | "next"> {
    const id = str(s.id);
    const name = str(s.agent_name);
    const from = str(s.from_harness) as Harness;
    const to = str(s.to_harness) as Harness;
    const source = this.source;
    if (!source) throw new Refused("herdr is not available");
    const at = this.now().getTime();
    switch (s.step as SwitchStep) {
      case "waiting": {
        const agent = this.agent(s);
        if (!agent.paneId) {
          this.update(id, { step: "opening", says: `${name} is not running, so there is no handoff to write. Opening a pane for ${label(to)}` });
          return "next";
        }
        if (!FREE.has(agent.status)) {
          if (at - Date.parse(str(s.started_at)) > this.timing.freeMs) throw new Refused(`${name} stayed busy for ${minutes(this.timing.freeMs)}`);
          return "wait";
        }
        const file = this.handoffPath(name);
        mkdirSync(join(file, ".."), { recursive: true });
        await source.prompt(agent.paneId, handoffPrompt(name, label(to), file));
        const oldName = source.live().find((l) => l.paneId === agent.paneId)?.name ?? null;
        this.update(id, { step: "handoff", handoff: file, old_pane: agent.paneId, old_name: oldName, asked_at: this.now().toISOString(), says: `Asked ${name} to write a handoff to ${file}` });
        return "next";
      }
      case "handoff": {
        const agent = this.agent(s);
        const file = str(s.handoff);
        const written = fileState(file);
        if (written && written.size > 0 && (!agent.paneId || FREE.has(agent.status) || at - written.mtimeMs >= this.timing.quietMs)) {
          this.update(id, { step: "opening", says: `${name} wrote its handoff. Opening a pane for ${label(to)} beside it` });
          return "next";
        }
        if (!agent.paneId) throw new Refused(`${name} stopped running before it wrote its handoff`);
        if (at - Date.parse(str(s.asked_at)) > this.timing.handoffMs) throw new Refused(`${name} did not write its handoff within ${minutes(this.timing.handoffMs)}`);
        return "wait";
      }
      case "opening": {
        const why = this.refusalNow(s);
        if (why) throw new Refused(why);
        const agent = this.agent(s);
        const live = source.live();
        const oldName = agent.paneId ? live.find((l) => l.paneId === agent.paneId)?.name ?? opt(s.old_name) : null;
        const beside = agent.paneId ?? this.teammatePane(agent);
        const taken = new Set(live.flatMap((l) => (l.name ? [l.name] : [])));
        const base = herdrName(oldName ?? name).replace(/-(claude|pi)(-\d+)?$/, "").slice(0, 24);
        let newName = `${base}-${to}`;
        for (let n = 2; taken.has(newName); n++) newName = `${base}-${to}-${n}`;
        const pane = await source.openPane(str(s.cwd), beside, name);
        this.update(id, { step: "starting", new_pane: pane, new_name: newName, old_pane: agent.paneId, old_name: oldName, says: `Starting ${label(to)} (${str(s.model)}, ${str(s.effort)} effort) ${agent.paneId ? `beside ${name}` : "in its checkout"}` });
        return "next";
      }
      case "starting": {
        const pane = str(s.new_pane);
        const running = () => source.live().some((l) => l.paneId === pane && l.harness === to);
        if (!running()) {
          const choice = { harness: to, model: str(s.model), effort: str(s.effort) };
          try {
            await source.startAgent(pane, str(s.new_name), to, [...startFlags(choice), ...(to === "claude" ? hookSettings(str(s.cwd)) : [])]);
          } catch (err) {
            await source.refresh?.().catch(() => {});
            if (!running()) throw new Refused(`${label(to)} did not start (herdr: ${(err as Error).message})`);
          }
          await source.refresh?.().catch(() => {});
          if (!running()) throw new Refused(`${label(to)} did not start in the new pane`);
        }
        const old = opt(s.old_pane);
        this.update(id, { step: "closing", says: old ? `${label(to)} is running. Closing ${name}'s ${label(from)} pane` : `${label(to)} is running` });
        return "next";
      }
      case "closing": {
        const old = opt(s.old_pane);
        if (old && source.live().some((l) => l.paneId === old)) {
          try {
            await source.closePane(old);
          } catch (err) {
            await source.refresh?.().catch(() => {});
            if (source.live().some((l) => l.paneId === old)) throw new Refused(`${name}'s ${label(from)} pane would not close (herdr: ${(err as Error).message})`);
          }
        }
        this.update(id, { step: "taking_over", says: `${name} is taking over in the ${label(to)} session` });
        return "next";
      }
      case "taking_over": {
        const pane = str(s.new_pane);
        let live = source.live().find((l) => l.paneId === pane);
        const oldName = opt(s.old_name);
        if (live && oldName && live.name !== oldName) {
          // The old name is free now its pane is closed; the new session goes by it, so a lead's `herdr agent prompt <name>` still reaches it.
          await source.renameAgent(pane, oldName).catch(() => {});
        }
        await source.refresh?.().catch(() => {});
        live = source.live().find((l) => l.paneId === pane) ?? live;
        if (!live) throw new Refused(`the new ${label(to)} session stopped before it could take over`);
        this.takeOver(s, live);
        return "next";
      }
      case "briefing": {
        const agent = this.agent(s);
        const text = briefPrompt(name, label(from), opt(s.handoff), agent.role === "lead");
        try {
          await source.prompt(str(s.new_pane), text);
        } catch {
          // It cannot take a prompt now (asking whether to trust the folder, say): it gets the brief as a message once it is free.
          this.world.messages.notice(agent.id, text);
        }
        this.update(id, { step: "done", says: `${name} runs on ${label(to)} now (${str(s.model)}, ${str(s.effort)} effort)${opt(s.handoff) ? ", with its handoff" : ""}` });
        return "next";
      }
      default:
        return "wait";
    }
  }

  /**
   * The new session becomes the agent: its record takes the new session's identity, so its id,
   * name, team, role, messages and queued deliveries are simply still its own. The old identity is
   * kept as removed, so the old session's inbox tasks do not bring back a stranger under it.
   */
  private takeOver(s: Row, live: LiveAgent): void {
    const id = str(s.agent_id);
    const identity = liveIdentity(live);
    const at = this.now().toISOString();
    this.tx(() => {
      const row = this.db.prepare("SELECT * FROM world_agents WHERE id = ?").get(id) as Row | undefined;
      if (!row) throw new Refused(`${str(s.agent_name)} is no longer in the office`);
      const before = str(row.identity);
      if (before !== identity) {
        const stale = this.db.prepare("SELECT id FROM world_agents WHERE identity = ? AND id != ?").get(identity, id) as Row | undefined;
        if (stale) this.fold(str(stale.id), id);
        this.db.prepare("UPDATE world_agents SET identity = ?, ran_at = coalesce(ran_at, ?), removed = 0 WHERE id = ?").run(identity, at, id);
        this.db.prepare("INSERT OR IGNORE INTO world_agents (id, identity, name, role, first_seen_at, ran_at, removed) VALUES (?, ?, ?, 'member', ?, ?, 1)")
          .run(agentId(`${before}|switched|${str(s.id)}`), before, `${str(s.agent_name)} (${label(str(s.from_harness) as Harness)})`, at, at);
      }
      if (s.old_pane) this.db.prepare("UPDATE teams SET lead_pane = ? WHERE lead_pane = ?").run(str(s.new_pane), str(s.old_pane));
      this.write(str(s.id), { step: "briefing", says: `${str(s.agent_name)} has taken over. Giving the ${label(str(s.to_harness) as Harness)} session its brief` });
    });
    this.recount();
    this.world.onChange("world");
  }

  /** What was another record's becomes `into`'s, and that record goes. */
  private fold(from: string, into: string): void {
    this.db.prepare("UPDATE OR IGNORE message_deliveries SET agent_id = ? WHERE agent_id = ?").run(into, from);
    this.db.prepare("DELETE FROM message_deliveries WHERE agent_id = ?").run(from);
    this.db.prepare("UPDATE messages SET from_agent_id = ? WHERE from_agent_id = ?").run(into, from);
    this.db.prepare("UPDATE work SET from_agent_id = ? WHERE from_agent_id = ?").run(into, from);
    this.db.prepare("UPDATE work SET reviewer_id = ? WHERE reviewer_id = ?").run(into, from);
    this.db.prepare("DELETE FROM world_agents WHERE id = ?").run(from);
  }

  private async fail(id: string, err: unknown): Promise<void> {
    const s = this.row(id);
    if (!s) return;
    const why = (err as Error)?.message ?? String(err);
    const name = str(s.agent_name);
    const to = str(s.to_harness) as Harness;
    let after: string;
    if (UNDOABLE.has(s.step as SwitchStep)) {
      if (s.new_pane) await this.source?.closePane(str(s.new_pane)).catch(() => {});
      after = `${name} is left as it was`;
    } else {
      after = `${name}'s old pane is already closed; the ${label(to)} session${s.new_pane ? ` in pane ${str(s.new_pane)}` : ""} carries on`;
    }
    this.update(id, { step: "failed", error: why, says: `Not switched: ${why}. ${after}.` });
  }

  /** What the founder may have changed since the switch was asked for: the switch, or the agent itself. */
  private refusalNow(s: Row): string | null {
    const to = str(s.to_harness) as Harness;
    const mode = this.crewTree()?.mode ?? MIXED;
    if (mode !== MIXED && mode !== to) return `the founder has switched ${label(to)} off in the crew guide`;
    if (!this.source?.available()) return "herdr is not running";
    return null;
  }

  private agent(s: Row): WorldAgent {
    const agent = this.world.state().agents.find((a) => a.id === str(s.agent_id));
    if (!agent) throw new Refused(`${str(s.agent_name)} is no longer in the office`);
    return agent;
  }

  /** Where a new session for someone not running goes: beside a teammate, its lead first. */
  private teammatePane(agent: WorldAgent): string | null {
    if (!agent.teamId) return null;
    const mates = this.world.state().agents.filter((a) => a.teamId === agent.teamId && a.id !== agent.id && a.paneId);
    return (mates.find((a) => a.role === "lead") ?? mates[0])?.paneId ?? null;
  }

  private handoffPath(name: string): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    return join(this.dir, "handoffs", "switch", `${herdrName(name)}-${stamp}.md`);
  }

  private row(id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM agent_switches WHERE id = ?").get(id) as Row | undefined;
  }

  private update(id: string, patch: Record<string, string | null>): void {
    this.write(id, patch);
    this.recount();
    this.world.onChange("world");
  }

  private write(id: string, patch: Record<string, string | null>): void {
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE agent_switches SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), this.now().toISOString(), id);
  }

  private changed(): void {
    this.recount();
    this.world.onChange("world");
  }

  /**
   * Which panes the office does not see: a new session until it has taken over (so it never shows
   * as a stranger, or as a new project's lead), and the old one once it is being let go. Whose
   * deliveries wait: everyone being switched, until the new session has its brief.
   */
  private recount(): void {
    const rows = this.db.prepare("SELECT * FROM agent_switches WHERE step NOT IN ('done', 'failed', 'queued')").all() as Row[];
    this.hidden = new Set(rows.flatMap((r) => [
      ...(r.new_pane && ["starting", "closing", "taking_over"].includes(str(r.step)) ? [str(r.new_pane)] : []),
      ...(r.old_pane && r.step === "taking_over" ? [str(r.old_pane)] : []),
    ]));
    this.held = new Set(rows.map((r) => str(r.agent_id)));
  }

  private tx(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

function toSwitch(r: Row): AgentSwitch {
  const to = str(r.to_harness) as Harness;
  return {
    id: str(r.id),
    agentId: str(r.agent_id),
    agentName: str(r.agent_name),
    from: str(r.from_harness) as Harness,
    to,
    toLabel: label(to),
    model: str(r.model),
    effort: str(r.effort),
    step: str(r.step) as SwitchStep,
    says: str(r.says),
    handoff: opt(r.handoff),
    error: opt(r.error),
    batchId: opt(r.batch_id),
    startedAt: str(r.started_at),
    updatedAt: str(r.updated_at),
  };
}

function fileState(path: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/** What the agent being switched is asked: it writes its own handoff, in its own words. */
export function handoffPrompt(name: string, to: string, file: string): string {
  return [
    `The founder is moving you to ${to}: a new ${to} session will take over as ${name} in this checkout, with your name, team and role, and this session will then be closed.`,
    `Write a handoff for it now to ${file}: what you are doing and where it stands; your open threads (who waits on you, what you promised, what you wait on); the files you own or have uncommitted changes in; and exactly how to continue.`,
    "Write the whole file in one go, then stop and wait. Do not start anything new, and do not tell anyone about the move.",
  ].join(" ");
}

/** The new session's first prompt: who it is now, and the handoff to read before anything else. */
export function briefPrompt(name: string, from: string, handoff: string | null, lead: boolean): string {
  return [
    `You are ${name} in the office now: you take over from ${name}'s ${from} session, which has been closed. The office already treats you as ${name}, with the same name, team and role${lead ? " (you lead your project)" : ""}, and messages for ${name} come to you.`,
    handoff ? `First read the handoff it wrote for you: ${handoff}.` : `${name} was not running, so there is no handoff.`,
    "Then run `inbox team` to see your project, your crew and what waits for you, and carry on with the work where it stands. Do not announce the switch; just continue.",
  ].join(" ");
}
