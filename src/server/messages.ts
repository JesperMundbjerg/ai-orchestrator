// What is said in the office: your instructions to a team, agents' messages to each other and
// their answers to you, finished work handed to another team, and that team's verdict. Every message is stored with
// one delivery row per agent it is meant for. A delivery is typed into the agent's terminal
// only once herdr reports the agent free, one prompt at a time per agent: what queued up while it
// was busy goes in that one prompt, oldest first, each with its sender and age. The
// founder's answer to a review item goes the same way to a session nothing else would hand it to
// while it is idle (no live integration): typed in the words the hook uses.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AllLeadsResult, Delivery, DeliveryState, Message, MessageKind, PendingReply, Team, Work, WorkState, WorldAgent, WorldState } from "../shared/types.ts";
import { formatReply, imageLines } from "../shared/agent-client.ts";
import { imageIds, InboxError, type Inbox } from "./inbox.ts";
import type { Uploads } from "./uploads.ts";
import { laneRecipient } from "./queue.ts";
import { WaitingMessages } from "./waiting.ts";
import { leftBeforeArrival } from "../shared/delivery.ts";
import type { AgentSource } from "./world.ts";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const opt = (v: unknown): string | null => (v == null ? null : String(v));

const MESSAGES_SHOWN = 60;
/** Your conversation with the agents is kept apart from the rest, so it outlasts the office's own talk. */
const WITH_FOUNDER_SHOWN = 200;
/** How agents address you: `inbox say founder "…"`. No agent can be named this. */
export const FOUNDER = "founder";
const REVIEWED_SHOWN = 30;
const MAX_TEXT = 8000;
/** An agent is free for a new prompt when it has finished its turn and is not asking anything. */
const FREE: ReadonlySet<WorldAgent["status"]> = new Set(["idle", "done"]);
/** What queued up while an agent was busy is typed as one prompt; this many at most, the rest in the next. */
const MAX_BATCHED = 50;
/** A combined prompt keeps its newest messages in full up to about this many characters; older ones shrink to a line. */
const BATCH_FULL_CHARS = 6000;
/** How much of an older message its one line keeps. */
const BATCH_LINE_CHARS = 160;
const FOOTER = "(From the office. `inbox team` shows your project and who else is here.)";

export class Messages {
  private db: DatabaseSync;
  private source: AgentSource | null;
  private world: () => WorldState;
  private now: () => Date;
  private changed: () => void;
  /** The inbox's replies waiting for a pane, when the service wires them in. */
  replies: Pick<Inbox, "typeable" | "claimTyping" | "typed"> | null = null;
  /** Where images you attach are stored, when the service wires them in; without it a message carries none. */
  uploads: Uploads | null = null;
  /** Agents a reply is being typed into; like a message being sent, it keeps them busy. */
  private typingTo = new Set<string>();
  private waiting = new WaitingMessages();

  /** Only queued recipients need immediate screen sampling; never scan unrelated panes. */
  queuedPanes(state: WorldState): Set<string> {
    const rows = this.db.prepare("SELECT m.*, d.agent_id, d.updated_at AS queued_at FROM message_deliveries d JOIN messages m ON m.id = d.message_id WHERE d.state = 'queued'").all() as Row[];
    this.waiting.check(rows.map((r) => toMessage(r, [{ agentId: str(r.agent_id), state: "queued", updatedAt: str(r.queued_at), error: null }])), this.now().getTime());
    const ids = new Set(rows.map((r) => str(r.agent_id)));
    return new Set([
      ...state.agents.filter((a) => ids.has(a.id) && a.paneId).map((a) => a.paneId!),
      ...(this.replies?.typeable() ?? []).map((r) => r.paneId),
    ]);
  }

  constructor(db: DatabaseSync, source: AgentSource | null, world: () => WorldState, now: () => Date, changed: () => void) {
    this.db = db;
    this.source = source;
    this.world = world;
    this.now = now;
    this.changed = changed;
    // This service owns all sends. On startup, a persisted claim has no sender left to
    // settle it and must not reserve its agent forever. It may already have been typed:
    // fail visibly, never acknowledge it or requeue it automatically.
    this.db.prepare("UPDATE message_deliveries SET state = 'failed', error = ?, updated_at = ? WHERE state = 'sending'")
      .run("The office restarted: delivery was not confirmed; it may have arrived. Retry may send it twice.", this.now().toISOString());
  }

