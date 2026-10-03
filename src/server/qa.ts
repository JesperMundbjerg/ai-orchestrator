// QA answers: an ordinary office agent, chosen by the founder, decides inbox questions on the founder's behalf.
// The service calls no model and judges nothing: it says which items the QA agent may answer, hands it the
// founder's own answers to learn from, and records its answers as the QA agent's through the ordinary answer path.
// Nothing here ever answers by itself. An item the QA agent has is out of Needs you only while it is online;
// when it is offline or missing, or QA answers are off, the item is the founder's again.
import type { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEARNING_SLUG, QA_NOTICE_PREFIX } from "../shared/qa.ts";
import type { FounderAnswer, InboxState, Item, ItemDetail, Option, QaNext, QaSummary, Reply, ReplyAction, SessionInput } from "../shared/types.ts";
import { Inbox, InboxError } from "./inbox.ts";
import { presentedBy } from "./pipelines/approval.ts";
import { isWaiverItem } from "./pipelines/waiver.ts";

export interface QaAgent { id: string; name: string; online: boolean; taskIds: string[] }

/** What the QA desk needs from the office: who an agent is, whether it runs, and an ordinary office notice. */
export interface QaOffice {
  agent(id: string): QaAgent | null;
  /** The office agent a session is; throws when the office does not know it. */
  resolve(session: SessionInput): QaAgent;
  notice(agentId: string, text: string): void;
}

export interface QaAnswerInput {
  session: SessionInput;
  item: string;
  revision: number;
  action: ReplyAction;
  choice?: string;
  text?: string;
  reason: string;
  learnings?: string[];
}

type Row = Record<string, unknown>;
const DECIDING: ReplyAction[] = ["choose", "answer", "accept", "request_changes"];

export class QaDesk {
  private db: DatabaseSync;
  private inbox: Inbox;
  /** The OKF bundle the QA agent keeps; null in tests that do not look at it. */
  readonly learnings: string | null;
  office: QaOffice | null = null;

  constructor(db: DatabaseSync, inbox: Inbox, learnings: string | null) {
    this.db = db;
    this.inbox = inbox;
    this.learnings = learnings;
  }

  private setting(): { on: boolean; agentId: string | null; through: number } {
    const row = this.db.prepare("SELECT mode, qa_agent_id, qa_learned_through FROM auto_approve WHERE singleton = 1").get()!;
    return { on: row.mode === "qa", agentId: row.qa_agent_id == null ? null : String(row.qa_agent_id), through: Number(row.qa_learned_through) };
  }

  agentId(): string | null {
    return this.setting().agentId;
  }

  choose(agentId: string): void {
    if (this.office && !this.office.agent(agentId)) throw new InboxError(404, `no agent ${agentId} in the office`);
    this.db.prepare("UPDATE auto_approve SET qa_agent_id = ? WHERE singleton = 1").run(agentId);
  }

  /** Why an item stays the founder's own, whatever the QA agent knows; null when it may answer. */
  founderOnly(item: Item, agent: QaAgent): string | null {
    if (presentedBy(this.db, item.id, item.revision)) return "a pipeline's “Founder approves” step needs the founder's own acceptance";
    if (isWaiverItem(this.db, item.id)) return "a repair waiver is the founder's own call";
    if (agent.taskIds.includes(item.taskId)) return "the QA agent never answers its own question";
    return null;
  }

  /** What the QA agent may answer now: needing the founder, unanswered at this revision, not founder-only. Blocking first, then oldest. */
  private open(agent: QaAgent): Item[] {
    const rows = this.db.prepare(`SELECT id FROM items i WHERE state = 'needs_attention'
      AND NOT EXISTS (SELECT 1 FROM replies r WHERE r.item_id = i.id AND r.revision = i.revision)
      ORDER BY blocking DESC, created_at, id`).all() as Row[];
    return rows.map((r) => this.inbox.item(String(r.id))).filter((item) => !this.founderOnly(item, agent));
  }

  /** The QA agent and what it has now, or null when everything is the founder's (off, no agent, offline or unknown). */
  private holding(): { agent: QaAgent; items: Item[] } | null {
    const { on, agentId } = this.setting();
    const agent = on && agentId ? this.office?.agent(agentId) : null;
    return agent?.online ? { agent, items: this.open(agent) } : null;
  }

  /** The inbox as the founder sees it: what the QA agent has is marked, so it leaves Needs you while it has it. */
  mark(state: InboxState): InboxState {
    const ids = new Set(this.holding()?.items.map((i) => i.id));
    return ids.size ? { ...state, items: state.items.map((i) => (ids.has(i.id) ? { ...i, withQa: true } : i)) } : state;
  }

  markDetail(detail: ItemDetail): ItemDetail {
    return this.holding()?.items.some((i) => i.id === detail.item.id) ? { ...detail, withQa: true } : detail;
  }

