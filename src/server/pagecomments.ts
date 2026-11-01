// Page comments: the founder comments from a web page to a team the office knows, and the office
// owns everything after that. Pages pick a team by id from the list here, never by name. Each
// comment is stored in the office's own queue and given to the team's lead as an ordinary founder
// instruction through Messages.instruct (one delivery path: queued while the lead is busy or away,
// batched, deduped); the lead closes it with `inbox comment fixed|declined`. Pages hear every
// status change from an SSE stream, or through the widget's postMessage relay.
// Which page origins may host the widget is the founder's setting, kept in the data directory; it
// governs postMessage and framing only, never the service's Origin guard.

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { object, optional, list, text, nonempty, record, oneOf, refine, fail, sessionSchema, type Schema } from "../shared/agent-protocol.ts";
import {
  AGENT_COMMENT_STATUSES, COMMENT_ID, DEFAULT_PAGE_ORIGINS, META_MAX_BYTES, cleanMeta, cleanPageContext, commentEvent,
  normalizeOriginPattern, pageCommentText,
  type AgentCommentStatus, type PageComment, type PageCommentEvent, type PageCommentInput, type PageCommentStatus, type PageTeam,
} from "../shared/pagecomments.ts";
import { leftBeforeArrival } from "../shared/delivery.ts";
import type { Message, SessionInput, WorldAgent, WorldState } from "../shared/types.ts";
import { requestFingerprint } from "./db.ts";
import { InboxError } from "./inbox.ts";