  /** The latest messages, newest first. */
  list(): Message[] {
    const rows = this.db.prepare(`SELECT *, rowid AS seq FROM messages ORDER BY rowid DESC LIMIT ${MESSAGES_SHOWN}`).all() as Row[];
    return this.withDeliveries(rows);
  }

  /** What you said to agents and they answered you, newest first. */
  withFounder(): Message[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE to_founder = 1 OR (from_agent_id IS NULL AND from_office = 0 AND kind IN ('instruction', 'message')) ORDER BY rowid DESC LIMIT ${WITH_FOUNDER_SHOWN}`)
      .all() as Row[];
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
  instruct(teamId: string, input: { text?: string; images?: string[]; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const state = this.world();
    const team = teamOf(state, teamId);
    const images = this.images(input.images);
    return this.store("instruction", null, team.id, text(input.text, images.length > 0), null, recipients(state, team, null), input.clientId, false, images);
  }

  /** One founder instruction, atomically queued for the selected leads through the usual delivery path. */
  tellAllLeads(input: { text?: string; images?: string[]; clientId?: string; leadIds?: string[] }): AllLeadsResult {
    if (typeof input.clientId !== "string" || !input.clientId.trim()) throw new InboxError(400, "a broadcast needs a client id");
    const state = this.world();
    const repeat = this.byClientId(input.clientId);
    if (repeat && !repeat.allLeads) throw new InboxError(409, "that client id belongs to another message");
    const leads = state.agents.filter((a) => a.role === "lead" && state.teams.some((t) => t.id === a.teamId));
    let message = repeat;
    if (!message) {
      if (input.leadIds !== undefined && (!Array.isArray(input.leadIds) || input.leadIds.some((id) => typeof id !== "string"))) {
        throw new InboxError(400, "leadIds must be a list of lead ids");
      }
      const selected = input.leadIds === undefined ? leads.map((a) => a.id) : [...new Set(input.leadIds)];
      if (!selected.length) throw new InboxError(400, "select at least one lead");
      if (selected.some((id) => !leads.some((a) => a.id === id))) throw new InboxError(409, "the leads have changed; reopen Tell all leads and check the recipients");
      // Resolve teams just as instruct does, but store once so no partial fan-out or duplicate prompt is possible.
      const to = [...new Set(selected.flatMap((id) => {
        const lead = leads.find((a) => a.id === id)!;
        return recipients(state, teamOf(state, lead.teamId!), null);
      }))];
      const images = this.images(input.images);
      message = this.store("instruction", null, null, text(input.text, images.length > 0), null, to, input.clientId, false, images, false, true);
    }
    return {
      message,
      queuedOffline: message.deliveries.filter((d) => d.state === "queued" && !state.agents.find((a) => a.id === d.agentId)?.paneId).map((d) => d.agentId),
      skippedTeams: state.teams.filter((t) => !leads.some((a) => a.teamId === t.id)).map((t) => t.id),
    };
  }

  /** Your message to one agent, typed into its terminal once it is free. */
  tell(agentId: string, input: { text?: string; images?: string[]; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const agent = this.world().agents.find((a) => a.id === agentId);
    if (!agent) throw new InboxError(404, `no agent ${agentId}`);
    const images = this.images(input.images);
    return this.store("message", null, null, text(input.text, images.length > 0), null, [agent.id], input.clientId, false, images);
  }

  /** The office itself telling an agent what it saw, such as a browser left running: typed like any message, never shown as yours. */
  notice(agentId: string, body: string): Message {
    return this.store("message", null, null, text(body), null, [agentId], undefined, false, [], true);
  }

  /** The images you attached, each a stored upload. */
  private images(ids: unknown): string[] {
    if (ids === undefined || ids === null || (Array.isArray(ids) && !ids.length)) return [];
    if (!this.uploads) throw new InboxError(400, "this office takes no images");
    return this.uploads.check(ids);
  }

  /** One agent to another agent or a team, named as the office shows it, or its answer to you. */
  say(from: WorldAgent, input: { to?: string; text?: string; clientId?: string }): Message {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return repeat;
    const body = text(input.text);
    const name = input.to?.trim().toLowerCase();
    if (!name) throw new InboxError(400, "say who the message is for: an agent's name or a team's");
    // Shown to you in the office; it is not a question for the inbox and nobody's terminal gets it.
    if (name === FOUNDER) return this.store("message", from.id, null, body, null, [], input.clientId, true);
    const state = this.world();
    const agent = state.agents.find((a) => a.name.toLowerCase() === name);
    if (agent) {
      if (agent.id === from.id) throw new InboxError(400, "that is you");
      return this.store("message", from.id, null, body, null, [agent.id], input.clientId);
    }
    const team = state.teams.find((t) => t.name.toLowerCase() === name);
    if (team) return this.store("message", from.id, team.id, body, null, recipients(state, team, from.id), input.clientId);
    // A project's lane by the name its own tools use: `inbox say einstein`.
    const lane = laneRecipient(state, from, name);
    if (!lane) throw new InboxError(404, `nobody called ${input.to} in the office: see who is there with \`inbox team\``);
    if (lane.id === from.id) throw new InboxError(400, "that is you");
    return this.store("message", from.id, null, body, null, [lane.id], input.clientId);
  }

  /**
   * Finished work passed to a team to review: the team named, or the one the sender's team hands
   * its work to. Handing over the same work again after changes starts its next round.
   */
  handoff(from: WorldAgent, input: { title?: string; summary?: string; to?: string; work?: string; clientId?: string }): { work: Work; message: Message } {
    const repeat = this.byClientId(input.clientId);
    if (repeat) return { work: this.workById(repeat.workId!), message: repeat };
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
    const delivery = this.message(messageId).deliveries.find((d) => d.agentId === agentId);
    const agent = this.world().agents.find((a) => a.id === agentId);
    if (!agent?.paneId || (delivery && leftBeforeArrival(delivery, agent))) throw new InboxError(409, "the agent left before it arrived; this delivery cannot be retried");
    const done = this.db
      .prepare("UPDATE message_deliveries SET state = 'queued', error = NULL, updated_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'failed'")
      .run(this.now().toISOString(), messageId, agentId);
    if (!done.changes) throw new InboxError(409, "only a failed delivery can be retried");
    this.changed();
    return this.message(messageId);
  }

  /**
   * Types what waits for every agent that has become free, one prompt per agent: the founder's
   * answer to something it asked first, on its own, then the messages that queued up, together,
   * oldest first.
   */
  async deliver(state: WorldState): Promise<void> {
    const agents = new Map(state.agents.map((a) => [a.id, a]));
    const pending = this.db
      .prepare("SELECT d.agent_id, d.state, m.* FROM message_deliveries d JOIN messages m ON m.id = d.message_id WHERE d.state IN ('queued', 'sending') ORDER BY m.rowid")
      .all() as Row[];
    const busy = new Set<string>(this.typingTo);
    const queued = new Map<string, Row[]>();
    for (const row of pending) {
      const agentId = str(row.agent_id);
      if (row.state === "sending") busy.add(agentId);
      else queued.set(agentId, [...(queued.get(agentId) ?? []), row]);
    }
    const sends: Array<Promise<void>> = [];
    for (const { paneId, reply } of this.replies?.typeable() ?? []) {
      const agent = state.agents.find((a) => a.paneId === paneId);
      if (!agent || busy.has(agent.id)) continue;
      busy.add(agent.id);
      if (FREE.has(agent.status)) sends.push(this.typeReply(reply, agent));
    }
    for (const [agentId, rows] of queued) {
      if (busy.has(agentId)) continue;
      busy.add(agentId);
      const agent = agents.get(agentId);
      if (agent?.paneId && FREE.has(agent.status)) sends.push(this.send(rows.slice(0, MAX_BATCHED), agent, state));
    }
    await Promise.all(sends);
  }

  /** The founder's answer, typed as the hook would hand it over, and acknowledged only once herdr sees the agent take it up. */
  private async typeReply(reply: PendingReply, agent: WorldAgent): Promise<void> {
    if (!this.source || !this.replies!.claimTyping(reply.deliveryId)) return;
    this.typingTo.add(agent.id);
    let error: string | undefined;
    try {
      await this.source.prompt(agent.paneId!, formatReply(reply));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.typingTo.delete(agent.id);
    }
    this.replies!.typed(reply.deliveryId, error);
  }

  /** One prompt for everything that waited, acknowledged for all of it or failed for all of it. */
  private async send(rows: Row[], agent: WorldAgent, state: WorldState): Promise<void> {
    if (!this.source) return;
    // Claimed before typing, so two deliveries running at once never type the same message twice.
    const claim = this.db.prepare("UPDATE message_deliveries SET state = 'sending', updated_at = ? WHERE message_id = ? AND agent_id = ? AND state = 'queued'");
    const messages = rows.filter((row) => claim.run(this.now().toISOString(), str(row.id), agent.id).changes > 0).map((row) => toMessage(row, []));
    if (!messages.length) return;
    this.changed();
    let error: string | null = null;
    try {
      await this.source.prompt(agent.paneId!, this.combined(messages, agent, state));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const done = this.db.prepare("UPDATE message_deliveries SET state = ?, error = ?, updated_at = ? WHERE message_id = ? AND agent_id = ?");
    for (const message of messages) done.run(error ? "failed" : "delivered", error, this.now().toISOString(), message.id, agent.id);
    this.changed();
  }

  /** What one prompt says: a single message as it is, several as one list with who sent each and how long ago. */
  private combined(messages: Message[], agent: WorldAgent, state: WorldState): string {
    const at = this.now().getTime();
    const entries = messages.map((message) => {
      const images = message.images.map((id) => join(this.uploads?.dir ?? "", id));
      const work = message.workId ? this.workById(message.workId) : null;
      const sender = message.fromAgentId ? state.agents.find((a) => a.id === message.fromAgentId)?.name ?? "someone" : message.fromOffice ? "The office" : "The founder";
      return { label: `${sender}, ${ago(at - Date.parse(message.createdAt))}`, message, images, work };
    });
    if (entries.length === 1) {
      const { message, images, work } = entries[0]!;
      return prompt(message, agent, state, work, images);
    }
    // The newest are kept in full while there is room; older ones shrink to a line, so a long queue stays one readable prompt.
    let room = BATCH_FULL_CHARS;
    const parts: string[] = [];
    for (const entry of entries.reverse()) {
      const full = `${entry.label}:\n${compose(entry.message, agent, state, entry.work, entry.images)}`;
      if (!parts.length || full.length <= room) {
        parts.push(full);
        room -= full.length;
        continue;
      }
      room = 0;
      const said = entry.message.text.replace(/\s+/g, " ").trim();
      const line = said.length > BATCH_LINE_CHARS ? `${said.slice(0, BATCH_LINE_CHARS).trimEnd()}…` : said;
      parts.push([`${entry.label}: ${line}`, ...entry.images.map((path) => `Image: ${path}`)].join(" "));
    }
    const header = `${entries.length} messages arrived while you were busy; later ones may supersede earlier ones. Reply once to what still matters.`;
    return `${header}\n\n${parts.reverse().join("\n\n")}\n${FOOTER}`;
  }

  private store(kind: MessageKind, fromAgentId: string | null, teamId: string | null, body: string, workId: string | null, to: string[], clientId?: string, toFounder = false, images: string[] = [], fromOffice = false, allLeads = false): Message {
    const id = randomUUID();
    const at = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO messages (id, kind, from_agent_id, team_id, text, work_id, client_id, created_at, to_founder, images, from_office, all_leads) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, kind, fromAgentId, teamId, body, workId, clientId ?? null, at, toFounder ? 1 : 0, images.length ? JSON.stringify(images) : null, fromOffice ? 1 : 0, allLeads ? 1 : 0);
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

/** A message's text; one that carries images may say nothing else. */
function text(value: string | undefined, withImages = false): string {
  const out = value?.trim() ?? "";
  if (!out && !withImages) throw new InboxError(400, "the message needs some text");
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

/** What the agent reads: who it is from, the agent's part in it, the text (with the paths of any images), and how to answer. */
export function prompt(message: Message, agent: WorldAgent, state: WorldState, work: Work | null, images: string[] = []): string {
  return `${compose(message, agent, state, work, images)}\n${FOOTER}`;
}

/** How long ago, in the words an agent reads: "just now", "42 min ago", "3 h ago", "2 days ago". */
function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} days ago`;
}

/** A message as the agent reads it, without the footer that closes a prompt. */
function compose(message: Message, agent: WorldAgent, state: WorldState, work: Work | null, images: string[]): string {
  const agents = new Map(state.agents.map((a) => [a.id, a]));
  const teams = new Map(state.teams.map((t) => [t.id, t]));
  const from = message.fromAgentId ? agents.get(message.fromAgentId) : null;
  const who = (a: WorldAgent | null | undefined) => (a ? `${a.name}${a.teamId && teams.get(a.teamId) ? ` of ${teams.get(a.teamId)!.name}` : ""}` : "someone");
  const teamId = message.allLeads ? agent.teamId : message.teamId;
  const team = teamId ? teams.get(teamId) ?? null : null;
  const ownTeam = agent.teamId ? teams.get(agent.teamId) ?? null : null;
  const purpose = ownTeam?.purpose ? ` The project: ${ownTeam.purpose}` : "";
  const said = [message.text, imageLines(images)].filter(Boolean).join("\n\n");
  const answerFounder = `Answer the founder in one or two sentences: inbox say ${FOUNDER} "…". When the job is done or something new happens (a crew member finishes, say), follow up the same way. For a decision, use the review inbox (\`inbox decide\`); to show what you changed, add the pages to step through (\`--page "Label=URL"\`, repeated).`;

  switch (message.kind) {
    case "instruction": {
      const others = state.agents.filter((a) => a.teamId === team?.id && a.id !== agent.id);
      const named = others.map((a) => `${a.name}${a.cwd ? ` (${a.cwd})` : ""}`).join(", ");
      const part = team?.standing
        ? `You lead ${team.name}. Divide this among your crew${named ? ` (${named})` : ""} and keep them moving.`
        : `You are the first mate of ${team?.name ?? "the project"}: plan this, give it to your crew${named ? ` (${named})` : ""} or start more in herdr (\`inbox team\` shows how), supervise them, and report the outcome.`;
      return `[From the founder to ${team?.name ?? ""}${message.allLeads ? "; broadcast to selected leads" : ""}] ${part}${purpose}\n\n${said}\n\n${answerFounder}`;
    }
    case "message": {
      if (message.fromOffice) return `[From the office]\n\n${said}`;
      if (!message.fromAgentId) return `[Message from the founder]\n\n${said}\n\n${answerFounder}`;
      const to = team ? ` to ${team.name}` : "";
      return `[Message from ${who(from)}${to}]\n\n${message.text}\n\nAnswer with: inbox say "${from?.name ?? ""}" "…"`;
    }
    case "handoff": {
      const id = work?.id ?? message.workId ?? "";
      const round = work && work.round > 1 ? ` (round ${work.round}, after changes)` : "";
      const others = state.agents.filter((a) => a.teamId === team?.id && a.id !== agent.id).map((a) => a.name);
      const part = agent.role === "lead"
        ? `You lead ${team?.name ?? "your team"}: have it reviewed${others.length ? ` by your crew (${others.join(", ")})` : ""} or review it yourself, then give the verdict.`
        : `Review it with ${others.length ? others.join(", ") : "your team"}; one of you gives the verdict.`;
      return `[Handoff to ${team?.name ?? "your team"} from ${who(from)}] Work ${id}${round}: "${work?.title ?? ""}"\n\n${message.text}\n\n${part}${purpose}\nVerdict: inbox review ${id} accept --notes "…"   or   inbox review ${id} changes --notes "what must change"`;
    }
    case "review": {
      const next = work?.state === "changes_requested" ? `\n\nWhen it is fixed, hand it over again: inbox handoff --work ${work.id} --summary "what changed"` : "";
      return `[Review of your handoff "${work?.title ?? ""}" (work ${work?.id ?? ""}) by ${who(from)}]\n\n${message.text}${next}`;
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
    images: imageIds(r.images),
    workId: opt(r.work_id),
    createdAt: str(r.created_at),
    deliveries,
    toFounder: Number(r.to_founder) === 1,
    fromOffice: Number(r.from_office) === 1,
    allLeads: Number(r.all_leads) === 1,
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
