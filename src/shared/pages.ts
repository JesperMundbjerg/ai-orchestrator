// A walkthrough: the live pages an agent lines up for you to go through in order, each with what
// to look at. It is how an agent shows what it did in the app itself, one page after the next.

import type { Page } from "./types.ts";

/** More than this is a tour nobody finishes; split it into items. */
export const MAX_PAGES = 20;

/**
 * The compact form agents write on the command line: "Label=URL", or a bare URL. The label ends
 * at the first "=" that comes before "://", so a query string in the URL stays whole.
 */
export function parsePage(text: string): Partial<Page> {
  const s = text.trim();
  const scheme = s.indexOf("://");
  const at = s.indexOf("=");
  if (at <= 0 || (scheme >= 0 && at > scheme)) return { url: s };
  return { label: s.slice(0, at).trim(), url: s.slice(at + 1).trim() };
}

/** Why a page URL cannot be shown, or null when it can: only http(s) is ever framed. */
export function pageUrlProblem(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : `must be http(s): ${url}`;
}

/** What a page is called where it has no label: its path, or its host for the root. */
export function pageName(page: Page): string {
  if (page.label) return page.label;
  try {
    const u = new URL(page.url);
    return u.pathname === "/" ? u.host : `${u.pathname}${u.search}`;
  } catch {
    return page.url;
  }
}

/**
 * Whether a page's response lets the office show it in a frame, from its X-Frame-Options and
 * Content-Security-Policy headers. A frame-ancestors directive, when present, is what browsers
 * follow; otherwise X-Frame-Options is. Nothing said means it can be framed.
 */
export function frameAllowed(headers: { xFrameOptions: string | null; csp: string | null }, pageOrigin: string, officeOrigin: string): boolean {
  const directive = (headers.csp ?? "")
    .split(/[,;]/)
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name?.toLowerCase() === "frame-ancestors");
  if (directive) {
    return directive.slice(1).some((source) => {
      const s = source.toLowerCase();
      if (s === "'none'") return false;
      if (s === "*") return true;
      if (s === "'self'") return pageOrigin === officeOrigin;
      return sourceMatches(s, officeOrigin);
    });
  }
  const xfo = headers.xFrameOptions?.trim().toLowerCase();
  if (xfo === "deny") return false;
  if (xfo === "sameorigin") return pageOrigin === officeOrigin;
  return true;
}

/** A CSP host source ("http:", "127.0.0.1:*", "https://*.example.com") against an origin. */
function sourceMatches(source: string, origin: string): boolean {
  const o = new URL(origin);
  if (/^[a-z][a-z0-9+.-]*:$/.test(source)) return o.protocol === source;
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?/.exec(source);
  if (!m) return false;
  const [, scheme, host, port] = m;
  if (scheme && `${scheme}:` !== o.protocol) return false;
  const hostOk = host!.startsWith("*.") ? o.hostname.endsWith(host!.slice(1)) : o.hostname === host;
  const defaultPort = o.protocol === "https:" ? "443" : "80";
  const portOk = port === "*" || (port ?? defaultPort) === (o.port || defaultPort);
  return hostOk && portOk;
}
