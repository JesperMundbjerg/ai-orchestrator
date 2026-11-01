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
  /** Upload ids from `POST /api/uploads`. */
  images?: string[];
  /** The same client id returns the first message instead of sending twice. */
  clientId?: string;
}

export interface PageCommentResult {
  messageId: string;
  teamId: string;
  teamName: string;
  /** When the message was first stored; a retry with the same client id answers the same message. */
  createdAt: string;
}

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
  /** A team to preselect when this page origin has no remembered choice. */
  defaultTeamId?: string;
  /** PNG/JPEG/GIF/WebP data URLs the widget uploads and attaches (at most 8). */
  screenshots?: string[];
}

/** Widget → host page. `ready` goes to any origin (it carries nothing); the rest only to an allowed origin. */
export type EmbedOutMessage =
  | { type: "office-comment:ready"; version: 1 }
  | { type: "office-comment:sent"; version: 1; messageId: string; teamId: string; teamName: string }
  | { type: "office-comment:resize"; version: 1; height: number }
  | { type: "office-comment:error"; version: 1; error: string };

/** A host message the widget accepts: from an allowed origin and well formed; null otherwise. */
export function acceptEmbedMessage(origin: string, data: unknown, allowlist: readonly string[]): { page: PageContext; defaultTeamId?: string; screenshots: string[] } | null {
  if (!pageOriginAllowed(origin, allowlist)) return null;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "office-comment:context" || d.version !== EMBED_VERSION) return null;
  const page = cleanPageContext(d.page);
  // A page speaks for itself: a url on another origin than the sender's is dropped.
  if (page.url) {
    try { if (new URL(page.url).origin.toLowerCase() !== origin.toLowerCase()) delete page.url; } catch { delete page.url; }
  }
  const screenshots = Array.isArray(d.screenshots)
    ? d.screenshots.filter((s): s is string => typeof s === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(s)).slice(0, 8)
    : [];
  const defaultTeamId = typeof d.defaultTeamId === "string" && /^[\w-]{1,64}$/.test(d.defaultTeamId) ? d.defaultTeamId : undefined;
  return { page, ...(defaultTeamId ? { defaultTeamId } : {}), screenshots };
}
