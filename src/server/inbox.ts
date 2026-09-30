// The inbox's domain: projects, tasks bound to agent sessions, review items with revisions,
// evidence, replies and their delivery. Every mutation records a history event and notifies
// `onChange`; nothing here knows about HTTP.

import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  HARNESSES, ITEM_TYPES, REPLY_ACTIONS,
  type ActivityInput, type Binding, type Capabilities, type Evidence, type EvidenceInput, type Harness,
  type HistoryEvent, type InboxState, type Item, type ItemDetail, type ItemSummary, type Option,
  type PendingReply, type Presence, type Page, type Preview, type Project, type Reply, type ReplyAction,
  type SessionInput, type SubmitInput, type SubmitResult, type Task,
} from "../shared/types.ts";
import { MAX_PAGES, pageUrlProblem, parsePage } from "../shared/pages.ts";

/** Live session facts from a terminal multiplexer (herdr); absent sessions simply have none. */
export interface PresenceSource {
  available(): boolean;
  forSession(harness: Harness, sessionId: string): Presence | null;
  resolvePane(paneId: string): { harness: Harness; sessionId: string; cwd: string | null } | null;
}

export class InboxError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A listener that polled within this window counts as live. */
const LISTENER_FRESH_MS = 15_000;
/** A reply picked up but not acknowledged within this window is shown as uncertain. */
export const ACK_GRACE_MS = 30_000;

const ATTACHABLE: Record<string, Evidence["kind"]> = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
  ".pdf": "document", ".md": "document", ".txt": "document",
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const nullable = (v: unknown): string | null => (v == null ? null : String(v));

export class Inbox {
  private db: DatabaseSync;
  private filesDir: string;
  private presence: PresenceSource;
  private now: () => Date;
  /** Replies being typed into a pane right now (kept in memory: a restart mid-typing leaves the reply claimed, shown as uncertain). */
  private typing = new Set<string>();
  onChange: (reason: string) => void = () => {};

