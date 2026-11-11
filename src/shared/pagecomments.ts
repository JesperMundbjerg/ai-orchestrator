// Page comments: the founder comments from any web page to any team. This is the stable,
// vendor-neutral contract shared by the service, the embeddable widget and pages that host it.
// Pure: no I/O, so the origin allowlist and the rendering are tested directly.

/** Where on a page a comment was made. Every field is optional and trimmed to a short size. */
export interface PageContext {
  url?: string;
  title?: string;
  /** A CSS selector for the element the comment is about. */
  selector?: string;
  /** An anchor or fragment id on the page. */
  anchor?: string;
  /** The text the founder had selected. */
  selectedText?: string;
  /** A short note on the viewport, e.g. "390x844 phone". */
  viewport?: string;
}

/** A team a page can address, as `GET /api/page-comments/teams` lists it. */
export interface PageTeam {
  id: string;
  name: string;
  purpose: string;
  status: "blocked" | "working" | "idle" | "offline";
  lead: { name: string; online: boolean } | null;
  /** A lead is on the team and online now; a comment to a team without one waits in its queue. */
  leadPresent: boolean;
}

export interface PageCommentInput {
  text?: string;
  page?: PageContext;
  /** Where the page should go to show the fix (http/https); the fixer's `--url` overrides it. */
  openUrl?: string;
  /** Page-specific fields the office stores and hands back untouched (a JSON object, at most 2 KB). */
  meta?: Record<string, unknown>;
  /** Upload ids from `POST /api/uploads`. */
  images?: string[];
  /** The same client id returns the first message instead of sending twice. */
  clientId?: string;
  /** Comments with the same group id reach the lead together. With `hold`, it waits (held) until the group is sent; without, a held group is sent with it. */
  groupId?: string;
  /** Hold it in its group (a new one when no group id is given) until `POST /api/page-comments/groups/:id/send`. */
  hold?: boolean;
  /** An earlier comment this one follows up (e.g. it is still wrong after that fix); the lead sees that comment's note, commit and URL. */
  followsUp?: string;
  /** A free triage word the page chooses (e.g. bug, copy, idea, unsure), shown to the lead; at most 40 characters. */
  kind?: string;
}

/** What a page may change on a comment it sent. Before the office hands it to the lead it changes in place; after, the lead gets the change as a follow-up. */
export interface PageCommentEdit {
  text?: string;
  kind?: string;
  openUrl?: string;
  meta?: Record<string, unknown>;
}

/**
 * held while it waits in an unsent group; queued → delivered → working → fixed | declined; asked while the lead waits for the page's answer
 * (answered → working); withdrawn when the page takes it back; failed when it cannot be delivered.
 */
export const PAGE_COMMENT_STATUSES = ["held", "queued", "delivered", "working", "asked", "fixed", "declined", "withdrawn", "failed"] as const;
export type PageCommentStatus = (typeof PAGE_COMMENT_STATUSES)[number];
/** What the fixer may set: the rest is the office's own delivery state. */
export const AGENT_COMMENT_STATUSES = ["working", "fixed", "declined"] as const;
export type AgentCommentStatus = (typeof AGENT_COMMENT_STATUSES)[number];
/** The founder's check of a fixed comment: verified, or still wrong (which reopens the same comment for another attempt). */
export const COMMENT_VERDICTS = ["verified", "still-wrong"] as const;
export type CommentVerdict = (typeof COMMENT_VERDICTS)[number];
/** What a list can select a fixed comment by: `none` is fixed and not judged yet, the rest are the founder's verdicts. */
export const COMMENT_VERIFICATION_FILTERS = ["none", ...COMMENT_VERDICTS] as const;
export type CommentVerificationFilter = (typeof COMMENT_VERIFICATION_FILTERS)[number];

/** Parses `verification=none,still-wrong`; returns an error message for an unknown or empty value, else the distinct values. */
export function parseVerificationFilter(raw: string): CommentVerificationFilter[] | string {
  const parts = raw.split(",").map((s) => s.trim());
  const bad = parts.find((p) => !(COMMENT_VERIFICATION_FILTERS as readonly string[]).includes(p));
  if (bad !== undefined) return `unknown verification "${bad}": use ${COMMENT_VERIFICATION_FILTERS.join(", ")} (comma-separated)`;
  return [...new Set(parts as CommentVerificationFilter[])];
}

/** Nothing moves a comment out of these. */
export const CLOSED_COMMENT_STATUSES: readonly PageCommentStatus[] = ["fixed", "declined", "withdrawn"];

