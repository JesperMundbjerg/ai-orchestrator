// What is said in the office: your instructions to a team, agents' messages to each other,
// finished work handed to another team, and that team's verdict. Every message is stored with
// one delivery row per agent it is meant for. A delivery is typed into the agent's terminal
// only once herdr reports the agent free, one message at a time per agent, oldest first.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Delivery, DeliveryState, Message, MessageKind, Team, Work, WorkState, WorldAgent, WorldState } from "../shared/types.ts";
import { InboxError } from "./inbox.ts";
import type { AgentSource } from "./world.ts";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const opt = (v: unknown): string | null => (v == null ? null : String(v));

const MESSAGES_SHOWN = 60;
const REVIEWED_SHOWN = 30;
const MAX_TEXT = 8000;
/** Agents talking to each other cost tokens on both sides; a runaway exchange stops here. */
const AGENT_MESSAGES_PER_HOUR = 30;
/** An agent is free for a new prompt when it has finished its turn and is not asking anything. */
const FREE: ReadonlySet<WorldAgent["status"]> = new Set(["idle", "done"]);

export class Messages {
  private db: DatabaseSync;
  private source: AgentSource | null;
  private world: () => WorldState;
  private now: () => Date;
  private changed: () => void;

  constructor(db: DatabaseSync, source: AgentSource | null, world: () => WorldState, now: () => Date, changed: () => void) {
    this.db = db;
    this.source = source;
    this.world = world;
    this.now = now;
    this.changed = changed;
  }

  /** The latest messages, newest first. */
  list(): Message[] {
    const rows = this.db.prepare(`SELECT *, rowid AS seq FROM messages ORDER BY rowid DESC LIMIT ${MESSAGES_SHOWN}`).all() as Row[];
    return this.withDeliveries(rows);
  }

  /** Everything under review, then the latest reviewed. */
  work(): Work[] {
    const rows = this.db
      .prepare(`SELECT * FROM work WHERE state = 'in_review' UNION ALL SELECT * FROM (SELECT * FROM work WHERE state != 'in_review' ORDER BY updated_at DESC LIMIT ${REVIEWED_SHOWN}) ORDER BY updated_at DESC`)
      .all() as Row[];
    return rows.map(toWork);
  }

