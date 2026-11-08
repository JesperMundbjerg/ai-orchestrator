// Page comments: the founder comments from a web page to a team the office knows, and the office
// owns everything after that. Pages pick a team by id from the list here, never by name. Each
// comment is stored in the office's own queue and given to the team's lead as an ordinary founder
// instruction through Messages.instruct (one delivery path: queued while the lead is busy or away,
// batched, deduped); the lead closes it with `inbox comment fixed|declined`, or asks the page with
// `inbox comment ask`. Pages may group comments (one message to the lead, each its own id), edit or
// withdraw them (in place before the office hands them over, as a follow-up message after), and
// answer questions. Pages hear every change from an SSE stream, or through the widget's postMessage relay.
// Which page origins may host the widget is the founder's setting, kept in the data directory; it
// governs postMessage and framing only, never the service's Origin guard.

import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { object, optional, list, text, nonempty, record, oneOf, refine, fail, sessionSchema, boolean, type Schema } from "../shared/agent-protocol.ts";
import {
  AGENT_COMMENT_STATUSES, CLOSED_COMMENT_STATUSES, COMMENT_VERDICTS, COMMENT_ID, DEFAULT_PAGE_ORIGINS, GROUP_ID, GROUP_MAX, KIND_MAX, META_MAX_BYTES,
  cleanKind, cleanMeta, cleanPageContext, commentEvent, normalizeOriginPattern, pageCommentText, pageContextLines,
  type AgentCommentStatus, type CommentVerificationFilter, type PageComment, type CommentVerdict, type PageCommentEdit, type PageCommentEvent, type PageCommentInput, type PageCommentStatus, type PageTeam,
} from "../shared/pagecomments.ts";
import { leftBeforeArrival } from "../shared/delivery.ts";
import type { Message, SessionInput, WorldAgent, WorldState } from "../shared/types.ts";
import { requestFingerprint } from "./db.ts";
import { InboxError } from "./inbox.ts";
import { ensurePageCommentColumns } from "./pagecomments-schema.ts";
import { Adapters } from "./adapter.ts";
import { gitNonblocking, rethrowPending, runPass, settle } from "./gitcache.ts";
import { git, inRequest, isAncestor, publishedBranch, repository } from "./pipelines/candidate.ts";