/**
 * Nobody has anything left to do on it: withdrawn, declined, or fixed and checked by the founder. A still-wrong verdict
 * reopens the comment (working again), so only an old one — from before reopening, whose follow-up comment carries on —
 * is fixed with that verdict. A fixed comment still waiting for the check is not done.
 */
export function isDoneComment(c: { status: PageCommentStatus; verification: CommentVerdict | null }): boolean {
  return c.status === "withdrawn" || c.status === "declined" || (c.status === "fixed" && c.verification !== null);
}
export const KIND_MAX = 40;
/** The suggestions the widget offers; any short word is accepted. */
export const SUGGESTED_KINDS: readonly string[] = ["bug", "copy", "idea", "unsure"];

/** A triage kind as stored: one short line, or undefined. */
export function cleanKind(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, KIND_MAX) : undefined;
}

/** An earlier attempt at a comment that the founder sent back as still wrong, kept when the comment reopened. */
export interface PageCommentAttempt {
  /** The fix commit that attempt named, if any. */
  commit: string | null;
  /** The fixer's note on that attempt. */
  note: string | null;
  /** The fixer's --url for that attempt, if any. */
  url: string | null;
  fixedAt: string | null;
  by: string | null;
  verdict: "still-wrong";
  /** What the founder said was still wrong (it went to the team as the new instruction). */
  verdictNote: string | null;
  judgedAt: string;
}

/** The founder let a release go without this comment: when, and why if he said. */
export interface PageCommentRelease {
  at: string;
  note: string | null;
}

/** A page comment the office queues, delivers and tracks until it is fixed or declined. */
export interface PageComment {
  id: string;
  teamId: string;
  teamName: string;
  text: string;
  /** The page's triage kind, if it gave one. */
  kind: string | null;
  /** Comments queued together share a group id and reach the lead in one message; each keeps its own id and status. */
  groupId: string | null;
  page: PageContext;
  /** The page origin it was made on (from its url or openUrl), for filtering; null when neither is given. */
  origin: string | null;
  /** Where to open the fix: the fixer's url when given, else the page's own openUrl. */
  openUrl: string | null;
  meta: Record<string, unknown> | null;
  images: string[];
  status: PageCommentStatus;
  /** The fixer's note (required to decline), or why delivery failed. */
  note: string | null;
  commit: string | null;
  /** The lead's last question about it (status "asked" until the page answers). */
  question: string | null;
  /** The page's (or the founder's) answer to that question. */
  answer: string | null;
  /** Who set the last working/fixed/declined status or asked, by office name; null for the office or the founder. */
  by: string | null;
  /** How many times the page edited it. */
  revision: number;
  /** The earlier comment this one follows up (comments made before still-wrong reopened the same comment). */
  followsUp: string | null;
  /** Later comments that follow this one up, oldest first. */
  followUps: string[];
  /** The founder's check once it is fixed: null until checked. */
  verification: CommentVerdict | null;
  verifiedAt: string | null;
  /** Earlier attempts the founder found still wrong, oldest first; the comment reopened after each. */
  history: PageCommentAttempt[];
  /** The founder released without it (it left the awaiting list until it turns fixed again); null otherwise. */
  releasedWithout: PageCommentRelease | null;
  /** The office has not handed it to the lead yet, so an edit or withdraw changes it in place. */
  editable: boolean;
  /** The office message that carried it to the lead (the latest one when it was sent again). */
  messageId: string | null;
  /** How many times the office has given it to the team. */
  attempts: number;
  /** Marked fixed with a commit its team's integration branch does not have yet: it stays working until the
   * commit is on that branch (`origin/<branch>`), then turns fixed. Null otherwise. */
  landing: { commit: string; branch: string } | null;
  /** When it turned fixed (a direct fix, or its waiting landing reaching the branch); null while it is not fixed.
   * Unlike updatedAt, verification and other edits never move it. */
  fixedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a page hears when a comment changes: the event the SSE stream and the widget relay carry. */
export interface PageCommentEvent {
  id: string;
  teamId: string;
  teamName: string;
  groupId: string | null;
  status: PageCommentStatus;
  text: string;
  kind: string | null;
  openUrl: string | null;
  note: string | null;
  commit: string | null;
  question: string | null;
  answer: string | null;
  by: string | null;
  revision: number;
  editable: boolean;
  followsUp: string | null;
  followUps: string[];
  verification: CommentVerdict | null;
  verifiedAt: string | null;
  history: PageCommentAttempt[];
  releasedWithout: PageCommentRelease | null;
  meta: Record<string, unknown> | null;
  /** When it turned fixed (see PageComment.fixedAt); null while it is not fixed. */
  fixedAt: string | null;
  updatedAt: string;
}

export const commentEvent = (c: PageComment): PageCommentEvent => ({
  id: c.id, teamId: c.teamId, teamName: c.teamName, groupId: c.groupId, status: c.status, text: c.text, kind: c.kind,
  openUrl: c.openUrl, note: c.note, commit: c.commit, question: c.question, answer: c.answer, by: c.by,
  revision: c.revision, editable: c.editable, followsUp: c.followsUp, followUps: c.followUps,
  verification: c.verification, verifiedAt: c.verifiedAt, history: c.history, releasedWithout: c.releasedWithout, meta: c.meta, fixedAt: c.fixedAt, updatedAt: c.updatedAt,
});

export const META_MAX_BYTES = 2048;
export const COMMENT_ID = /^pc-[0-9a-f]{10}$/;
export const GROUP_ID = /^pg-[0-9a-f]{10}$/;
/** At most this many comments in one group. */
export const GROUP_MAX = 20;

export const PAGE_CONTEXT_LIMITS: Readonly<Record<keyof PageContext, number>> = {
  url: 500, title: 160, selector: 240, anchor: 120, selectedText: 600, viewport: 160,
};

/** The page origins that may host the widget when the founder has not set any: local dev servers. */
export const DEFAULT_PAGE_ORIGINS: readonly string[] = ["http://localhost:*", "http://127.0.0.1:*"];

/** `scheme://host`, `scheme://host:port` or `scheme://host:*` (CSP source syntax, so it doubles as frame-ancestors). */
const ORIGIN_PATTERN = /^(https?):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:]+\])(?::(\d{1,5}|\*))?$/;