  constructor(db: DatabaseSync, filesDir: string, presence: PresenceSource, now: () => Date = () => new Date()) {
    this.db = db;
    this.filesDir = filesDir;
    this.presence = presence;
    this.now = now;
    mkdirSync(filesDir, { recursive: true });
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private log(actor: HistoryEvent["actor"], kind: string, ids: { taskId?: string | null; itemId?: string | null }, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare("INSERT INTO events (at, actor, task_id, item_id, kind, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.iso(), actor, ids.taskId ?? null, ids.itemId ?? null, kind, JSON.stringify(detail));
  }

  // ── Sessions, projects, tasks ─────────────────────────────────────────────────────────

  /** A stable session identity from what the caller knows: named directly, or via its pane. */
  resolveSession(input: SessionInput): Binding {
    if (input.harness && input.sessionId) {
      if (!HARNESSES.includes(input.harness)) throw new InboxError(400, `unknown harness "${input.harness}"`);
      return { harness: input.harness, sessionId: input.sessionId, cwd: input.cwd ?? null };
    }
    if (input.paneId) {
      const found = this.presence.resolvePane(input.paneId);
      if (found) return { ...found, cwd: input.cwd ?? found.cwd };
      throw new InboxError(409, `herdr pane ${input.paneId} has no agent session to bind to`);
    }
    throw new InboxError(400, "cannot identify the agent session: pass harness and sessionId, or run inside a herdr pane");
  }

  private upsertProject(input: SubmitInput["project"], cwd: string | null): string {
    const root = input?.root ?? cwd;
    const existing = root ? (this.db.prepare("SELECT id, objective FROM projects WHERE root = ?").get(root) as Row | undefined) : undefined;
    if (existing) {
      if (input?.objective && !existing.objective) {
        this.db.prepare("UPDATE projects SET objective = ? WHERE id = ?").run(input.objective, str(existing.id));
      }
      return str(existing.id);
    }
    const id = randomUUID();
    const name = input?.name ?? (root ? basename(root) : "Unsorted");
    this.db
      .prepare("INSERT INTO projects (id, name, root, objective, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, root, input?.objective ?? "", this.iso());
    this.log("agent", "project.registered", {}, { projectId: id, name });
    return id;
  }

  private taskRow(binding: Binding): Row | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE harness = ? AND session_id = ?").get(binding.harness, binding.sessionId) as Row | undefined;
  }

  private upsertTask(binding: Binding, project: SubmitInput["project"], task: SubmitInput["task"], fallbackTitle: string): string {
    const now = this.iso();
    const existing = this.taskRow(binding);
    if (existing) {
      const id = str(existing.id);
      if (task?.title || task?.objective || binding.cwd) {
        this.db
          .prepare("UPDATE tasks SET title = coalesce(?, title), objective = coalesce(?, objective), cwd = coalesce(?, cwd), updated_at = ? WHERE id = ?")
          .run(task?.title ?? null, task?.objective ?? null, binding.cwd, now, id);
      }
      return id;
    }
    const projectId = this.upsertProject(project, binding.cwd);
    const id = randomUUID();
    const title = task?.title ?? this.presence.forSession(binding.harness, binding.sessionId)?.name ?? fallbackTitle;
    this.db
      .prepare(`INSERT INTO tasks (id, project_id, title, objective, harness, session_id, cwd, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, title, task?.objective ?? "", binding.harness, binding.sessionId, binding.cwd, now, now);
    this.log("agent", "task.bound", { taskId: id }, { harness: binding.harness, sessionId: binding.sessionId });
    return id;
  }

  // ── Agent protocol ────────────────────────────────────────────────────────────────────

  submit(input: SubmitInput): SubmitResult {
    const raw = input?.item;
    if (!raw || !ITEM_TYPES.includes(raw.type)) throw new InboxError(400, `item.type must be one of ${ITEM_TYPES.join(", ")}`);
    if (!raw.title?.trim()) throw new InboxError(400, "item.title is required");
    const binding = this.resolveSession(input.session ?? {});
    const fields = normalizeItem(raw);
    if (raw.type === "decide" && fields.options.length < 2) throw new InboxError(400, "a decision needs at least two options");
    if (raw.type === "try" && !fields.preview) throw new InboxError(400, "a try-it request needs a preview url or pages");
    const attachments = (raw.evidence ?? []).map((e) => this.prepareEvidence(e));
    const hash = sha256(JSON.stringify([fields, attachments.map((a) => [a.kind, a.sha256 ?? a.url, a.caption])]));

    const result = this.tx(() => {
      const taskId = this.upsertTask(binding, input.project, input.task, raw.title.trim());
      const key = raw.key?.trim() || slug(raw.title);
      const now = this.iso();
      const existing = this.db.prepare("SELECT * FROM items WHERE task_id = ? AND key = ?").get(taskId, key) as Row | undefined;
      if (existing && str(existing.content_hash) === hash && str(existing.state) !== "withdrawn") {
        return { itemId: str(existing.id), taskId, revision: Number(existing.revision), changed: false };
      }
      const itemId = existing ? str(existing.id) : randomUUID();
      const revision = existing ? Number(existing.revision) + 1 : 1;
      const values = [fields.type, revision, fields.title, fields.request, fields.context, fields.recommendation,
        JSON.stringify(fields.options), fields.check, fields.preview ? JSON.stringify(fields.preview) : null,
        fields.pages.length ? JSON.stringify(fields.pages) : null, fields.blocking ? 1 : 0, hash] as const;
      if (existing) {
        this.db
          .prepare(`UPDATE items SET type = ?, revision = ?, title = ?, request = ?, context = ?, recommendation = ?, options = ?,
                    check_text = ?, preview = ?, pages = ?, blocking = ?, content_hash = ?, state = 'needs_attention', snoozed_until = NULL,
                    updated_at = ? WHERE id = ?`)
          .run(...values, now, itemId);
        // An answer written for the previous revision must not be applied to the changed item.
        const staled = this.db.prepare("UPDATE replies SET state = 'stale' WHERE item_id = ? AND state IN ('queued', 'failed')").run(itemId);
        this.log("agent", "item.revised", { taskId, itemId }, { revision, staleReplies: Number(staled.changes) });
      } else {
        this.db
          .prepare(`INSERT INTO items (type, revision, title, request, context, recommendation, options, check_text, preview, pages, blocking,
                    content_hash, id, task_id, key, state, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_attention', ?, ?)`)
          .run(...values, itemId, taskId, key, now, now);
        this.log("agent", "item.submitted", { taskId, itemId }, { type: fields.type, title: fields.title });
      }
      this.db
        .prepare("INSERT INTO item_revisions (item_id, revision, snapshot, created_at) VALUES (?, ?, ?, ?)")
        .run(itemId, revision, JSON.stringify(fields), now);
      for (const a of attachments) {
        this.db
          .prepare(`INSERT INTO evidence (id, item_id, revision, kind, file, url, sha256, caption, source_revision, captured_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(a.id, itemId, revision, a.kind, a.file, a.url, a.sha256, a.caption, a.sourceRevision, now);
      }
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, taskId);
      return { itemId, taskId, revision, changed: true };
    });
    if (result.changed) this.onChange("item");
    return result;
  }

  /** Copies an explicitly attached file into the inbox's storage; nothing else is read. */
  private prepareEvidence(e: EvidenceInput): { id: string; kind: Evidence["kind"]; file: string | null; url: string | null; sha256: string | null; caption: string; sourceRevision: string } {
    const id = randomUUID();
    const caption = e.caption?.trim() ?? "";
    const sourceRevision = e.sourceRevision?.trim() ?? "";
    if (e.url) {
      if (!/^https?:\/\//i.test(e.url)) throw new InboxError(400, `evidence url must be http(s): ${e.url}`);
      return { id, kind: e.kind ?? "url", file: null, url: e.url, sha256: null, caption, sourceRevision };
    }
    if (!e.path) throw new InboxError(400, "evidence needs a path or a url");
    const ext = extname(e.path).toLowerCase();
    const kind = ATTACHABLE[ext];
    if (!kind || basename(e.path).startsWith(".")) throw new InboxError(400, `cannot attach ${basename(e.path)}: only images, PDFs, Markdown and text files`);
    let stat;
    try {
      stat = lstatSync(e.path);
    } catch {
      throw new InboxError(400, `evidence file not found: ${e.path}`);
    }
    if (!stat.isFile()) throw new InboxError(400, `evidence is not a regular file: ${e.path}`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new InboxError(400, `evidence file is larger than 20 MB: ${e.path}`);
    const file = `${id}${ext}`;
    copyFileSync(e.path, join(this.filesDir, file));
    return { id, kind, file, url: null, sha256: sha256(readFileSync(join(this.filesDir, file))), caption, sourceRevision };
  }

  activity(input: ActivityInput): Task {
    const binding = this.resolveSession(input.session ?? {});
    const row = this.taskRow(binding);
    if (!row) throw new InboxError(404, "this session has no task yet; submit a review item first");
    const id = str(row.id);
    this.db
      .prepare("UPDATE tasks SET activity = coalesce(?, activity), next_milestone = coalesce(?, next_milestone), title = coalesce(?, title), updated_at = ? WHERE id = ?")
      .run(input.activity ?? null, input.nextMilestone ?? null, input.title ?? null, this.iso(), id);
    this.log("agent", "task.activity", { taskId: id }, { activity: input.activity, nextMilestone: input.nextMilestone });
    this.onChange("task");
    return this.task(id);
  }

  /**
   * Replies waiting for a session. `live` and `boundary` record how the session collects them,
   * which is what the UI reports as its reply route.
   */
  pendingReplies(session: SessionInput, mode: "live" | "boundary" | "pull"): PendingReply[] {
    const binding = this.resolveSession(session);
    const task = this.taskRow(binding);
    if (!task) return [];
    const now = this.iso();
    if (mode !== "pull") {
      const column = mode === "live" ? "listener_seen_at" : "boundary_seen_at";
      const wasLive = mode === "live" && isFresh(nullable(task.listener_seen_at), this.now());
      this.db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(now, str(task.id));
      if (mode === "live" && !wasLive) this.onChange("task");
    }
    const rows = this.db
      .prepare(`SELECT r.*, i.key, i.title AS item_title, i.type AS item_type, i.options
                FROM replies r JOIN items i ON i.id = r.item_id
                WHERE i.task_id = ? AND r.state = 'queued' ORDER BY r.created_at`)
      .all(str(task.id)) as Row[];
    // A reply the office is typing into the session's pane is on its way; handing it over too would say it twice.
    const out = rows.filter((r) => !this.typing.has(str(r.id)));
    if (out.length) {
      this.db.prepare(`UPDATE replies SET claimed_at = coalesce(claimed_at, ?) WHERE id IN (${out.map(() => "?").join(",")})`).run(now, ...out.map((r) => str(r.id)));
    }
    return out.map(toPending);
  }

  /**
   * Replies the office may type into a session's herdr pane, oldest first: queued and never
   * collected, for a session with no live integration (a hook hands replies over only at a turn
   * boundary, which an idle agent never reaches). Whether the agent is free is for the typist to check.
   */
  typeable(): Array<{ paneId: string; reply: PendingReply }> {
    const rows = this.db
      .prepare(`SELECT r.*, i.key, i.title AS item_title, i.type AS item_type, i.options, t.harness, t.session_id, t.listener_seen_at
                FROM replies r JOIN items i ON i.id = r.item_id JOIN tasks t ON t.id = i.task_id
                WHERE r.state = 'queued' AND r.claimed_at IS NULL ORDER BY r.created_at`)
      .all() as Row[];
    return rows.flatMap((r) => {
      if (isFresh(nullable(r.listener_seen_at), this.now())) return [];
      const presence = this.presence.forSession(str(r.harness) as Harness, str(r.session_id));
      return presence ? [{ paneId: presence.paneId, reply: toPending(r) }] : [];
    });
  }

  /** Claims a reply for typing, so it is typed once and no hook or pull hands it over meanwhile. */
  claimTyping(deliveryId: string): boolean {
    const claimed = this.db.prepare("UPDATE replies SET claimed_at = ? WHERE id = ? AND state = 'queued' AND claimed_at IS NULL").run(this.iso(), deliveryId);
    if (!claimed.changes) return false;
    this.typing.add(deliveryId);
    return true;
  }

  /**
   * The office typed a claimed reply into the session's pane (herdr saw the agent take it up), or
   * could not. It settles like an integration's ack; a reply that changed meanwhile (overtaken by a
   * new revision) is left as it is.
   */
  typed(deliveryId: string, error?: string): void {
    this.typing.delete(deliveryId);
    const row = this.db.prepare("SELECT r.*, i.task_id FROM replies r JOIN items i ON i.id = r.item_id WHERE r.id = ?").get(deliveryId) as Row | undefined;
    if (!row || str(row.state) !== "queued") return;
    this.settle(row, error, "system", { via: "pane" });
    this.onChange("reply");
  }

  /** The owning session confirms a reply reached it (or reports that it could not take it). */
  acknowledge(session: SessionInput, deliveryId: string, error?: string): Reply {
    const binding = this.resolveSession(session);
    const row = this.db
      .prepare(`SELECT r.*, i.task_id FROM replies r JOIN items i ON i.id = r.item_id JOIN tasks t ON t.id = i.task_id
                WHERE r.id = ? AND t.harness = ? AND t.session_id = ?`)
      .get(deliveryId, binding.harness, binding.sessionId) as Row | undefined;
    if (!row) throw new InboxError(404, `no reply ${deliveryId} for this session`);
    if (str(row.state) === "delivered") return this.reply(deliveryId);
    if (str(row.state) !== "queued") throw new InboxError(409, `reply ${deliveryId} is ${str(row.state)}, not queued`);
    this.settle(row, error, "agent");
    this.onChange("reply");
    return this.reply(deliveryId);
  }

  /** A queued reply reached its session, or could not: a failed one returns its item to Needs you, with Retry. */
  private settle(row: Row, error: string | undefined, actor: HistoryEvent["actor"], detail: Record<string, unknown> = {}): void {
    const deliveryId = str(row.id);
    const itemId = str(row.item_id);
    this.tx(() => {
      if (error) {
        this.db.prepare("UPDATE replies SET state = 'failed', error = ?, claimed_at = NULL WHERE id = ?").run(error, deliveryId);
        this.db.prepare("UPDATE items SET state = 'needs_attention', updated_at = ? WHERE id = ?").run(this.iso(), itemId);
        this.log(actor, "reply.failed", { taskId: str(row.task_id), itemId }, { deliveryId, error, ...detail });
      } else {
        this.db.prepare("UPDATE replies SET state = 'delivered', delivered_at = ? WHERE id = ?").run(this.iso(), deliveryId);
        const waiting = this.db.prepare("SELECT count(*) AS n FROM replies WHERE item_id = ? AND state = 'queued'").get(itemId) as Row;
        if (Number(waiting.n) === 0) {
          this.db.prepare("UPDATE items SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'answer_queued'").run(this.iso(), itemId);
        }
        this.log(actor, "reply.delivered", { taskId: str(row.task_id), itemId }, { deliveryId, ...detail });
      }
    });
  }

  /** The agent withdraws a request that no longer applies, or resolves one it has acted on. */
  closeItem(session: SessionInput, itemRef: string, outcome: "withdrawn" | "resolved"): Item {
    const binding = this.resolveSession(session);
    const task = this.taskRow(binding);
    const row = task
      ? (this.db.prepare("SELECT id FROM items WHERE task_id = ? AND (id = ? OR key = ?)").get(str(task.id), itemRef, itemRef) as Row | undefined)
      : undefined;
    if (!row) throw new InboxError(404, `no item "${itemRef}" for this session`);
    return this.setItemState(str(row.id), outcome, "agent");
  }

  // ── User actions ──────────────────────────────────────────────────────────────────────

  answer(itemId: string, input: { id?: string; revision: number; action: ReplyAction; choice?: string | null; text?: string }): Reply {
    const deliveryId = input.id ?? randomUUID();
    const prior = this.db.prepare("SELECT id FROM replies WHERE id = ?").get(deliveryId) as Row | undefined;
    if (prior) return this.reply(deliveryId); // a retried request, not a second answer
    const item = this.item(itemId);
    if (item.state === "withdrawn" || item.state === "resolved") throw new InboxError(409, `this item is ${item.state}`);
    if (input.revision !== item.revision) {
      throw new InboxError(409, `stale: you answered revision ${input.revision}, the item is now at revision ${item.revision}`);
    }
    if (!REPLY_ACTIONS.includes(input.action)) throw new InboxError(400, `unknown action "${input.action}"`);
    const allowed: Record<ReplyAction, Item["type"][]> = {
      choose: ["decide"], accept: ["milestone"], request_changes: ["milestone"], tried: ["try"], discuss: ["decide", "try", "milestone"],
    };
    if (!allowed[input.action].includes(item.type)) throw new InboxError(400, `"${input.action}" does not answer a ${item.type} item`);
    const text = input.text?.trim() ?? "";
    const choice = input.action === "choose" ? input.choice ?? null : null;
    const option = choice ? item.options.find((o) => o.id === choice) : undefined;
    if (input.action === "choose" && !option) throw new InboxError(400, "choose needs one of the item's options");
    if ((input.action === "discuss" || input.action === "request_changes") && !text) throw new InboxError(400, "write what you want to say");

    const task = this.task(item.taskId);
    this.tx(() => {
      const now = this.iso();
      this.db
        .prepare("INSERT INTO replies (id, item_id, revision, action, choice, text, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)")
        .run(deliveryId, itemId, item.revision, input.action, choice, text, now);
      this.db.prepare("UPDATE items SET state = 'answer_queued', snoozed_until = NULL, updated_at = ? WHERE id = ?").run(now, itemId);
      if (option) this.db.prepare("UPDATE tasks SET last_decision = ? WHERE id = ?").run(`${option.label} (${item.title})`, task.id);
      if (input.action === "accept") this.db.prepare("UPDATE tasks SET last_accepted_milestone = ? WHERE id = ?").run(item.title, task.id);
      this.log("user", "reply.queued", { taskId: task.id, itemId }, { deliveryId, action: input.action, choice });
    });
    this.onChange("reply");
    return this.reply(deliveryId);
  }

  /** A failed reply goes back into the outbox under the same delivery id. */
  retry(deliveryId: string): Reply {
    const reply = this.reply(deliveryId);
    if (reply.state !== "failed") throw new InboxError(409, `only a failed reply can be retried; this one is ${reply.state}`);
    const item = this.item(reply.itemId);
    if (reply.revision !== item.revision) throw new InboxError(409, "stale: the item changed since this answer");
    this.tx(() => {
      this.db.prepare("UPDATE replies SET state = 'queued', error = NULL, claimed_at = NULL WHERE id = ?").run(deliveryId);
      this.db.prepare("UPDATE items SET state = 'answer_queued', updated_at = ? WHERE id = ?").run(this.iso(), item.id);
      this.log("user", "reply.retried", { taskId: item.taskId, itemId: item.id }, { deliveryId });
    });
    this.onChange("reply");
    return this.reply(deliveryId);
  }

  snooze(itemId: string, until: string): Item {
    const at = new Date(until);
    if (Number.isNaN(at.getTime()) || at <= this.now()) throw new InboxError(400, "snooze needs a future time");
    const item = this.item(itemId);
    if (item.state !== "needs_attention") throw new InboxError(409, `only an item that needs you can be snoozed; this one is ${item.state}`);
    this.db.prepare("UPDATE items SET state = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?").run(at.toISOString(), this.iso(), itemId);
    this.log("user", "item.snoozed", { taskId: item.taskId, itemId }, { until: at.toISOString() });
    this.onChange("item");
    return this.item(itemId);
  }

  /** The user marks an item handled. It says nothing about the task being finished. */
  resolve(itemId: string): Item {
    return this.setItemState(itemId, "resolved", "user");
  }

  private setItemState(itemId: string, state: "resolved" | "withdrawn" | "needs_attention", actor: HistoryEvent["actor"]): Item {
    const item = this.item(itemId);
    this.tx(() => {
      this.db.prepare("UPDATE items SET state = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?").run(state, this.iso(), itemId);
      if (state !== "needs_attention") {
        this.db.prepare("UPDATE replies SET state = 'stale' WHERE item_id = ? AND state IN ('queued', 'failed')").run(itemId);
      }
      this.log(actor, `item.${state === "needs_attention" ? "woke" : state}`, { taskId: item.taskId, itemId });
    });
    this.onChange("item");
    return this.item(itemId);
  }

  /** Snoozed items whose time has come need attention again. */
  wakeDue(): number {
    const due = this.db.prepare("SELECT id FROM items WHERE state = 'snoozed' AND snoozed_until <= ?").all(this.iso()) as Row[];
    for (const row of due) this.setItemState(str(row.id), "needs_attention", "system");
    return due.length;
  }

  updateTask(taskId: string, patch: Partial<Pick<Task, "title" | "objective" | "activity" | "nextMilestone" | "lastDecision" | "lastAcceptedMilestone" | "parked">>): Task {
    const current = this.task(taskId);
    const next = { ...current, ...patch };
    this.db
      .prepare(`UPDATE tasks SET title = ?, objective = ?, activity = ?, next_milestone = ?, last_decision = ?, last_accepted_milestone = ?,
                parked = ?, updated_at = ? WHERE id = ?`)
      .run(next.title, next.objective, next.activity, next.nextMilestone, next.lastDecision, next.lastAcceptedMilestone, next.parked ? 1 : 0, this.iso(), taskId);
    this.log("user", patch.parked === undefined ? "task.edited" : patch.parked ? "task.parked" : "task.unparked", { taskId }, { fields: Object.keys(patch) });
    this.onChange("task");
    return this.task(taskId);
  }

  setPinned(projectId: string, pinned: boolean): Project {
    this.project(projectId);
    this.db.prepare("UPDATE projects SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, projectId);
    this.onChange("project");
    return this.project(projectId);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────────────

  state(): InboxState {
    const projects = (this.db.prepare("SELECT * FROM projects ORDER BY pinned DESC, name").all() as Row[]).map(toProject);
    const tasks = (this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as Row[]).map((r) => this.toTask(r));
    const rows = this.db
      .prepare(`SELECT i.*,
                  (SELECT count(*) FROM evidence e WHERE e.item_id = i.id AND e.revision = i.revision) AS evidence_count,
                  (SELECT e.id FROM evidence e WHERE e.item_id = i.id AND e.revision = i.revision AND e.kind = 'image' ORDER BY e.rowid LIMIT 1) AS thumb
                FROM items i
                WHERE i.state NOT IN ('resolved', 'withdrawn') OR i.updated_at >= ?
                ORDER BY i.updated_at DESC`)
      .all(new Date(this.now().getTime() - 7 * 86_400_000).toISOString()) as Row[];
    const lastReply = this.db.prepare("SELECT * FROM replies WHERE item_id = ? ORDER BY created_at DESC LIMIT 1");
    const items: ItemSummary[] = rows.map((r) => {
      const reply = lastReply.get(str(r.id)) as Row | undefined;
      return {
        ...toItem(r),
        evidenceCount: Number(r.evidence_count),
        thumbnail: r.thumb ? `/files/${str(r.thumb)}` : null,
        lastReply: reply ? this.toReply(reply) : null,
      };
    });
    return { projects, tasks, items, herdr: this.presence.available() ? "connected" : "unavailable" };
  }

  detail(itemId: string): ItemDetail {
    const item = this.item(itemId);
    const task = this.task(item.taskId);
    return {
      item,
      task,
      project: this.project(task.projectId),
      evidence: (this.db.prepare("SELECT * FROM evidence WHERE item_id = ? ORDER BY revision DESC, rowid").all(itemId) as Row[]).map(toEvidence),
      replies: (this.db.prepare("SELECT * FROM replies WHERE item_id = ? ORDER BY created_at").all(itemId) as Row[]).map((r) => this.toReply(r)),
      history: (this.db.prepare("SELECT * FROM events WHERE item_id = ? ORDER BY id").all(itemId) as Row[]).map(toEvent),
    };
  }

  evidenceFile(id: string): { path: string; name: string } | null {
    const row = this.db.prepare("SELECT file FROM evidence WHERE id = ?").get(id) as Row | undefined;
    return row?.file ? { path: join(this.filesDir, str(row.file)), name: str(row.file) } : null;
  }

  item(id: string): Item {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no item ${id}`);
    return toItem(row);
  }

  task(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no task ${id}`);
    return this.toTask(row);
  }

  project(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no project ${id}`);
    return toProject(row);
  }

  reply(id: string): Reply {
    const row = this.db.prepare("SELECT * FROM replies WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no reply ${id}`);
    return this.toReply(row);
  }

  private toTask(r: Row): Task {
    const binding: Binding = { harness: str(r.harness) as Harness, sessionId: str(r.session_id), cwd: nullable(r.cwd) };
    const presence = this.presence.forSession(binding.harness, binding.sessionId);
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      title: str(r.title),
      objective: str(r.objective),
      activity: str(r.activity),
      nextMilestone: str(r.next_milestone),
      lastDecision: str(r.last_decision),
      lastAcceptedMilestone: str(r.last_accepted_milestone),
      parked: Boolean(r.parked),
      binding,
      capabilities: capabilities(binding, nullable(r.listener_seen_at), nullable(r.boundary_seen_at), presence, this.now()),
      presence,
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  private toReply(r: Row): Reply {
    const claimed = nullable(r.claimed_at);
    const uncertain = str(r.state) === "queued" && claimed !== null && this.now().getTime() - Date.parse(claimed) > ACK_GRACE_MS;
    return {
      id: str(r.id),
      itemId: str(r.item_id),
      revision: Number(r.revision),
      action: str(r.action) as ReplyAction,
      choice: nullable(r.choice),
      text: str(r.text),
      state: str(r.state) as Reply["state"],
      error: uncertain ? "picked up by the session but not confirmed" : nullable(r.error),
      createdAt: str(r.created_at),
      deliveredAt: nullable(r.delivered_at),
    };
  }
}

/** The reply route in use is learned from how the session has collected replies. */
export function capabilities(binding: Binding, listenerSeenAt: string | null, boundarySeenAt: string | null, presence: Presence | null, now: Date): Capabilities {
  const reply = isFresh(listenerSeenAt, now) ? "live" : boundarySeenAt ? "boundary" : "pull";
  return { submit: true, reply, ack: true, openConversation: presence !== null, openPreview: true };
}

function isFresh(at: string | null, now: Date): boolean {
  return at !== null && now.getTime() - Date.parse(at) < LISTENER_FRESH_MS;
}

function toPending(r: Row): PendingReply {
  const options = JSON.parse(str(r.options)) as Option[];
  return {
    deliveryId: str(r.id),
    itemId: str(r.item_id),
    itemKey: str(r.key),
    itemTitle: str(r.item_title),
    itemType: str(r.item_type) as Item["type"],
    revision: Number(r.revision),
    action: str(r.action) as ReplyAction,
    choice: nullable(r.choice),
    choiceLabel: options.find((o) => o.id === r.choice)?.label ?? null,
    text: str(r.text),
    createdAt: str(r.created_at),
  };
}

function normalizeItem(raw: SubmitInput["item"]): Omit<Item, "id" | "taskId" | "key" | "revision" | "state" | "snoozedUntil" | "createdAt" | "updatedAt"> {
  const options: Option[] = (raw.options ?? []).map((o, i) => {
    const given = typeof o === "string" ? splitOption(o) : o;
    return { id: given.id?.trim() || String.fromCharCode(97 + i), label: given.label?.trim() ?? "", consequence: given.consequence?.trim() ?? "" };
  }).filter((o) => o.label);
  const p = typeof raw.preview === "string" ? { url: raw.preview } : raw.preview;
  if (p?.url && !/^https?:\/\//i.test(p.url)) throw new InboxError(400, `preview url must be http(s): ${p.url}`);
  const pages = normalizePages(raw.pages);
  // A walkthrough's first page is the preview; a preview alone is a walkthrough of one page.
  const url = p?.url || pages[0]?.url;
  const preview: Preview | null = url ? { url, viewport: p?.viewport ?? null, setup: p?.setup?.trim() ?? "" } : null;
  if (!pages.length && preview) pages.push({ url: preview.url, label: "", look: "" });
  return {
    type: raw.type,
    title: raw.title.trim(),
    request: raw.request?.trim() ?? "",
    context: raw.context?.trim() ?? "",
    recommendation: raw.recommendation?.trim() ?? "",
    options,
    check: raw.check?.trim() ?? "",
    preview,
    pages,
    blocking: raw.blocking ?? raw.type === "decide",
  };
}

function normalizePages(raw: SubmitInput["item"]["pages"]): Page[] {
  if (raw !== undefined && !Array.isArray(raw)) throw new InboxError(400, "item.pages must be a list");
  const pages = (raw ?? []).map((given, i) => {
    const page = typeof given === "string" ? parsePage(given) : given;
    const url = typeof page?.url === "string" ? page.url.trim() : "";
    if (!url) throw new InboxError(400, `page ${i + 1} needs a url`);
    const problem = pageUrlProblem(url);
    if (problem) throw new InboxError(400, `page ${i + 1}: ${problem}`);
    return { url, label: page.label?.trim() ?? "", look: page.look?.trim() ?? "" };
  });
  if (pages.length > MAX_PAGES) throw new InboxError(400, `a walkthrough has at most ${MAX_PAGES} pages; split it into items`);
  return pages;
}

/** "Label: consequence" — the CLI's compact option form. */
function splitOption(s: string): Partial<Option> {
  const at = s.indexOf(":");
  return at < 0 ? { label: s } : { label: s.slice(0, at), consequence: s.slice(at + 1) };
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function toProject(r: Row): Project {
  return { id: str(r.id), name: str(r.name), root: nullable(r.root), objective: str(r.objective), pinned: Boolean(r.pinned), createdAt: str(r.created_at) };
}

function toItem(r: Row): Item {
  const preview = r.preview ? (JSON.parse(str(r.preview)) as Preview) : null;
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    key: str(r.key),
    type: str(r.type) as Item["type"],
    revision: Number(r.revision),
    title: str(r.title),
    request: str(r.request),
    context: str(r.context),
    recommendation: str(r.recommendation),
    options: JSON.parse(str(r.options)) as Option[],
    check: str(r.check_text),
    preview,
    pages: r.pages ? (JSON.parse(str(r.pages)) as Page[]) : preview ? [{ url: preview.url, label: "", look: "" }] : [],
    blocking: Boolean(r.blocking),
    state: str(r.state) as Item["state"],
    snoozedUntil: nullable(r.snoozed_until),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toEvidence(r: Row): Evidence {
  return {
    id: str(r.id),
    itemId: str(r.item_id),
    revision: Number(r.revision),
    kind: str(r.kind) as Evidence["kind"],
    href: r.file ? `/files/${str(r.id)}` : str(r.url),
    caption: str(r.caption),
    capturedAt: str(r.captured_at),
    sourceRevision: str(r.source_revision),
  };
}

function toEvent(r: Row): HistoryEvent {
  return {
    id: Number(r.id),
    at: str(r.at),
    actor: str(r.actor) as HistoryEvent["actor"],
    taskId: nullable(r.task_id),
    itemId: nullable(r.item_id),
    kind: str(r.kind),
    detail: JSON.parse(str(r.detail)) as Record<string, unknown>,
  };
}