  summary(): QaSummary | null {
    const { agentId } = this.setting();
    if (!agentId) return null;
    const agent = this.office?.agent(agentId) ?? null;
    const count = (sql: string) => Number(this.db.prepare(sql).get()!.n);
    return {
      agentId, agentName: agent?.name ?? null, online: Boolean(agent?.online), withQa: this.holding()?.items.length ?? 0,
      answered: count("SELECT count(*) AS n FROM replies WHERE answered_by = 'qa_agent'"),
      overridden: count("SELECT count(DISTINCT item_id || ':' || revision) AS n FROM replies WHERE answered_by = 'qa_override'"),
    };
  }

  private toLearn(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'reply.queued' AND actor = 'user' AND id > ?").get(this.setting().through)!.n);
  }

  /** Tell the QA agent there is something for it, at most once until that notice has been typed. Never answers anything. */
  offer(): void {
    const { on, agentId } = this.setting();
    const agent = on && agentId ? this.office?.agent(agentId) : null;
    if (!agent) return;
    const waiting = this.open(agent).length, toLearn = this.toLearn();
    if (!waiting && !toLearn) return;
    const told = this.db.prepare(`SELECT 1 FROM messages m JOIN message_deliveries d ON d.message_id = m.id
      WHERE m.from_office = 1 AND d.agent_id = ? AND d.state IN ('queued', 'sending') AND m.text LIKE ? LIMIT 1`).get(agent.id, `${QA_NOTICE_PREFIX}%`);
    if (told) return;
    // No counts: they would be stale by the time this is typed; \`inbox qa next\` says how many.
    const parts = [waiting ? "questions wait for you to decide for the founder" : "", toLearn ? "founder answers wait for you to learn from" : ""].filter(Boolean);
    this.office!.notice(agent.id, `${QA_NOTICE_PREFIX} ${parts.join(", and ")}. Learn first with \`inbox qa answers\`, then decide with \`inbox qa next\`; \`inbox qa guide\` says how.`);
  }

  /** Only the chosen QA agent's own session; deciding also needs QA answers on. */
  private caller(session: SessionInput, deciding: boolean): QaAgent {
    if (!this.office) throw new InboxError(404, "this service runs without the office, so it has no QA agent");
    const { on, agentId } = this.setting();
    const me = this.office.resolve(session);
    if (me.id !== agentId) {
      const name = agentId ? this.office.agent(agentId)?.name : null;
      throw new InboxError(403, name ? `only the QA agent (${name}) answers for the founder` : "the founder has not chosen a QA agent");
    }
    if (deciding && !on) throw new InboxError(409, "QA answers are off: the founder answers everything now");
    return me;
  }

  next(session: SessionInput): QaNext {
    const agent = this.caller(session, true);
    const items = this.open(agent);
    const first = items[0];
    const task = first ? this.inbox.task(first.taskId) : null;
    const project = task ? String(this.db.prepare("SELECT name FROM projects WHERE id = ?").get(task.projectId)?.name ?? "") : "";
    return {
      item: first && task ? { ...first, project, taskTitle: task.title } : null,
      waiting: items.length, toLearn: this.toLearn(), learnings: this.learnings ?? "",
    };
  }

  answer(input: QaAnswerInput): Reply {
    const agent = this.caller(input.session, true);
    const item = this.inbox.item(input.item);
    const why = this.founderOnly(item, agent);
    if (why) throw new InboxError(409, `this stays with the founder: ${why}`);
    if (input.revision !== item.revision) throw new InboxError(409, `stale: you answered revision ${input.revision}, the item is now at revision ${item.revision}`);
    if (item.state !== "needs_attention" || this.db.prepare("SELECT 1 FROM replies WHERE item_id = ? AND revision = ?").get(item.id, item.revision)) {
      throw new InboxError(409, "this revision is already answered: the founder (or you) answered it first");
    }
    if (!DECIDING.includes(input.action)) throw new InboxError(400, "the QA agent decides: choose an option, answer in words, accept or request changes");
    const reason = input.reason.trim();
    if (!reason) throw new InboxError(400, "give the reason for your decision");
    const words = input.text?.trim() ?? "";
    if ((input.action === "answer" || input.action === "request_changes") && !words) {
      throw new InboxError(400, input.action === "answer" ? "an open question is answered in words" : "say what needs to change");
    }
    const learnings = [...new Set(input.learnings ?? [])];
    for (const slug of learnings) {
      if (!LEARNING_SLUG.test(slug)) throw new InboxError(400, `"${slug}" is not a learning name (lowercase words joined by hyphens)`);
      if (this.learnings && !existsSync(join(this.learnings, `${slug}.md`))) throw new InboxError(400, `no learning "${slug}" in ${this.learnings}`);
    }
    const signed = `QA agent ${agent.name}, for the founder: ${reason}${learnings.length ? ` Learnings: ${learnings.join(", ")}.` : " No learning applied."}`;
    return this.inbox.answer(item.id, {
      id: `qa:${item.id}:${item.revision}`, revision: item.revision, action: input.action,
      choice: input.action === "choose" ? input.choice ?? null : null, text: [words, signed].filter(Boolean).join("\n\n"),
    }, "qa_agent", { qaAgent: { id: agent.id, name: agent.name }, reason, learnings });
  }

