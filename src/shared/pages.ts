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

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;

/**
 * Whether a page URL is served by the office's own service, so it must get no same-origin
 * rights when framed: agent-supplied files live there (/uploads, /files). The same origin
 * counts, and so does another loopback name for the same port (localhost for 127.0.0.1).
 */
export function onOfficeServer(url: string, officeOrigin: string): boolean {
  try {
    const page = new URL(url);
    const office = new URL(officeOrigin);
    if (page.origin === office.origin) return true;
    return page.protocol === office.protocol && page.port === office.port && LOOPBACK.test(page.hostname) && LOOPBACK.test(office.hostname);
  } catch {
    return false;
  }
}

/**
 * The Review Inbox's own app (the inbox, the office, the board) as a page. It cannot be shown
 * inside itself: the frame has no same-origin rights, so its scripts fail their CORS check and
 * it stays blank. Files and images the service hands out (/files, /uploads) and its API are
 * not the app; they are framed as any other page is.
 */
export function ownAppPage(url: string, officeOrigin: string): boolean {
  if (!onOfficeServer(url, officeOrigin)) return false;
  return !/^\/(files|uploads|api)(\/|$)/.test(new URL(url).pathname);
}

/** What to tell an agent whose page will not show inline, or null when it will. */
export function inlineProblem(url: string, officeOrigin: string): string | null {
  return ownAppPage(url, officeOrigin)
    ? `${url} is the Review Inbox's own page, so the founder cannot walk through it inline; they only get an Open in a new tab button. Line up the app you built instead, or attach a screenshot.`
    : null;
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
