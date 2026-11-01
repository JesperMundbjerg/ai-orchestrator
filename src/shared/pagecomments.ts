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
}

/** queued → delivered → working → fixed | declined; failed when it cannot be delivered. */
export const PAGE_COMMENT_STATUSES = ["queued", "delivered", "working", "fixed", "declined", "failed"] as const;
export type PageCommentStatus = (typeof PAGE_COMMENT_STATUSES)[number];
/** What the fixer may set: the rest is the office's own delivery state. */
export const AGENT_COMMENT_STATUSES = ["working", "fixed", "declined"] as const;
export type AgentCommentStatus = (typeof AGENT_COMMENT_STATUSES)[number];

/** A page comment the office queues, delivers and tracks until it is fixed or declined. */
export interface PageComment {
  id: string;
  teamId: string;
  teamName: string;
  text: string;
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
  /** Who set the last working/fixed/declined status, by office name; null for the office or the founder. */
  by: string | null;
  /** The office message that carried it to the lead (the latest one when it was sent again). */
  messageId: string | null;
  /** How many times the office has given it to the team. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** What a page hears when a comment changes: the event the SSE stream and the widget relay carry. */
export interface PageCommentEvent {
  id: string;
  teamId: string;
  status: PageCommentStatus;
  openUrl: string | null;
  note: string | null;
  commit: string | null;
  meta: Record<string, unknown> | null;
  updatedAt: string;
}

export const commentEvent = (c: PageComment): PageCommentEvent =>
  ({ id: c.id, teamId: c.teamId, status: c.status, openUrl: c.openUrl, note: c.note, commit: c.commit, meta: c.meta, updatedAt: c.updatedAt });

export const META_MAX_BYTES = 2048;
export const COMMENT_ID = /^pc-[0-9a-f]{10}$/;

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

/** The message text the lead reads: a header naming it a page comment, the compact context, then the comment. */
export function pageCommentText(text: string, context: PageContext): string {
  const head = ["[Page comment]", ...pageContextLines(context)].join("\n");
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
  /** A team to preselect when this page origin has no remembered choice. */
  defaultTeamId?: string;
  /** PNG/JPEG/GIF/WebP data URLs the widget uploads and attaches (at most 8). */
  screenshots?: string[];
}

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
  | { type: "office-comment:error"; version: 1; error: string };

export type AcceptedEmbedMessage =
  | { type: "context"; page: PageContext; openUrl?: string; meta?: Record<string, unknown>; defaultTeamId?: string; screenshots: string[] }
  | { type: "watch"; ids: string[] | null };

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
  if (d.type !== "office-comment:context") return null;
  const page = cleanPageContext(d.page);
  // A page speaks for itself: a url on another origin than the sender's is dropped.
  if (page.url && !sameOrigin(page.url, origin)) delete page.url;
  const openUrl = typeof d.openUrl === "string" && /^https?:\/\//i.test(d.openUrl) && d.openUrl.length <= 1000 && sameOrigin(d.openUrl, origin) ? d.openUrl : undefined;
  const meta = cleanMeta(d.meta);
  const screenshots = Array.isArray(d.screenshots)
    ? d.screenshots.filter((s): s is string => typeof s === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(s)).slice(0, 8)
    : [];
  const defaultTeamId = typeof d.defaultTeamId === "string" && /^[\w-]{1,64}$/.test(d.defaultTeamId) ? d.defaultTeamId : undefined;
  return { type: "context", page, ...(openUrl ? { openUrl } : {}), ...(meta ? { meta } : {}), ...(defaultTeamId ? { defaultTeamId } : {}), screenshots };
}