  /** The founder's own answers after the QA agent's cursor, oldest first. Approve-all and QA answers are never here. */
  answers(session: SessionInput, limit = 20): { answers: FounderAnswer[]; remaining: number; learnedThrough: number } {
    this.caller(session, false);
    const { through } = this.setting();
    const rows = this.db.prepare(`SELECT e.id AS seq, e.at, r.item_id, r.revision, r.action, r.choice, r.text, r.answered_by,
        i.type, i.title, i.request, i.recommendation, i.options, v.snapshot, p.name AS project
      FROM events e JOIN replies r ON r.id = json_extract(e.detail, '$.deliveryId')
      JOIN items i ON i.id = r.item_id JOIN tasks t ON t.id = i.task_id JOIN projects p ON p.id = t.project_id
      LEFT JOIN item_revisions v ON v.item_id = r.item_id AND v.revision = r.revision
      WHERE e.kind = 'reply.queued' AND e.actor = 'user' AND e.id > ? ORDER BY e.id LIMIT ?`).all(through, Math.max(1, Math.min(limit, 100))) as Row[];
    const answers = rows.map((r): FounderAnswer => {
      // What the founder saw at that revision, not what the item says now.
      const seen = (r.snapshot ? JSON.parse(String(r.snapshot)) : {}) as Partial<{ title: string; request: string; recommendation: string; options: Option[] }>;
      const options = seen.options ?? (JSON.parse(String(r.options)) as Option[]);
      return {
        seq: Number(r.seq), at: String(r.at), itemId: String(r.item_id), revision: Number(r.revision), project: String(r.project),
        itemType: String(r.type) as FounderAnswer["itemType"], title: seen.title ?? String(r.title), request: seen.request ?? String(r.request),
        recommendation: seen.recommendation ?? String(r.recommendation), options, action: String(r.action) as ReplyAction,
        choice: r.choice == null ? null : String(r.choice), choiceLabel: options.find((o) => o.id === r.choice)?.label ?? null,
        text: String(r.text), overrode: r.answered_by === "qa_override" ? this.overridden(String(r.item_id), Number(r.revision)) : null,
      };
    });
    const last = answers.at(-1)?.seq ?? through;
    const remaining = Number(this.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'reply.queued' AND actor = 'user' AND id > ?").get(last)!.n);
    return { answers, remaining, learnedThrough: through };
  }

  private overridden(itemId: string, revision: number): FounderAnswer["overrode"] {
    const row = this.db.prepare(`SELECT r.action, r.choice, e.detail FROM replies r
      JOIN events e ON e.kind = 'reply.queued' AND json_extract(e.detail, '$.deliveryId') = r.id
      WHERE r.item_id = ? AND r.revision = ? AND r.answered_by = 'qa_agent' LIMIT 1`).get(itemId, revision) as Row | undefined;
    if (!row) return null;
    const learnings = (JSON.parse(String(row.detail)) as { learnings?: string[] }).learnings ?? [];
    return { action: String(row.action) as ReplyAction, choice: row.choice == null ? null : String(row.choice), learnings };
  }

  /** The QA agent has learned from the founder's answers up to this one. The cursor only moves forward. */
  learned(session: SessionInput, through: number): { learnedThrough: number } {
    this.caller(session, false);
    const max = Number(this.db.prepare("SELECT coalesce(max(id), 0) AS n FROM events").get()!.n);
    if (!Number.isInteger(through) || through < 0 || through > max) throw new InboxError(400, `--through must be an answer's seq from \`inbox qa answers\``);
    this.db.prepare("UPDATE auto_approve SET qa_learned_through = max(qa_learned_through, ?) WHERE singleton = 1").run(through);
    return { learnedThrough: this.setting().through };
  }

  /** An empty Open Knowledge Format bundle, so the QA agent's first learning has somewhere valid to go. Never overwrites. */
  prepareLearnings(): void {
    if (!this.learnings) return;
    mkdirSync(this.learnings, { recursive: true });
    const index = join(this.learnings, "index.md"), log = join(this.learnings, "log.md");
    if (!existsSync(index)) writeFileSync(index, `---\nokf_version: "0.2"\n---\n# Founder answer learnings\n\nHow the founder has answered review-inbox questions, kept by the office's QA agent: one Markdown file per learning, in Open Knowledge Format v0.2 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md). \`inbox qa guide\` describes a learning.\n`);
    if (!existsSync(log)) writeFileSync(log, "# Log\n");
  }
}