const httpUrl = (max: number): Schema<string> => refine(nonempty, (s, p) => {
  if (s.length > max || !/^https?:\/\//i.test(s)) fail(p, `must be an http(s) URL under ${max} characters`);
  try { new URL(s); } catch { fail(p, "must be a valid URL"); }
});
const at = (p: string, key: string) => `${p ? `${p}.` : ""}${key}`;
const kindSchema = refine(text, (s, p) => { if (s.length > KIND_MAX) fail(p, `keep it under ${KIND_MAX} characters`); });
const groupIdSchema = refine(nonempty, (s, p) => { if (!GROUP_ID.test(s)) fail(p, "must be a group id from the office (pg-…)"); });
const commentFields = {
  text: optional(text), page: optional(record), images: optional(list(nonempty)), clientId: optional(nonempty),
  openUrl: optional(httpUrl(1000)), meta: optional(record), kind: optional(kindSchema),
  followsUp: optional(refine(nonempty, (s, p) => { if (!COMMENT_ID.test(s)) fail(p, "must be a page comment id (pc-…)"); })),
};
const checkMeta = (b: { meta?: Record<string, unknown> }, p: string) => {
  if (b.meta !== undefined && !cleanMeta(b.meta)) fail(at(p, "meta"), `must be a JSON object of at most ${META_MAX_BYTES} bytes`);
};
export const pageCommentSchema: Schema<PageCommentInput> = refine(object({
  ...commentFields, groupId: optional(groupIdSchema), hold: optional(boolean),
}), checkMeta);
/** Several comments queued as one group: one message to the lead, each its own id and status. */
export const pageCommentGroupSchema = refine(object({ comments: list(refine(object(commentFields), checkMeta)), clientId: optional(nonempty) }), (b, p) => {
  if (!b.comments.length || b.comments.length > GROUP_MAX) fail(at(p, "comments"), `send 1 to ${GROUP_MAX} comments`);
});
export const commentEditSchema: Schema<PageCommentEdit> = refine(object({
  text: optional(text), kind: optional(kindSchema), openUrl: optional(httpUrl(1000)), meta: optional(record),
}), (b, p) => {
  checkMeta(b, p);
  if (b.text === undefined && b.kind === undefined && b.openUrl === undefined && b.meta === undefined) fail(p, "say what to change: text, kind, openUrl or meta");
});
export const commentWithdrawSchema = object({ note: optional(text) });
export const commentAskSchema = object({ question: nonempty, session: optional(sessionSchema) });
export const commentAnswerSchema = object({ text: nonempty, images: optional(list(nonempty)) });
export const commentVerifySchema = object({ verdict: oneOf(COMMENT_VERDICTS), note: optional(text), clientId: optional(nonempty) });
export const pageOriginsSchema = object({ origins: list(text) });
export const commentStatusSchema = refine(object({
  status: oneOf(AGENT_COMMENT_STATUSES), note: optional(text), url: optional(httpUrl(1000)), commit: optional(nonempty), session: optional(sessionSchema),
}), (b, p) => {
  if (b.status === "declined" && !b.note?.trim()) fail(`${p ? `${p}.` : ""}note`, "say why it is declined");
  if (b.commit !== undefined && !/^[0-9a-f]{7,64}$/i.test(b.commit)) fail(`${p ? `${p}.` : ""}commit`, "must be a commit SHA");
});

/** A delivery that failed because its lead left is given to the team again, at most this many times in all. */
export const MAX_ATTEMPTS = 3;
const FINAL: ReadonlySet<PageCommentStatus> = new Set(CLOSED_COMMENT_STATUSES);
const TEXT_MAX = 6000;
/** How often a comment waiting for its fix to reach the integration branch is looked at (gitcache answers it, never a fetch). */
export const LANDING_POLL_MS = 3_000;

/** Where a team's fixes must land before a comment is fixed: its repository and integration branch, as its pipeline reads them. */
type Integration = { repo: string; branch: string };

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
  private adapters = new Adapters();
  private landingPollMs: number;
  private landingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: DatabaseSync, office: Office, settingsPath: string, now: () => Date = () => new Date(), options: { landingPollMs?: number } = {}) {
    this.db = db;
    this.office = office;
    this.settingsPath = settingsPath;
    this.now = now;
    this.landingPollMs = options.landingPollMs ?? LANDING_POLL_MS;
    // Migration 18 made the table; columns added since then are added here when missing.
    ensurePageCommentColumns(db);
    this.watchLandings();
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

  /**
   * Queues one comment for the team and gives it to the lead at once when it can. The same client id
   * returns the first comment. With `hold` it waits in its group (a new one without a group id) until
   * the group is sent; a comment without `hold` to a held group sends the group with it.
   */
  enqueue(teamId: string, input: PageCommentInput): PageComment {
    const id = this.insert(teamId, input, input.groupId ?? (input.hold ? newGroupId() : null), input.hold ? "held" : "queued");
    const comment = this.get(id);
    // The earlier comment lists its follow-ups, so its page hears of this one too.
    if (comment.followsUp) this.emit(comment.followsUp);
    if (comment.groupId && !input.hold) return (this.sendGroup(comment.groupId), this.get(id));
    if (comment.status !== "held") this.sync();
    return this.get(id);
  }

  /** Queues several comments as one group: the lead gets them in one message; each keeps its own id and status. */
  enqueueGroup(teamId: string, input: { comments: PageCommentInput[]; clientId?: string }): { groupId: string; comments: PageComment[] } {
    if (!input.comments.length || input.comments.length > GROUP_MAX) throw new InboxError(400, `send 1 to ${GROUP_MAX} comments`);
    const replay = input.clientId ? this.db.prepare("SELECT group_id FROM page_comments WHERE client_id = ?").get(`${input.clientId}:0`) as Row | undefined : undefined;
    const groupId = opt(replay?.group_id) ?? newGroupId();
    const ids: string[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      input.comments.forEach((c, i) => ids.push(this.insert(teamId, { ...c, ...(input.clientId ? { clientId: `${input.clientId}:${i}` } : {}) }, groupId, "held", false)));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const id of ids) this.emit(id);
    this.sendGroup(groupId);
    return { groupId, comments: ids.map((id) => this.get(id)) };
  }

  /** A held group goes to the lead now, as one message. */
  sendGroup(groupId: string): { groupId: string; comments: PageComment[] } {
    const members = this.groupRows(groupId);
    for (const row of members) if (str(row.status) === "held") this.update(str(row.id), { status: "queued" });
    this.sync();
    return { groupId, comments: this.groupRows(groupId).map((r) => this.toComment(r, this.teamNames())) };
  }

  /** A held group is dropped: its comments are withdrawn without reaching anyone. */
  discardGroup(groupId: string): { groupId: string; comments: PageComment[] } {
    for (const row of this.groupRows(groupId)) if (str(row.status) === "held") this.update(str(row.id), { status: "withdrawn", note: "the group was discarded" });
    return { groupId, comments: this.groupRows(groupId).map((r) => this.toComment(r, this.teamNames())) };
  }

  private groupRows(groupId: string): Row[] {
    if (!GROUP_ID.test(groupId)) throw new InboxError(404, `no comment group ${groupId}`);
    const rows = this.db.prepare("SELECT * FROM page_comments WHERE group_id = ? ORDER BY created_at, rowid").all(groupId) as Row[];
    if (!rows.length) throw new InboxError(404, `no comment group ${groupId}`);
    return rows;
  }

  private insert(teamId: string, input: PageCommentInput, groupId: string | null, status: "held" | "queued", announce = true): string {
    const page = cleanPageContext(input.page);
    const body = input.text?.trim() ?? "";
    const images = [...new Set(input.images ?? [])];
    const meta = input.meta === undefined ? null : cleanMeta(input.meta) ?? null;
    const kind = cleanKind(input.kind) ?? null;
    const followsUp = input.followsUp ?? null;
    if (followsUp && !this.db.prepare("SELECT 1 FROM page_comments WHERE id = ?").get(followsUp)) throw new InboxError(404, `no page comment ${followsUp} to follow up`);
    if (!body && !images.length) throw new InboxError(400, "the comment needs some text");
    if (body.length > TEXT_MAX) throw new InboxError(413, `keep the comment under ${TEXT_MAX} characters`);
    const fingerprint = requestFingerprint({ teamId, body, page, images: [...images].sort(), openUrl: input.openUrl ?? null, meta, kind, followsUp, groupId: input.groupId ?? null, hold: !!input.hold });
    if (input.clientId) {
      const prior = this.db.prepare("SELECT id, fingerprint FROM page_comments WHERE client_id = ?").get(input.clientId) as Row | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Object.assign(new InboxError(409, "client id was already used for a different comment"), { code: "replay_conflict" });
        return str(prior.id);
      }
    }
    if (!this.office.state().teams.some((t) => t.id === teamId)) throw new InboxError(404, `no team ${teamId}`);
    if (groupId) {
      const other = this.db.prepare("SELECT team_id, status FROM page_comments WHERE group_id = ? AND status != 'withdrawn'").all(groupId) as Row[];
      if (input.groupId && !other.length) throw new InboxError(404, `no comment group ${groupId}`);
      if (other.some((r) => str(r.team_id) !== teamId)) throw new InboxError(409, "a group goes to one team");
      if (other.some((r) => str(r.status) !== "held")) throw Object.assign(new InboxError(409, `group ${groupId} was already sent`), { code: "group_sent" });
      if (other.length >= GROUP_MAX) throw new InboxError(409, `a group holds at most ${GROUP_MAX} comments`);
    }
    const id = `pc-${randomBytes(5).toString("hex")}`;
    const now = this.now().toISOString();
    const origin = originOf(page.url) ?? originOf(input.openUrl);
    this.db.prepare(`INSERT INTO page_comments (id, team_id, text, page, origin, open_url, meta, images, status, attempts, client_id, fingerprint, created_at, updated_at, kind, group_id, follows_up)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, teamId, body, JSON.stringify(page), origin, input.openUrl ?? null, meta ? JSON.stringify(meta) : null, images.length ? JSON.stringify(images) : null, status, input.clientId ?? null, fingerprint, now, now, kind, groupId, followsUp);
    if (announce) this.emit(id);
    return id;
  }

  /**
   * The page changes its comment. Still in the office's hands (held, or queued and not yet handed to
   * the lead), it changes in place; once the lead has it, the lead gets the change as a follow-up
   * message on the same comment id. The same edit twice changes nothing.
   */
  edit(id: string, input: PageCommentEdit): PageComment {
    const current = this.get(id);
    if (FINAL.has(current.status)) throw Object.assign(new InboxError(409, `comment ${id} is already ${current.status}`), { code: "comment_closed" });
    const row = this.row(id);
    const text = input.text === undefined ? undefined : input.text.trim();
    if (text !== undefined && !text) throw new InboxError(400, "the comment needs some text");
    if (text && text.length > TEXT_MAX) throw new InboxError(413, `keep the comment under ${TEXT_MAX} characters`);
    const kind = input.kind === undefined ? undefined : cleanKind(input.kind) ?? null;
    const meta = input.meta === undefined ? undefined : cleanMeta(input.meta) ?? null;
    const fields: Record<string, string | number | null> = {};
    if (text !== undefined && text !== current.text) fields.text = text;
    if (kind !== undefined && kind !== current.kind) fields.kind = kind;
    if (input.openUrl !== undefined && input.openUrl !== opt(row.open_url)) fields.open_url = input.openUrl;
    if (meta !== undefined && JSON.stringify(meta) !== JSON.stringify(current.meta)) fields.meta = meta ? JSON.stringify(meta) : null;
    if (!Object.keys(fields).length) return current;
    fields.revision = current.revision + 1;
    if (!current.editable) {
      const next = { ...current, text: text ?? current.text, kind: kind === undefined ? current.kind : kind, openUrl: opt(row.fixed_url) ?? input.openUrl ?? current.openUrl };
      const changed = [fields.text !== undefined ? "text" : null, fields.kind !== undefined ? "kind" : null, fields.open_url !== undefined ? "open URL" : null, fields.meta !== undefined ? "page fields" : null].filter(Boolean).join(", ");
      this.followUp(current, `[Page comment ${id} edited]\nThe page changed this comment's ${changed} (revision ${fields.revision}); this replaces what you have:\n\n${pageCommentText(next.text, current.page, next.kind)}${next.openUrl ? `\n\nOpen to check: ${next.openUrl}` : ""}`, `edit:${fields.revision}`);
    }
    this.update(id, fields, false);
    this.emit(id);
    return this.get(id);
  }

  /** The page takes its comment back. In the office's hands it simply closes; once the lead has it, the lead is told to stop. */
  withdraw(id: string, input: { note?: string } = {}): PageComment {
    const current = this.get(id);
    if (current.status === "withdrawn") return current;
    if (FINAL.has(current.status)) throw Object.assign(new InboxError(409, `comment ${id} is already ${current.status}`), { code: "comment_closed" });
    const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
    if (!current.editable) {
      // Withdrawing never depends on reaching the lead: when nobody can be told, it still closes.
      try { this.followUp(current, `[Page comment ${id} withdrawn]\nThe page withdrew this comment${note ? `: ${note}` : ""}. Stop any work on it; it is closed and needs no status from you.`, "withdraw"); }
      catch { /* told in the comment's note below */ }
    }
    this.update(id, { status: "withdrawn", note: note ?? (current.editable ? "withdrawn before it reached the team" : "withdrawn by the page") }, false);
    this.emit(id);
    return this.get(id);
  }

  /** The lead (or its crew) asks the page about a comment: status asked, with the question in the event. */
  ask(id: string, input: { question: string; session?: SessionInput }): PageComment {
    const current = this.get(id);
    if (FINAL.has(current.status)) throw Object.assign(new InboxError(409, `comment ${id} is already ${current.status}`), { code: "comment_closed" });
    if (current.editable) throw Object.assign(new InboxError(409, `comment ${id} has not reached the team yet`), { code: "comment_not_delivered" });
    const question = input.question.trim().slice(0, 2000);
    if (current.status === "asked" && current.question === question) return current;
    const by = input.session && this.office.resolve ? this.office.resolve(input.session).name : null;
    this.update(id, { status: "asked", question, answer: null, by_name: by }, false);
    this.emit(id);
    return this.get(id);
  }

  /** The page (or the founder in the office) answers the question: it reaches the lead as a message on the comment, and work goes on. */
  answer(id: string, input: { text: string; images?: string[] }): PageComment {
    const current = this.get(id);
    const answer = input.text.trim().slice(0, TEXT_MAX);
    if (current.status !== "asked") {
      if (current.answer === answer) return current;
      throw Object.assign(new InboxError(409, `comment ${id} has no open question`), { code: "no_question" });
    }
    this.followUp(current, `[Page comment ${id} answered]\nYou asked: ${current.question}\nThe answer: ${answer}\n\nIt is back to working. Close it as before: \`inbox comment fixed ${id} --commit SHA\` once the fix is pushed, or \`inbox comment declined ${id} --note "why"\`.`, `answer:${current.updatedAt}`, input.images);
    this.update(id, { status: "working", answer }, false);
    this.emit(id);
    return this.get(id);
  }

  /**
   * The founder checks a fixed comment. Verified marks it so (a release gate reads that); still wrong
   * opens a follow-up comment to the same team, on the same page, that names the fix it follows up.
   * Asking again gives the same answer: the same follow-up, never a second one.
   */
  verify(id: string, input: { verdict: CommentVerdict; note?: string }): { comment: PageComment; followUp: PageComment | null } {
    const current = this.get(id);
    if (current.status !== "fixed") throw Object.assign(new InboxError(409, `comment ${id} is ${current.status}, not fixed`), { code: "comment_not_fixed" });
    const reopened = () => {
      const row = this.db.prepare("SELECT id FROM page_comments WHERE follows_up = ? AND client_id = ?").get(id, `still-wrong:${id}`) as Row | undefined;
      return row ? this.get(str(row.id)) : null;
    };
    if (current.verification === input.verdict) return { comment: current, followUp: input.verdict === "still-wrong" ? reopened() : null };
    if (current.verification === "still-wrong") throw Object.assign(new InboxError(409, `comment ${id} was found still wrong; verify its follow-up instead`), { code: "comment_reopened" });
    const at = this.now().toISOString();
    this.update(id, { verification: input.verdict, verified_at: at }, false);
    let followUp: PageComment | null = null;
    if (input.verdict === "still-wrong") {
      const row = this.row(id);
      followUp = this.enqueue(current.teamId, {
        text: input.note?.trim() || "Still wrong after the fix.", page: current.page, followsUp: id, clientId: `still-wrong:${id}`,
        ...(opt(row.open_url) ? { openUrl: opt(row.open_url)! } : {}), ...(current.meta ? { meta: current.meta } : {}), ...(current.kind ? { kind: current.kind } : {}),
      });
    } else this.emit(id);
    return { comment: this.get(id), followUp };
  }

  /** A message to the team's lead about a comment it already has. Throws when the office cannot give it to anyone. */
  private followUp(c: PageComment, text: string, key: string, images?: string[]): void {
    this.office.instruct(c.teamId, { text, ...(images?.length ? { images } : {}), clientId: `page-comment:${c.id}:${key}` });
  }

  get(id: string): PageComment {
    if (!COMMENT_ID.test(id)) throw new InboxError(404, `no page comment ${id}`);
    const row = this.db.prepare("SELECT * FROM page_comments WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new InboxError(404, `no page comment ${id}`);
    return this.toComment(row, this.teamNames());
  }

  /** Newest first; filtered by team, page origin, ids, status or (for fixed ones) whether the founder verified them. */
  list(filter: { team?: string; origin?: string; ids?: string[]; status?: string; verified?: boolean; verification?: CommentVerificationFilter[]; limit?: number } = {}): { comments: PageComment[] } {
    const where: string[] = [];
    const args: string[] = [];
    // verified=true: fixed and verified; verified=false: fixed and not (yet) verified.
    if (filter.verified !== undefined) where.push(filter.verified ? "status = 'fixed' AND verification = 'verified'" : "status = 'fixed' AND (verification IS NULL OR verification != 'verified')");
    // verification: fixed comments whose check is one of the listed states (none = not judged yet).
    if (filter.verification) {
      const states = filter.verification.map((v) => (v === "none" ? "verification IS NULL" : `verification = '${v}'`));
      where.push(`status = 'fixed' AND (${states.join(" OR ") || "0"})`);
    }
    if (filter.team) { where.push("team_id = ?"); args.push(filter.team); }
    if (filter.origin) { where.push("origin = ?"); args.push(filter.origin.toLowerCase()); }
    if (filter.status) { where.push("status = ?"); args.push(filter.status); }
    if (filter.ids?.length) { where.push(`id IN (${filter.ids.map(() => "?").join(", ")})`); args.push(...filter.ids); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db.prepare(`SELECT * FROM page_comments ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`).all(...args) as Row[];
    const names = this.teamNames();
    return { comments: rows.map((r) => this.toComment(r, names)) };
  }

  /**
   * The fixer closes the loop: working, fixed (with an optional url that overrides openUrl) or declined (with a note).
   * For a team with an integration branch, fixed needs the commit, and is fixed only once that commit is on the
   * branch: until then the comment stays working, with `landing` naming the commit and branch it waits for
   * (DESIGN "A page comment is fixed only once its commit is on the team's integration branch").
   */
  setStatus(id: string, input: { status: AgentCommentStatus; note?: string; url?: string; commit?: string; session?: SessionInput }): PageComment {
    const current = this.get(id);
    const by = input.session && this.office.resolve ? this.office.resolve(input.session).name : null;
    const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
    if (FINAL.has(current.status)) {
      const commitSame = input.commit === undefined || [current.commit, current.commit?.slice(0, input.commit.length)].includes(input.commit.toLowerCase());
      const same = current.status === input.status && (note ?? current.note) === current.note && (input.url ?? current.openUrl) === current.openUrl && commitSame;
      if (same) return current;
      throw Object.assign(new InboxError(409, `comment ${id} is already ${current.status}`), { code: "comment_closed" });
    }
    if (current.editable) throw Object.assign(new InboxError(409, `comment ${id} has not reached the team yet`), { code: "comment_not_delivered" });
    if (input.status === "working" && current.status === "working" && !note) return current;
    let status: AgentCommentStatus = input.status;
    let commit = input.commit?.toLowerCase() ?? null;
    // Waiting for a landing: [commit, branch, repo]; declined drops it; working keeps the one there.
    let landing: [string, string, string] | null | undefined = input.status === "declined" ? null : undefined;
    if (input.status === "fixed") {
      const found = this.fixedOn(current.teamId, commit);
      if (found) {
        commit = found.commit;
        if (!found.landed) { status = "working"; landing = [found.commit, found.branch, found.repo]; }
        else landing = null;
      }
    }
    const at = this.now().toISOString();
    this.db.prepare(`UPDATE page_comments SET status = ?, note = COALESCE(?, note), fixed_url = COALESCE(?, fixed_url), commit_sha = COALESCE(?, commit_sha), by_name = ?, updated_at = ?
      ${landing === undefined ? "" : ", landing_commit = ?, landing_branch = ?, landing_repo = ?"} WHERE id = ?`)
      .run(status, note, input.url ?? null, commit, by, at, ...(landing === undefined ? [] : landing ?? [null, null, null]), id);
    this.emit(id);
    if (landing) this.watchLandings();
    return this.get(id);
  }

  /**
   * For a fixed call: null when the team has no integration branch (fixed as before); otherwise the full commit, the
   * branch and whether the commit is already on it. Refuses (400) without a commit, or with one the repository lacks.
   * A decision (gitcache.ts): it uses only Git facts read since it was asked, and answers git_pending while they are read.
   */
  private fixedOn(teamId: string, commit: string | null): (Integration & { commit: string; landed: boolean }) | null {
    const state = this.office.state();
    return inRequest(() => {
      const target = this.integration(teamId, state);
      if (!target) return null;
      if (!commit) throw Object.assign(new InboxError(400, `this team's fixes land on ${target.branch}: push the fix to origin/${target.branch} first, then mark it with --commit SHA (inbox comment fixed ID --commit SHA)`), { code: "commit_required" });
      let full: string;
      try { full = git(target.repo, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`]); }
      catch (err) { rethrowPending(err); throw Object.assign(new InboxError(400, `no commit ${commit} in ${basename(target.repo)}: pass the SHA of the fix you pushed to ${target.branch}`), { code: "commit_unknown" }); }
      return { ...target, commit: full, landed: this.onBranch(target, full) };
    }, { decide: requestFingerprint(["page-comment-fixed", teamId, commit]) });
  }

  /**
   * The team's integration branch, read as its pipeline reads it: the repository its pipeline is bound to, else the one
   * every checkout of the team is in; its orchestrator.json `integrationBranch` (dev when unnamed, never main or
   * master), published as `origin/<branch>` (the local branch only in a repository with no remotes). Null without one.
   */
  private integration(teamId: string, state: WorldState): Integration | null {
    const team = state.teams.find((t) => t.id === teamId);
    if (!team) return null;
    let bound: string | null = null;
    try { bound = opt((this.db.prepare("SELECT repo_root FROM team_pipelines WHERE team_id = ?").get(teamId) as Row | undefined)?.repo_root); } catch { /* no pipeline table: no binding */ }
    const lead = state.agents.find((a) => a.teamId === teamId && a.role === "lead");
    const paths = bound ? [bound] : team.path ? [team.path] : [...team.worktrees, ...(lead?.cwd ? [lead.cwd] : []), ...state.agents.filter((a) => a.teamId === teamId && a.cwd).map((a) => a.cwd!)];
    const roots = new Set<string>();
    for (const path of paths) { try { roots.add(repository(path).root); } catch (err) { rethrowPending(err); /* not a checkout */ } }
    if (roots.size !== 1) return null;
    const repo = [...roots][0]!;
    const branch = this.adapters.read(repo, basename(repo)).adapter?.integrationBranch ?? "dev";
    if (["main", "master"].includes(branch)) return null;
    return publishedBranch(repo, branch, repo) ? { repo, branch } : null;
  }

  private onBranch(target: Integration, commit: string): boolean {
    const published = publishedBranch(target.repo, target.branch, target.repo);
    return !!published && isAncestor(target.repo, commit, published.tip);
  }

  /** While a comment waits for its fix to land, looks every few seconds; stops when none waits. */
  private watchLandings(): void {
    if (this.landingTimer || this.landingPollMs <= 0 || !this.waitingLandings().length) return;
    this.landingTimer = setInterval(() => {
      try { if (!this.checkLandings()) this.stopWatchingLandings(); }
      catch (err) { console.error(`page comments: ${(err as Error).message}`); this.stopWatchingLandings(); }
    }, this.landingPollMs);
    this.landingTimer.unref?.();
  }
  stopWatchingLandings(): void {
    if (this.landingTimer) clearInterval(this.landingTimer);
    this.landingTimer = null;
  }
  private waitingLandings(): Row[] {
    return this.db.prepare("SELECT id, landing_commit, landing_branch, landing_repo FROM page_comments WHERE status = 'working' AND landing_commit IS NOT NULL").all() as Row[];
  }

  /**
   * Turns fixed each waiting comment whose commit is now on its integration branch, with the same effects as fixed
   * (updatedAt, the page told, the office redrawn). Reads Git through gitcache.ts without blocking: the last facts
   * read, refreshed in the background (no `git fetch`: origin/<branch> moves when a checkout of the repository pushes
   * or fetches). Facts not read yet are read in the background, and the comment is looked at again as soon as they
   * are. Returns how many still wait.
   */
  checkLandings(): number {
    const rows = this.waitingLandings();
    let waiting = rows.length;
    for (const row of rows) {
      const target = { repo: str(row.landing_repo), branch: str(row.landing_branch) };
      const read = () => this.onBranch(target, str(row.landing_commit));
      let landed: boolean;
      if (gitNonblocking()) {
        const look = () => runPass(read, { horizon: null, decide: false });
        const pass = look();
        if (pass.waits.length) {
          void settle(`page-comment-landing:${str(row.id)}`, pass.waits, () => look().waits, () => { try { this.checkLandings(); } catch { /* the next poll looks again */ } });
          continue;
        }
        if ("error" in pass) continue;
        landed = pass.value!;
      } else {
        try { landed = read(); } catch { continue; }
      }
      if (!landed) continue;
      this.db.prepare("UPDATE page_comments SET status = 'fixed', landing_commit = NULL, landing_branch = NULL, landing_repo = NULL, updated_at = ? WHERE id = ? AND status = 'working' AND landing_commit = ?")
        .run(this.now().toISOString(), str(row.id), str(row.landing_commit));
      waiting--;
      this.emit(str(row.id));
    }
    return waiting;
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
      const handed = new Set<string>();
      for (const row of rows) {
        if (handed.has(str(row.id))) continue;
        // A group's queued comments that have no message yet go to the lead together.
        const group = opt(row.group_id);
        if (group && !row.message_id && str(row.status) === "queued") {
          const members = rows.filter((r) => opt(r.group_id) === group && !r.message_id && str(r.status) === "queued");
          for (const m of members) handed.add(str(m.id));
          if (members.length > 1) { this.handOver(members); continue; }
        }
        this.advance(row);
      }
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
    this.handOver([row]);
  }

  /** Gives queued comments (one, or a group) to their team's lead in one message. */
  private handOver(rows: Row[]): void {
    const names = this.teamNames();
    const exhausted = rows.filter((r) => Number(r.attempts) >= MAX_ATTEMPTS);
    for (const r of exhausted) this.update(str(r.id), { status: "failed", note: "its team had nobody to give it to" });
    const live = rows.filter((r) => Number(r.attempts) < MAX_ATTEMPTS);
    if (!live.length) return;
    const comments = live.map((r) => this.toComment(r, names));
    const attempt = Math.max(...live.map((r) => Number(r.attempts))) + 1;
    const key = comments.length === 1 ? comments[0]!.id : `${comments[0]!.groupId}:${requestFingerprint(comments.map((c) => c.id)).slice(0, 12)}`;
    try {
      const message = this.office.instruct(comments[0]!.teamId, {
        text: comments.length === 1 ? this.leadText(comments[0]!) : this.groupText(comments),
        images: [...new Set(comments.flatMap((c) => c.images))],
        clientId: `page-comment:${key}:${attempt}`,
      });
      for (const r of live) this.update(str(r.id), { message_id: message.id, attempts: Number(r.attempts) + 1, note: null });
    } catch (err) {
      const e = err as InboxError;
      for (const r of live) {
        // Nobody on the team yet: it stays queued until someone is.
        if (e.status === 409) this.update(str(r.id), { note: e.message }, false);
        else this.update(str(r.id), { status: "failed", note: e.message || "could not be given to the team" });
      }
    }
  }

  private static readonly CLOSE = "The page that sent it is told of each status, and may edit or withdraw it; an edit or withdrawal reaches you as a follow-up on the same id.";

  /** What the lead reads: the page context, the comment, where to open it, and how to close the loop. */
  private leadText(c: PageComment): string {
    const open = c.openUrl ? `\n\nOpen to check: ${c.openUrl}` : "";
    return `${pageCommentText(c.text, c.page, c.kind)}${open}${this.followsUpText(c)}\n\nPage comment ${c.id}. Say \`inbox comment working ${c.id}\` when you start; when it is fixed, push the fix to the team's integration branch (such as origin/dev) first, then \`inbox comment fixed ${c.id} --commit SHA [--url URL] [--note "…"]\` (it stays working until that commit is on the branch, then turns fixed; --url when the fix is best seen somewhere more specific); if it will not be fixed, \`inbox comment declined ${c.id} --note "why"\`; to ask the page, \`inbox comment ask ${c.id} "question"\`. ${PageComments.CLOSE}`;
  }

  /** What the lead needs of the comment this one follows up: its status, note, commit and where it was fixed. */
  private followsUpText(c: PageComment): string {
    if (!c.followsUp) return "";
    let earlier: PageComment;
    try { earlier = this.get(c.followsUp); } catch { return `\n\nFollows up page comment ${c.followsUp}.`; }
    const facts = [earlier.status, earlier.note ? `note: ${earlier.note}` : null, earlier.commit ? `commit ${earlier.commit}` : null, earlier.openUrl ? `open: ${earlier.openUrl}` : null].filter(Boolean).join("; ");
    return `\n\nFollows up page comment ${earlier.id} (${facts}): “${earlier.text.slice(0, 200)}${earlier.text.length > 200 ? "…" : ""}”`;
  }

  /** A group in one message: each comment with its own id, context and kind, then how to close each. */
  private groupText(comments: PageComment[]): string {
    const parts = comments.map((c, i) => {
      const head = `${i + 1}. Page comment ${c.id}${c.kind ? ` · ${c.kind}` : ""}`;
      const open = c.openUrl ? `\nOpen to check: ${c.openUrl}` : "";
      return [head, ...pageContextLines(c.page), "", c.text].join("\n") + open + this.followsUpText(c).replace(/^\n\n/, "\n");
    });
    return `[Page comments: ${comments.length} in group ${comments[0]!.groupId}]\n\n${parts.join("\n\n")}\n\nEach keeps its own id and status: \`inbox comment working ID\`, \`inbox comment fixed ID --commit SHA [--url URL] [--note "…"]\` once the fix is pushed to the integration branch (such as origin/dev; each turns fixed when its commit is there), \`inbox comment declined ID --note "why"\`, or \`inbox comment ask ID "question"\`. ${PageComments.CLOSE.replace("sent it", "sent them").replace("edit or withdraw it", "edit or withdraw each")}`;
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

  private row(id: string): Row {
    return this.db.prepare("SELECT * FROM page_comments WHERE id = ?").get(id) as Row;
  }

  private update(id: string, fields: Record<string, string | number | null>, announce = true): void {
    const before = this.row(id);
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
      text: str(r.text), kind: opt(r.kind), groupId: opt(r.group_id), page: JSON.parse(str(r.page) || "{}"), origin: opt(r.origin),
      openUrl: opt(r.fixed_url) ?? opt(r.open_url), meta: r.meta ? JSON.parse(str(r.meta)) : null,
      images: r.images ? JSON.parse(str(r.images)) : [],
      status: str(r.status) as PageCommentStatus, note: opt(r.note), commit: opt(r.commit_sha), by: opt(r.by_name),
      question: opt(r.question), answer: opt(r.answer), revision: Number(r.revision ?? 0),
      followsUp: opt(r.follows_up),
      followUps: (this.db.prepare("SELECT id FROM page_comments WHERE follows_up = ? ORDER BY created_at, rowid").all(str(r.id)) as Row[]).map((x) => str(x.id)),
      verification: opt(r.verification) as CommentVerdict | null, verifiedAt: opt(r.verified_at),
      editable: str(r.status) === "held" || (str(r.status) === "queued" && !r.message_id),
      messageId: opt(r.message_id), attempts: Number(r.attempts),
      landing: str(r.status) === "working" && r.landing_commit ? { commit: str(r.landing_commit), branch: str(r.landing_branch) } : null,
      createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    };
  }
}

const newGroupId = () => `pg-${randomBytes(5).toString("hex")}`;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).origin.toLowerCase(); } catch { return null; }
}
