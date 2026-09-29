// The service's HTTP surface: UI endpoints, the agent protocol, a server-sent change stream,
// evidence files and the built UI. It binds to loopback; mutations must be JSON from this
// origin, which keeps unrelated websites (and DNS-rebinding hosts) from driving it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { frameAllowed } from "../shared/pages.ts";
import type { ActivityEvent, ActivityInput, AgentModel, PageCheck, SessionInput, SubmitInput } from "../shared/types.ts";
import { claudeHookEvents, claudeModel } from "./activity.ts";
import { Inbox, InboxError } from "./inbox.ts";
import type { Herdr } from "./herdr.ts";
import type { World } from "./world.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

type Handler = (req: IncomingMessage, body: any, params: string[]) => unknown | Promise<unknown>;

export function createInboxServer(inbox: Inbox, herdr: Herdr | null, opts: { port: number; staticDir: string | null; world?: World }): Server {
  const clients = new Set<ServerResponse>();
  const broadcast = (reason: string) => {
    for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ reason })}\n\n`);
  };
  const world = opts.world;
  // Whatever changes in the inbox or in herdr may free an agent for an instruction or block a team.
  const react = () => void world?.react().catch((err: Error) => console.error(`office: ${err.message}`));
  inbox.onChange = (reason) => {
    broadcast(reason);
    react();
  };
  // A new message, a lead picked or a delivery done may each free the next delivery.
  if (world) {
    world.onChange = (reason) => {
      broadcast(reason);
      if (reason !== "activity") react();
    };
  }
  if (herdr) {
    herdr.onChange = () => {
      broadcast("presence");
      react();
    };
  }

  const routes: Array<[string, RegExp, Handler]> = [
    // UI
    ["GET", /^\/api\/state$/, () => inbox.state()],
    ["GET", /^\/api\/items\/([\w-]+)$/, (_r, _b, [id]) => inbox.detail(id!)],
    ["POST", /^\/api\/items\/([\w-]+)\/replies$/, (_r, b, [id]) => inbox.answer(id!, b)],
    ["POST", /^\/api\/items\/([\w-]+)\/snooze$/, (_r, b, [id]) => inbox.snooze(id!, b.until)],
    ["POST", /^\/api\/items\/([\w-]+)\/resolve$/, (_r, _b, [id]) => inbox.resolve(id!)],
    ["GET", /^\/api\/items\/([\w-]+)\/preview-check$/, (_r, _b, [id]) => checkPreview(inbox.item(id!).preview?.url)],
    ["GET", /^\/api\/items\/([\w-]+)\/pages\/(\d+)\/check$/, (r, _b, [id, n]) => checkPreview(inbox.item(id!).pages[Number(n)]?.url, `http://${r.headers.host ?? "localhost"}`)],
    ["POST", /^\/api\/replies\/([\w-]+)\/retry$/, (_r, _b, [id]) => inbox.retry(id!)],
    ["PATCH", /^\/api\/tasks\/([\w-]+)$/, (_r, b, [id]) => inbox.updateTask(id!, pickTaskPatch(b))],
    ["POST", /^\/api\/tasks\/([\w-]+)\/open$/, async (_r, _b, [id]) => {
      const task = inbox.task(id!);
      if (!herdr || !task.presence) throw new InboxError(409, "this session is not open in herdr, so it cannot be brought to the front");
      await herdr.focus(task.presence.paneId);
      return { ok: true };
    }],
    ["POST", /^\/api\/projects\/([\w-]+)\/pin$/, (_r, b, [id]) => inbox.setPinned(id!, Boolean(b.pinned))],
    // The office world
    ["GET", /^\/api\/world$/, () => needWorld().state()],
    ["POST", /^\/api\/world\/teams$/, (_r, b) => needWorld().createTeam(b)],
    ["PATCH", /^\/api\/world\/teams\/([\w-]+)$/, (_r, b, [id]) => needWorld().updateTeam(id!, b)],
    ["DELETE", /^\/api\/world\/teams\/([\w-]+)$/, (_r, _b, [id]) => needWorld().deleteTeam(id!)],
    ["POST", /^\/api\/world\/teams\/([\w-]+)\/messages$/, (_r, b, [id]) => needWorld().messages.instruct(id!, b)],
    ["POST", /^\/api\/world\/messages\/([\w-]+)\/deliveries\/([\w-]+)\/retry$/, (_r, _b, [message, agent]) => needWorld().messages.retry(message!, agent!)],
    ["PATCH", /^\/api\/world\/agents\/([\w-]+)$/, (_r, b, [id]) => needWorld().updateAgent(id!, b)],
    ["DELETE", /^\/api\/world\/agents\/([\w-]+)$/, (_r, _b, [id]) => (needWorld().removeAgent(id!), { removed: id })],
    ["POST", /^\/api\/world\/agents\/([\w-]+)\/messages$/, (_r, b, [id]) => needWorld().messages.tell(id!, b)],
    // Agent protocol
    ["POST", /^\/api\/agent\/items$/, (_r, b: SubmitInput) => inbox.submit(b)],
    ["POST", /^\/api\/agent\/activity$/, (_r, b: ActivityInput) => inbox.activity(b)],
    ["POST", /^\/api\/agent\/replies$/, (_r, b: { session: SessionInput; mode?: "live" | "boundary" | "pull" }) => inbox.pendingReplies(b.session, b.mode ?? "pull")],
    // Agent protocol: the office
    ["POST", /^\/api\/agent\/team$/, (_r, b: { session: SessionInput }) => needWorld().brief(b.session)],
    ["POST", /^\/api\/agent\/say$/, (_r, b) => needWorld().messages.say(needWorld().resolve(b.session), b)],
    ["POST", /^\/api\/agent\/events$/, (_r, b: { session: SessionInput; events?: ActivityEvent[] }) => needWorld().report(b.session, Array.isArray(b.events) ? b.events : [])],
    // Claude Code's HTTP hook posts its hook input as is. Always answers {}: no decision, never in the way.
    ["POST", /^\/api\/hooks\/claude$/, (_r, b: Record<string, unknown>) => {
      if (world && typeof b.session_id === "string") {
        const { events, helperId } = claudeHookEvents(b);
        // A turn's end, or a session the office has no model for yet, is when the transcript is read.
        const modelFor = !helperId ? (known: AgentModel | null) => (!known || b.hook_event_name === "Stop" || typeof b.model === "string" ? claudeModel(b) : null) : undefined;
        world.report({ harness: "claude", sessionId: b.session_id, cwd: typeof b.cwd === "string" ? b.cwd : undefined }, events, helperId, modelFor);
      }
      return {};
    }],
    ["POST", /^\/api\/agent\/handoff$/, (_r, b) => needWorld().messages.handoff(needWorld().resolve(b.session), b)],
    ["POST", /^\/api\/agent\/review$/, (_r, b) => needWorld().messages.review(needWorld().resolve(b.session), b)],
    ["POST", /^\/api\/agent\/ack$/, (_r, b: { session: SessionInput; deliveryId: string; error?: string }) => inbox.acknowledge(b.session, b.deliveryId, b.error)],
    ["POST", /^\/api\/agent\/withdraw$/, (_r, b: { session: SessionInput; item: string }) => inbox.closeItem(b.session, b.item, "withdrawn")],
    ["POST", /^\/api\/agent\/resolve$/, (_r, b: { session: SessionInput; item: string }) => inbox.closeItem(b.session, b.item, "resolved")],
  ];

  function needWorld(): World {
    if (!world) throw new InboxError(404, "this service runs without the office world");
    return world;
  }

  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) throw new InboxError(403, "unexpected Host header");
      const method = req.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) throw new InboxError(403, "cross-origin request refused");
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new InboxError(415, "send application/json");
      }

      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }

      const file = url.pathname.match(/^\/files\/([\w-]+)$/);
      if (file && method === "GET") {
        const found = inbox.evidenceFile(file[1]!);
        if (!found || !existsSync(found.path)) throw new InboxError(404, "no such attachment");
        return sendFile(res, found.path, { "content-disposition": "inline", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" });
      }

      for (const [m, pattern, handler] of routes) {
        const match = m === method ? url.pathname.match(pattern) : null;
        if (!match) continue;
        const body = method === "GET" ? {} : await readJson(req);
        const out = await handler(req, body, match.slice(1));
        return sendJson(res, 200, out);
      }

      if (url.pathname.startsWith("/api/")) throw new InboxError(404, "no such endpoint");
      if (opts.staticDir && method === "GET") return serveStatic(res, opts.staticDir, url.pathname);
      throw new InboxError(404, "not found");
    } catch (err) {
      req.resume(); // drain an unread body so a refusal reaches the client instead of a reset
      const status = err instanceof InboxError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function pickTaskPatch(b: Record<string, unknown>) {
  const out: Record<string, string | boolean> = {};
  for (const key of ["title", "objective", "activity", "nextMilestone", "lastDecision", "lastAcceptedMilestone"] as const) {
    if (typeof b[key] === "string") out[key] = b[key];
  }
  if (typeof b.parked === "boolean") out.parked = b.parked;
  return out;
}

/**
 * Is the item's preview, or one of its pages, answering right now, and will it let the office
 * frame it? Only the item's own http(s) URLs are ever fetched. `framable` is null when unknown.
 */
async function checkPreview(url: string | undefined, officeOrigin?: string): Promise<PageCheck> {
  const checkedAt = new Date().toISOString();
  if (!url) throw new InboxError(404, "this item has no such page");
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4000) });
    await res.body?.cancel();
    const headers = { xFrameOptions: res.headers.get("x-frame-options"), csp: res.headers.get("content-security-policy") };
    const framable = officeOrigin ? frameAllowed(headers, new URL(url).origin, officeOrigin) : null;
    return { reachable: res.status < 500, status: res.status, framable, checkedAt };
  } catch {
    return { reachable: false, status: null, framable: null, checkedAt };
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new InboxError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InboxError(400, "invalid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, path: string, headers: Record<string, string> = {}): void {
  res.writeHead(200, { "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "content-length": statSync(path).size, ...headers });
  createReadStream(path).pipe(res);
}

function serveStatic(res: ServerResponse, dir: string, pathname: string): void {
  const target = normalize(join(dir, decodeURIComponent(pathname)));
  const inside = target.startsWith(normalize(dir));
  const path = inside && existsSync(target) && statSync(target).isFile() ? target : join(dir, "index.html");
  if (!existsSync(path)) throw new InboxError(404, "UI not built: run npm run build, or use npm run dev");
  sendFile(res, path);
}