const httpUrl = (max: number): Schema<string> => refine(nonempty, (s, p) => {
  if (s.length > max || !/^https?:\/\//i.test(s)) fail(p, `must be an http(s) URL under ${max} characters`);
  try { new URL(s); } catch { fail(p, "must be a valid URL"); }
});
export const pageCommentSchema: Schema<PageCommentInput> = refine(object({
  text: optional(text), page: optional(record), images: optional(list(nonempty)), clientId: optional(nonempty),
  openUrl: optional(httpUrl(1000)), meta: optional(record),
}), (b, p) => {
  if (b.meta !== undefined && !cleanMeta(b.meta)) fail(`${p ? `${p}.` : ""}meta`, `must be a JSON object of at most ${META_MAX_BYTES} bytes`);
});
export const pageOriginsSchema = object({ origins: list(text) });
export const commentStatusSchema = refine(object({
  status: oneOf(AGENT_COMMENT_STATUSES), note: optional(text), url: optional(httpUrl(1000)), commit: optional(nonempty), session: optional(sessionSchema),
}), (b, p) => {
  if (b.status === "declined" && !b.note?.trim()) fail(`${p ? `${p}.` : ""}note`, "say why it is declined");
  if (b.commit !== undefined && !/^[0-9a-f]{7,64}$/i.test(b.commit)) fail(`${p ? `${p}.` : ""}commit`, "must be a commit SHA");
});

/** A delivery that failed because its lead left is given to the team again, at most this many times in all. */
export const MAX_ATTEMPTS = 3;
const FINAL: ReadonlySet<PageCommentStatus> = new Set(["fixed", "declined"]);

interface Office {
  state(): WorldState;
  instruct(teamId: string, input: { text?: string; images?: string[]; clientId?: string }): Message;
  message(id: string): Message;
  resolve?(session: SessionInput): WorldAgent;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v == null ? "" : String(v));
const opt = (v: unknown): string | null => (v == null ? null : String(v));

export class PageComments {
  /** Told of every status change (the SSE stream listens here). */
  readonly listeners = new Set<(event: PageCommentEvent, comment: PageComment) => void>();
  /** Something the office UI shows changed. */
  onChange: () => void = () => {};
  private db: DatabaseSync;
  private office: Office;
  private settingsPath: string;
  private now: () => Date;
  private syncing = false;

  constructor(db: DatabaseSync, office: Office, settingsPath: string, now: () => Date = () => new Date()) {
    this.db = db;
    this.office = office;
    this.settingsPath = settingsPath;
    this.now = now;
  }

  /** Every team, ordered by name, with only what a page needs to pick one. */
  teams(): { teams: PageTeam[] } {
    const state = this.office.state();
    const teams = state.teams.map((t): PageTeam => {
      const lead = state.agents.find((a) => a.teamId === t.id && a.role === "lead") ?? null;
      const online = !!lead && lead.status !== "offline";
      return {
        id: t.id, name: t.name, purpose: t.purpose, status: t.status,
        lead: lead ? { name: lead.name, online } : null, leadPresent: online,
      };
    });
    return { teams: teams.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /** Queues one comment for the team and gives it to the lead at once when it can. The same client id returns the first comment. */
  enqueue(teamId: string, input: PageCommentInput): PageComment {
    const page = cleanPageContext(input.page);
    const body = input.text?.trim() ?? "";
    const images = [...new Set(input.images ?? [])];
    const meta = input.meta === undefined ? null : cleanMeta(input.meta) ?? null;
    if (!body && !images.length) throw new InboxError(400, "the comment needs some text");
    if (body.length > 6000) throw new InboxError(413, "keep the comment under 6000 characters");
    const fingerprint = requestFingerprint({ teamId, body, page, images: [...images].sort(), openUrl: input.openUrl ?? null, meta });
    if (input.clientId) {
      const prior = this.db.prepare("SELECT id, fingerprint FROM page_comments WHERE client_id = ?").get(input.clientId) as Row | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Object.assign(new InboxError(409, "client id was already used for a different comment"), { code: "replay_conflict" });
        return this.get(str(prior.id));
      }
    }
    if (!this.office.state().teams.some((t) => t.id === teamId)) throw new InboxError(404, `no team ${teamId}`);
    const id = `pc-${randomBytes(5).toString("hex")}`;
    const at = this.now().toISOString();
    const origin = originOf(page.url) ?? originOf(input.openUrl);
    this.db.prepare(`INSERT INTO page_comments (id, team_id, text, page, origin, open_url, meta, images, status, attempts, client_id, fingerprint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`)
      .run(id, teamId, body, JSON.stringify(page), origin, input.openUrl ?? null, meta ? JSON.stringify(meta) : null, images.length ? JSON.stringify(images) : null, input.clientId ?? null, fingerprint, at, at);
    this.emit(id);
    this.sync();
    return this.get(id);
  }

  get(id: string): PageComment {
    if (!COMMENT_ID.test(id)) throw new InboxError(404, `no page comment ${id}`);
    const row = this.db.prepare("SELECT * FROM page_comments WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no page comment ${id}`);
    return this.toComment(row, this.teamNames());
  }

  /** Newest first; filtered by team, page origin, ids or status. */
  list(filter: { team?: string; origin?: string; ids?: string[]; status?: string; limit?: number } = {}): { comments: PageComment[] } {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.team) { where.push("team_id = ?"); args.push(filter.team); }
    if (filter.origin) { where.push("origin = ?"); args.push(filter.origin.toLowerCase()); }
    if (filter.status) { where.push("status = ?"); args.push(filter.status); }
    if (filter.ids?.length) { where.push(`id IN (${filter.ids.map(() => "?").join(", ")})`); args.push(...filter.ids); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM page_comments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`).all(...args) as Row[];
    const names = this.teamNames();
    return { comments: rows.map((r) => this.toComment(r, names)) };
  }

  /** The fixer closes the loop: working, fixed (with an optional url that overrides openUrl) or declined (with a note). */
  setStatus(id: string, input: { status: AgentCommentStatus; note?: string; url?: string; commit?: string; session?: SessionInput }): PageComment {
    const current = this.get(id);
    const by = input.session && this.office.resolve ? this.office.resolve(input.session).name : null;
    const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
    if (FINAL.has(current.status)) {
      const same = current.status === input.status && (note ?? current.note) === current.note && (input.url ?? current.openUrl) === current.openUrl && (input.commit ?? current.commit) === current.commit;
      if (same) return current;
      throw Object.assign(new InboxError(409, `comment ${id} is already ${current.status}`), { code: "comment_closed" });
    }
    if (input.status === "working" && current.status === "working" && !note) return current;
    const at = this.now().toISOString();
    this.db.prepare("UPDATE page_comments SET status = ?, note = COALESCE(?, note), fixed_url = COALESCE(?, fixed_url), commit_sha = COALESCE(?, commit_sha), by_name = ?, updated_at = ? WHERE id = ?")
      .run(input.status, note, input.url ?? null, input.commit?.toLowerCase() ?? null, by, at, id);
    this.emit(id);
    return this.get(id);
  }

  /**
   * Moves the queue on: gives queued comments to their team's lead, and reads how each delivery went.
   * A delivery that failed because its recipient left is given to the team again (up to MAX_ATTEMPTS);
   * any other failure may already have arrived, so it is never replayed: the comment says failed until
   * the founder's Retry in the office delivers it.
   */
  sync(): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const rows = this.db.prepare("SELECT * FROM page_comments WHERE status IN ('queued', 'failed') ORDER BY created_at, rowid").all() as Row[];
      for (const row of rows) this.advance(row);
    } finally {
      this.syncing = false;
    }
  }

  private advance(row: Row): void {
    const id = str(row.id);
    const messageId = opt(row.message_id);
    const attempts = Number(row.attempts);
    if (messageId) {
      let message: Message;
      try { message = this.office.message(messageId); } catch { return this.update(id, { message_id: null }); }
      const state = this.office.state();
      const deliveries = message.deliveries;
      if (deliveries.length && deliveries.every((d) => d.state === "delivered")) return this.update(id, { status: "delivered", note: null });
      const failed = deliveries.find((d) => d.state === "failed");
      if (!failed || deliveries.some((d) => d.state === "queued" || d.state === "sending")) return;
      const agent = state.agents.find((a) => a.id === failed.agentId);
      if (leftBeforeArrival(failed, agent) && attempts < MAX_ATTEMPTS) return this.update(id, { message_id: null, status: "queued", note: null });
      if (str(row.status) !== "failed") this.update(id, { status: "failed", note: failed.error ?? "not delivered" });
      return;
    }
    if (str(row.status) !== "queued") return;
    if (attempts >= MAX_ATTEMPTS) return this.update(id, { status: "failed", note: "its team had nobody to give it to" });
    const comment = this.toComment(row, this.teamNames());
    try {
      const message = this.office.instruct(comment.teamId, { text: this.leadText(comment), images: comment.images, clientId: `page-comment:${id}:${attempts + 1}` });
      this.update(id, { message_id: message.id, attempts: attempts + 1, note: null });
    } catch (err) {
      const e = err as InboxError;
      // Nobody on the team yet: it stays queued until someone is.
      if (e.status === 409) return this.update(id, { note: e.message }, false);
      this.update(id, { status: "failed", note: e.message || "could not be given to the team" });
    }
  }

  /** What the lead reads: the page context, the comment, where to open it, and how to close the loop. */
  private leadText(c: PageComment): string {
    const open = c.openUrl ? `\n\nOpen to check: ${c.openUrl}` : "";
    return `${pageCommentText(c.text, c.page)}${open}\n\nPage comment ${c.id}. Say \`inbox comment working ${c.id}\` when you start; when it is fixed, \`inbox comment fixed ${c.id} [--url URL] [--note "…"] [--commit SHA]\` (--url when the fix is best seen somewhere more specific); if it will not be fixed, \`inbox comment declined ${c.id} --note "why"\`. The page that sent it is told.`;
  }

  /** The page origins allowed to host the widget; local dev servers until the founder sets them. */
  origins(): { origins: string[]; default: boolean } {
    if (!existsSync(this.settingsPath)) return { origins: [...DEFAULT_PAGE_ORIGINS], default: true };
    try {
      const saved = JSON.parse(readFileSync(this.settingsPath, "utf8")) as { origins?: unknown };
      if (!Array.isArray(saved.origins)) throw new Error("no origins");
      return { origins: saved.origins.map(String).map(normalizeOriginPattern).filter((o): o is string => !!o), default: false };
    } catch {
      // A damaged file fails closed: no page may host the widget until the founder saves the list again.
      return { origins: [], default: false };
    }
  }

  setOrigins(input: { origins: string[] }): { origins: string[]; default: boolean } {
    const out: string[] = [];
    for (const raw of input.origins) {
      const o = normalizeOriginPattern(raw);
      if (!o) throw new InboxError(400, `not a page origin: ${raw.slice(0, 80)} (use scheme://host, scheme://host:port or scheme://host:*)`);
      if (!out.includes(o)) out.push(o);
    }
    if (out.length > 50) throw new InboxError(400, "allow at most 50 page origins");
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const tmp = `${this.settingsPath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ origins: out }, null, 2)}\n`);
    renameSync(tmp, this.settingsPath);
    return { origins: out, default: false };
  }

  /** Framing headers for the widget: only allowed page origins may frame it. */
  embedHeaders(): Record<string, string> {
    const { origins } = this.origins();
    return {
      "content-security-policy": `frame-ancestors 'self'${origins.length ? ` ${origins.join(" ")}` : ""}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-cache",
    };
  }

  private update(id: string, fields: Record<string, string | number | null>, announce = true): void {
    const before = this.db.prepare("SELECT * FROM page_comments WHERE id = ?").get(id) as Row;
    const keys = Object.keys(fields);
    if (keys.every((k) => (before[k] ?? null) === fields[k])) return;
    this.db.prepare(`UPDATE page_comments SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]!), this.now().toISOString(), id);
    if (announce && "status" in fields && fields.status !== before.status) this.emit(id);
    else this.onChange();
  }

  private emit(id: string): void {
    const comment = this.get(id);
    const event = commentEvent(comment);
    for (const listener of this.listeners) {
      try { listener(event, comment); } catch { /* a closed stream must not stop the others */ }
    }
    this.onChange();
  }

  private teamNames(): Map<string, string> {
    return new Map(this.office.state().teams.map((t) => [t.id, t.name]));
  }

  private toComment(r: Row, names: Map<string, string>): PageComment {
    return {
      id: str(r.id), teamId: str(r.team_id), teamName: names.get(str(r.team_id)) ?? "",
      text: str(r.text), page: JSON.parse(str(r.page) || "{}"), origin: opt(r.origin),
      openUrl: opt(r.fixed_url) ?? opt(r.open_url), meta: r.meta ? JSON.parse(str(r.meta)) : null,
      images: r.images ? JSON.parse(str(r.images)) : [],
      status: str(r.status) as PageCommentStatus, note: opt(r.note), commit: opt(r.commit_sha), by: opt(r.by_name),
      messageId: opt(r.message_id), attempts: Number(r.attempts), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    };
  }
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin.toLowerCase(); } catch { return null; }
}