/** A pattern the founder may allow, normalized to lower case; null when it is not one. */
export function normalizeOriginPattern(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\/+$/, "");
  const m = ORIGIN_PATTERN.exec(v);
  if (!m) return null;
  if (m[3] && m[3] !== "*" && (Number(m[3]) < 1 || Number(m[3]) > 65535)) return null;
  return v;
}

/**
 * Is a message's origin (a browser's `event.origin`, exactly `scheme://host[:port]`) on the
 * allowlist? `*` matches any port, including none. Anything else — `null`, paths, other
 * schemes, a host that only ends with an allowed one — is refused.
 */
export function pageOriginAllowed(origin: string, allowlist: readonly string[]): boolean {
  if (typeof origin !== "string") return false;
  const m = /^(https?):\/\/([^/:?#]+|\[[^\]/]+\])(?::(\d+))?$/.exec(origin.toLowerCase());
  if (!m) return false;
  const [, scheme, host, port] = m;
  for (const entry of allowlist) {
    const p = /^(https?):\/\/(.+?)(?::(\d+|\*))?$/.exec(entry);
    if (!p || p[1] !== scheme || p[2] !== host) continue;
    if (p[3] === "*") return true;
    if ((p[3] ?? null) === (port ?? null)) return true;
  }
  return false;
}

const clip = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Only known fields, as one-line strings within their limits; unknown fields are dropped. */
export function cleanPageContext(input: unknown): PageContext {
  if (!input || typeof input !== "object") return {};
  const out: PageContext = {};
  for (const key of Object.keys(PAGE_CONTEXT_LIMITS) as Array<keyof PageContext>) {
    const v = clip((input as Record<string, unknown>)[key], PAGE_CONTEXT_LIMITS[key]);
    if (v) out[key] = v;
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) delete out.url;
  return out;
}

/** The page context as short lines: where (title and url), at what (element, anchor, viewport), and the selection. */
export function pageContextLines(context: PageContext): string[] {
  const page = cleanPageContext(context);
  const lines: string[] = [];
  const where = [page.title ? `"${page.title}"` : null, page.url ?? null].filter(Boolean).join(" ");
  if (where) lines.push(`On ${where}`);
  const at = [page.selector ? `element ${page.selector}` : null, page.anchor ? `#${page.anchor.replace(/^#/, "")}` : null, page.viewport ? `viewport ${page.viewport}` : null].filter(Boolean);
  if (at.length) lines.push(`At: ${at.join(" · ")}`);
  if (page.selectedText) lines.push(`Selected: "${page.selectedText}"`);
  return lines;
}

/** The message text the lead reads: a header naming it a page comment (and its kind), the compact context, then the comment. */
export function pageCommentText(text: string, context: PageContext, kind?: string | null): string {
  const head = [kind ? `[Page comment · ${kind}]` : "[Page comment]", ...pageContextLines(context)].join("\n");
  const body = text.trim();
  return body ? `${head}\n\n${body}` : head;
}

// The postMessage contract between a host page and the widget at /embed/comment.
export const EMBED_PROTOCOL = "office-comment";
export const EMBED_VERSION = 1;

/** Host page → widget. Sent after the widget's `ready`, and again whenever the context changes. */
export interface EmbedContextMessage {
  type: "office-comment:context";
  version: 1;
  page?: PageContext;
  /** Where the page should go to show the fix; on the host's own origin, else dropped. */
  openUrl?: string;
  /** Page-specific fields handed back untouched with every status event. */
  meta?: Record<string, unknown>;
  /** A triage kind to preselect in the widget. */
  kind?: string;
  /** A team to preselect when this page origin has no remembered choice. */
  defaultTeamId?: string;
  /** PNG/JPEG/GIF/WebP data URLs the widget uploads and attaches (at most 8). */
  screenshots?: string[];
}

/** One comment a host page sends in a group through the widget (the widget adds its own page context to each). */
export interface EmbedGroupItem {
  text: string;
  kind?: string;
  page?: PageContext;
  openUrl?: string;
  meta?: Record<string, unknown>;
}

/**
 * Host page → widget: act on this page's own comments. `requestId` comes back on the matching
 * `office-comment:result`. Edit, withdraw and answer only reach comments made on the host's origin.
 */
export type EmbedActionMessage =
  | { type: "office-comment:edit"; version: 1; requestId?: string; id: string } & PageCommentEdit
  | { type: "office-comment:withdraw"; version: 1; requestId?: string; id: string; note?: string }
  | { type: "office-comment:answer"; version: 1; requestId?: string; id: string; text: string }
  | { type: "office-comment:verify"; version: 1; requestId?: string; id: string; verdict: CommentVerdict; note?: string }
  | { type: "office-comment:send-group"; version: 1; requestId?: string; teamId?: string; clientId?: string; comments: EmbedGroupItem[] };

/** Host page → widget: relay status events for this page origin's comments (all of them, or only these ids). */
export interface EmbedWatchMessage {
  type: "office-comment:watch";
  version: 1;
  ids?: string[];
}

/** Widget → host page. `ready` goes to any origin (it carries nothing); the rest only to the accepted host origin. */
export type EmbedOutMessage =
  | { type: "office-comment:ready"; version: 1 }
  | { type: "office-comment:sent"; version: 1; id: string; teamId: string; teamName: string; status: PageCommentStatus }
  | ({ type: "office-comment:status"; version: 1 } & PageCommentEvent)
  | { type: "office-comment:resize"; version: 1; height: number }
  | { type: "office-comment:result"; version: 1; requestId: string | null; action: "edit" | "withdraw" | "answer" | "verify" | "send-group"; ok: true; comments: PageCommentEvent[] }
  | { type: "office-comment:result"; version: 1; requestId: string | null; action: "edit" | "withdraw" | "answer" | "verify" | "send-group"; ok: false; error: string }
  | { type: "office-comment:error"; version: 1; error: string };

export type AcceptedEmbedMessage =
  | { type: "context"; page: PageContext; openUrl?: string; meta?: Record<string, unknown>; kind?: string; defaultTeamId?: string; screenshots: string[] }
  | { type: "watch"; ids: string[] | null }
  | { type: "edit"; requestId: string | null; id: string; edit: PageCommentEdit }
  | { type: "withdraw"; requestId: string | null; id: string; note?: string }
  | { type: "answer"; requestId: string | null; id: string; text: string }
  | { type: "verify"; requestId: string | null; id: string; verdict: CommentVerdict; note?: string }
  | { type: "send-group"; requestId: string | null; teamId?: string; clientId?: string; comments: Array<{ text: string; kind?: string; page: PageContext; openUrl?: string; meta?: Record<string, unknown> }> };

const sameOrigin = (url: string, origin: string): boolean => {
  try { return new URL(url).origin.toLowerCase() === origin.toLowerCase(); } catch { return false; }
};

/** A JSON object of at most META_MAX_BYTES, or undefined. */
export function cleanMeta(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > META_MAX_BYTES) return undefined;
  return JSON.parse(json) as Record<string, unknown>;
}

/** A host message the widget accepts: from an allowed origin and well formed; null otherwise. */
export function acceptEmbedMessage(origin: string, data: unknown, allowlist: readonly string[]): AcceptedEmbedMessage | null {
  if (!pageOriginAllowed(origin, allowlist)) return null;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.version !== EMBED_VERSION) return null;
  if (d.type === "office-comment:watch") {
    const ids = Array.isArray(d.ids) ? d.ids.filter((id): id is string => typeof id === "string" && COMMENT_ID.test(id)).slice(0, 200) : null;
    return { type: "watch", ids };
  }
  const requestId = typeof d.requestId === "string" && d.requestId.length <= 100 ? d.requestId : null;
  const id = typeof d.id === "string" && COMMENT_ID.test(d.id) ? d.id : null;
  const words = (v: unknown): string | undefined => (typeof v === "string" && v.trim() && v.length <= 6000 ? v : undefined);
  // A page speaks for itself: a url on another origin than the sender's is dropped.
  const ownPage = (v: unknown): PageContext => {
    const page = cleanPageContext(v);
    if (page.url && !sameOrigin(page.url, origin)) delete page.url;
    return page;
  };
  const ownUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//i.test(v) && v.length <= 1000 && sameOrigin(v, origin) ? v : undefined);
  const kind = cleanKind(d.kind);
  if (d.type === "office-comment:edit") {
    if (!id) return null;
    const edit: PageCommentEdit = {};
    const text = words(d.text); const openUrl = ownUrl(d.openUrl); const meta = cleanMeta(d.meta);
    if (text) edit.text = text;
    if (kind) edit.kind = kind;
    if (openUrl) edit.openUrl = openUrl;
    if (meta) edit.meta = meta;
    return { type: "edit", requestId, id, edit };
  }
  if (d.type === "office-comment:withdraw") {
    if (!id) return null;
    const note = words(d.note);
    return { type: "withdraw", requestId, id, ...(note ? { note } : {}) };
  }
  if (d.type === "office-comment:answer") {
    const text = words(d.text);
    return id && text ? { type: "answer", requestId, id, text } : null;
  }
  if (d.type === "office-comment:verify") {
    const verdict = (COMMENT_VERDICTS as readonly unknown[]).includes(d.verdict) ? d.verdict as CommentVerdict : null;
    const note = words(d.note);
    return id && verdict ? { type: "verify", requestId, id, verdict, ...(note ? { note } : {}) } : null;
  }
  if (d.type === "office-comment:send-group") {
    if (!Array.isArray(d.comments) || !d.comments.length || d.comments.length > GROUP_MAX) return null;
    const comments: Array<{ text: string; kind?: string; page: PageContext; openUrl?: string; meta?: Record<string, unknown> }> = [];
    for (const raw of d.comments as unknown[]) {
      const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const text = words(c.text);
      if (!text) return null;
      const k = cleanKind(c.kind); const openUrl = ownUrl(c.openUrl); const meta = cleanMeta(c.meta);
      comments.push({ text, page: ownPage(c.page), ...(k ? { kind: k } : {}), ...(openUrl ? { openUrl } : {}), ...(meta ? { meta } : {}) });
    }
    const teamId = typeof d.teamId === "string" && /^[\w-]{1,64}$/.test(d.teamId) ? d.teamId : undefined;
    const clientId = typeof d.clientId === "string" && d.clientId.length <= 100 ? d.clientId : undefined;
    return { type: "send-group", requestId, ...(teamId ? { teamId } : {}), ...(clientId ? { clientId } : {}), comments };
  }
  if (d.type !== "office-comment:context") return null;
  const page = ownPage(d.page);
  const openUrl = ownUrl(d.openUrl);
  const meta = cleanMeta(d.meta);
  const screenshots = Array.isArray(d.screenshots)
    ? d.screenshots.filter((s): s is string => typeof s === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(s)).slice(0, 8)
    : [];
  const defaultTeamId = typeof d.defaultTeamId === "string" && /^[\w-]{1,64}$/.test(d.defaultTeamId) ? d.defaultTeamId : undefined;
  return { type: "context", page, ...(openUrl ? { openUrl } : {}), ...(meta ? { meta } : {}), ...(kind ? { kind } : {}), ...(defaultTeamId ? { defaultTeamId } : {}), screenshots };
}