  /** Your instruction to a team, heard by its lead. Retrying with the same client id returns the first message. */
  instruct(teamId: string, input: { text?: string; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const state = this.world();
    const team = teamOf(state, teamId);
    return this.store("instruction", null, team.id, text(input.text), null, recipients(state, team, null), input.clientId);
  }

  /** Your message to one agent, typed into its terminal once it is free. */
  tell(agentId: string, input: { text?: string; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const agent = this.world().agents.find((a) => a.id === agentId);
    if (!agent) throw new InboxError(404, `no agent ${agentId}`);
    return this.store("message", null, null, text(input.text), null, [agent.id], input.clientId);
  }

  /** One agent to another agent or a team, named as the office shows it. */
  say(from: WorldAgent, input: { to?: string; text?: string; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const body = text(input.text);
    this.limit(from);
    const state = this.world();
    const name = input.to?.trim().toLowerCase();
    if (!name) throw new InboxError(400, "say who the message is for: an agent's name or a team's");
    const agent = state.agents.find((a) => a.name.toLowerCase() === name);
    if (agent) {
      if (agent.id === from.id) throw new InboxError(400, "that is you");
      return this.store("message", from.id, null, body, null, [agent.id], input.clientId);
    }
    const team = state.teams.find((t) => t.name.toLowerCase() === name);
    if (!team) throw new InboxError(404, `nobody called ${input.to} in the office: see who is there with \`inbox team\``);
    return this.store("message", from.id, team.id, body, null, recipients(state, team, from.id), input.clientId);
  }

  /**
   * Finished work passed to a team to review: the team named, or the one the sender's team hands
   * its work to. Handing over the same work again after changes starts its next round.
   */
  handoff(from: WorldAgent, input: { title?: string; summary?: string; to?: string; work?: string; clientId?: string }): { work: Work; message: Message } {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return { work: this.workById(repeat.workId!), message: repeat };
    this.limit(from);
    const state = this.world();
    const summary = text(input.summary);
    const at = this.now().toISOString();
    let work: Work;
    if (input.work) {
      const earlier = this.workById(input.work);
      if (earlier.fromAgentId !== from.id && (!from.teamId || earlier.fromTeamId !== from.teamId)) throw new InboxError(403, "only the agent or team that handed this work over can hand it over again");
      if (earlier.state === "in_review") throw new InboxError(409, "this work is still under review");
      this.db.prepare("UPDATE work SET state = 'in_review', round = round + 1, summary = ?, reviewer_id = NULL, notes = '', updated_at = ? WHERE id = ?").run(summary, at, earlier.id);
      work = this.workById(earlier.id);
    } else {
      const title = input.title?.trim();
      if (!title) throw new InboxError(400, "a handoff needs a title");
      const own = state.teams.find((t) => t.id === from.teamId) ?? null;
      const target = input.to ? state.teams.find((t) => t.name.toLowerCase() === input.to!.trim().toLowerCase()) : own?.handsTo ? state.teams.find((t) => t.id === own.handsTo) : undefined;
      if (!target) {
        throw new InboxError(input.to ? 404 : 409, input.to ? `no team called ${input.to}` : "your team does not hand its work to anyone yet: name the team with --to");
      }
      if (target.id === from.teamId) throw new InboxError(400, "hand work to another team, not your own");
      const id = randomUUID().slice(0, 8);
      this.db
        .prepare("INSERT INTO work (id, title, summary, from_agent_id, from_team_id, to_team_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'in_review', ?, ?)")
        .run(id, title, summary, from.id, from.teamId, target.id, at, at);
      work = this.workById(id);
    }
    const team = teamOf(state, work.toTeamId);
    const message = this.store("handoff", from.id, team.id, summary, work.id, recipients(state, team, from.id), input.clientId);
    return { work, message };
  }

  /** The reviewing team's verdict, sent back to whoever handed the work over. */
  review(by: WorldAgent, input: { work?: string; verdict?: string; notes?: string }): { work: Work; message: Message } {
    const work = this.workById(input.work ?? "");
    if (by.teamId !== work.toTeamId) throw new InboxError(403, "only the team the work was handed to can review it");
    if (work.state !== "in_review") throw new InboxError(409, `this work is already ${work.state === "accepted" ? "accepted" : "sent back"}`);
    const verdict: WorkState | null = input.verdict === "accept" ? "accepted" : input.verdict === "changes" ? "changes_requested" : null;
    if (!verdict) throw new InboxError(400, "the verdict is accept or changes");
    const notes = input.notes?.trim() ?? "";
    if (verdict === "changes_requested" && !notes) throw new InboxError(400, "say what needs to change");
    this.db.prepare("UPDATE work SET state = ?, reviewer_id = ?, notes = ?, updated_at = ? WHERE id = ?").run(verdict, by.id, notes, this.now().toISOString(), work.id);
    const said = verdict === "accepted" ? "Accepted." : "Changes requested.";
    const message = this.store("review", by.id, null, notes ? `${said}\n\n${notes}` : said, work.id, [work.fromAgentId]);
    return { work: this.workById(work.id), message };
  }

  /** Puts a failed delivery back in line. */
  retry(messageId: string, agentId: string): Message {
    const done = this.db
      .prepare("UPDATE message_deliveries SET state = 'queued', error = NULL, updated_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'failed'")
      .run(this.now().toISOString(), messageId, agentId);
    if (!done.changes) throw new InboxError(409, "only a failed delivery can be retried");
    this.changed();
    return this.message(messageId);
  }

  /** Types every message whose agent has become free, one per agent, oldest first. */
  async deliver(state: WorldState): Promise<void> {
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const pending = this.db
      .prepare("SELECT d.agent_id, d.state, m.* FROM message_deliveries d JOIN messages m ON m.id = d.message_id WHERE d.state IN ('queued', 'sending') ORDER BY m.rowid")
      .all() as Row[];
    const busy = new Set<string>();
    const sends: Array<Promise<void>> = [];
    for (const row of pending) {
      const agentId = str(row.agent_id);
      if (busy.has(agentId)) continue;
      busy.add(agentId);
      const agent = agents.get(agentId);
      if (row.state === "queued" && agent?.paneId && FREE.has(agent.status)) sends.push(this.send(toMessage(row, []), agent, state));
    }
    await Promise.all(sends);
  }

  private async send(message: Message, agent: WorldAgent, state: WorldState): Promise<void> {
    // Claimed before typing, so two deliveries running at once never type the same message twice.
    const claimed = this.db
      .prepare("UPDATE message_deliveries SET state = 'sending', updated_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'queued'")
      .run(this.now().toISOString(), message.id, agent.id);
    if (!claimed.changes || !this.source) return;
    this.changed();
    let error: string | null = null;
    try {
      await this.source.prompt(agent.paneId!, prompt(message, agent, state, message.workId ? this.workById(message.workId) : null));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.db
      .prepare("UPDATE message_deliveries SET state = ?, error = ?, updated_at = ? WHERE message_id = ? AND agent_id = ?")
      .run(error ? "failed" : "delivered", error, this.now().toISOString(), message.id, agent.id);
    this.changed();
  }

  private store(kind: MessageKind, fromAgentId: string | null, teamId: string | null, body: string, workId: string | null, to: string[], clientId?: string): Message {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO messages (id, kind, from_agent_id, team_id, text, work_id, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, kind, fromAgentId, teamId, body, workId, clientId ?? null, at);
      for (const agentId of to) {
        this.db.prepare("INSERT INTO message_deliveries (message_id, agent_id, state, updated_at) VALUES (?, ?, 'queued', ?)").run(id, agentId, at);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.changed();
    return this.message(id);
  }

  private limit(from: WorldAgent): void {
    const since = new Date(this.now().getTime() - 3_600_000).toISOString();
    const sent = this.db.prepare("SELECT count(*) AS n FROM messages WHERE from_agent_id = ? AND created_at > ?").get(from.id, since) as { n: number };
    if (sent.n >= AGENT_MESSAGES_PER_HOUR) throw new InboxError(429, `you have sent ${sent.n} messages in the last hour; wait, or ask the founder in the review inbox`);
  }

  private byClientId(clientId: string | undefined): Message | null {
    if (!clientId) return null;
    const row = this.db.prepare("SELECT id FROM messages WHERE client_id = ?").get(clientId) as Row | undefined;
    return row ? this.message(str(row.id)) : null;
  }

  message(id: string): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no message ${id}`);
    return this.withDeliveries([row])[0]!;
  }

  workById(id: string): Work {
    const row = this.db.prepare("SELECT * FROM work WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no work ${id}`);
    return toWork(row);
  }

  private withDeliveries(rows: Row[]): Message[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => str(r.id));
    const deliveries = this.db
      .prepare(`SELECT * FROM message_deliveries WHERE message_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Row[];
    return rows.map((r) => toMessage(r, deliveries.filter((d) => d.message_id === r.id).map(toDelivery)));
  }
}

function text(value: string | undefined): string {
  const out = value?.trim();
  if (!out) throw new InboxError(400, "the message needs some text");
  if (out.length > MAX_TEXT) throw new InboxError(413, `keep it under ${MAX_TEXT} characters`);
  return out;
}

function teamOf(state: WorldState, id: string): Team {
  const team = state.teams.find((t) => t.id === id);
  if (!team) throw new InboxError(404, `no team ${id}`);
  return team;
}

/**
 * Who hears something said to a team: its lead, who divides the work, or, when the lead is the
 * one speaking, its crew (the running ones, or all of them when none is running).
 */
export function recipients(state: WorldState, team: Team, speaker: string | null): string[] {
  const members = state.agents.filter((a) => a.teamId === team.id && a.id !== speaker);
  const lead = members.find((a) => a.role === "lead");
  if (lead) return [lead.id];
  if (!state.agents.some((a) => a.id === speaker && a.teamId === team.id)) throw new InboxError(409, `nobody is on ${team.name} yet`);
  const running = members.filter((a) => a.paneId);
  const out = (running.length ? running : members).map((a) => a.id);
  if (!out.length) throw new InboxError(409, `${team.name} has no crew yet: start some in herdr (\`inbox team\` shows how)`);
  return out;
}

/** What the agent reads: who it is from, the agent's part in it, the text, and how to answer. */
export function prompt(message: Message, agent: WorldAgent, state: WorldState, work: Work | null): string {
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  const teams = new Map(state.teams.map((t) => [t.id, t]));
  const from = message.fromAgentId ? agents.get(message.fromAgentId) : null;
  const who = (a: WorldAgent | null | undefined) => (a ? `${a.name}${a.teamId && teams.get(a.teamId) ? ` of ${teams.get(a.teamId)!.name}` : ""}` : "someone");
  const team = message.teamId ? teams.get(message.teamId) ?? null : null;
  const ownTeam = agent.teamId ? teams.get(agent.teamId) ?? null : null;
  const purpose = ownTeam?.purpose ? ` The project: ${ownTeam.purpose}` : "";
  const footer = "(From the office. `inbox team` shows your project and who else is here.)";

  switch (message.kind) {
    case "instruction": {
      const others = state.agents.filter((a) => a.teamId === team?.id && a.id !== agent.id);
      const named = others.map((a) => `${a.name}${a.cwd ? ` (${a.cwd})` : ""}`).join(", ");
      const part = team?.standing
        ? `You lead ${team.name}. Divide this among your crew${named ? ` (${named})` : ""} and keep them moving.`
        : `You are the first mate of ${team?.name ?? "the project"}: plan this, give it to your crew${named ? ` (${named})` : ""} or start more in herdr (\`inbox team\` shows how), supervise them, and report the outcome.`;
      return `[From the founder to ${team?.name ?? ""}] ${part}${purpose} Ask in the review inbox if you need a decision.\n\n${message.text}\n\n${footer}`;
    }
    case "message": {
      if (!message.fromAgentId) return `[Message from the founder]\n\n${message.text}\n\nFor a decision you need from the founder, ask in the review inbox (\`inbox decide\`).\n${footer}`;
      const to = team ? ` to ${team.name}` : "";
      return `[Message from ${who(from)}${to}]\n\n${message.text}\n\nAnswer with: inbox say "${from?.name ?? ""}" "…"\n${footer}`;
    }
    case "handoff": {
      const id = work?.id ?? message.workId ?? "";
      const round = work && work.round > 1 ? ` (round ${work.round}, after changes)` : "";
      const others = state.agents.filter((a) => a.teamId === team?.id && a.id !== agent.id).map((a) => a.name);
      const part = agent.role === "lead"
        ? `You lead ${team?.name ?? "your team"}: have it reviewed${others.length ? ` by your crew (${others.join(", ")})` : ""} or review it yourself, then give the verdict.`
        : `Review it with ${others.length ? others.join(", ") : "your team"}; one of you gives the verdict.`;
      return `[Handoff to ${team?.name ?? "your team"} from ${who(from)}] Work ${id}${round}: "${work?.title ?? ""}"\n\n${message.text}\n\n${part}${purpose}\nVerdict: inbox review ${id} accept --notes "…"   or   inbox review ${id} changes --notes "what must change"\n${footer}`;
    }
    case "review": {
      const next = work?.state === "changes_requested" ? `\n\nWhen it is fixed, hand it over again: inbox handoff --work ${work.id} --summary "what changed"` : "";
      return `[Review of your handoff "${work?.title ?? ""}" (work ${work?.id ?? ""}) by ${who(from)}]\n\n${message.text}${next}\n${footer}`;
    }
  }
}

function toMessage(r: Row, deliveries: Delivery[]): Message {
  return {
    id: str(r.id),
    kind: str(r.kind) as MessageKind,
    fromAgentId: opt(r.from_agent_id),
    teamId: opt(r.team_id),
    text: str(r.text),
    workId: opt(r.work_id),
    createdAt: str(r.created_at),
    deliveries,
  };
}

function toDelivery(d: Row): Delivery {
  return { agentId: str(d.agent_id), state: str(d.state) as DeliveryState, error: opt(d.error), updatedAt: str(d.updated_at) };
}

function toWork(r: Row): Work {
  return {
    id: str(r.id),
    title: str(r.title),
    summary: str(r.summary),
    fromAgentId: str(r.from_agent_id),
    fromTeamId: opt(r.from_team_id),
    toTeamId: str(r.to_team_id),
    state: str(r.state) as WorkState,
    round: Number(r.round),
    reviewerId: opt(r.reviewer_id),
    notes: str(r.notes),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}
