// The service's HTTP surface: UI endpoints, the agent protocol, a server-sent change stream,
// evidence files and the built UI. It binds to loopback; mutations must be JSON from this
// origin, which keeps unrelated websites (and DNS-rebinding hosts) from driving it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { frameAllowed, inlineProblem, ownAppPage } from "../shared/pages.ts";
import type { ActivityEvent, ActivityInput, AgentModel, PageCheck, SessionInput, SubmitInput } from "../shared/types.ts";
import { claudeHookEvents, claudeModel } from "./activity.ts";
import { Inbox, InboxError } from "./inbox.ts";
import { sendEvidence } from "./evidence.ts";
import { projectQueue } from "./queue.ts";
import { UPLOAD_BODY_LIMIT } from "./uploads.ts";
import type { Herdr } from "./herdr.ts";
import type { Machine } from "./machine.ts";
import type { World } from "./world.ts";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

type Handler = (req: IncomingMessage, body: any, params: string[]) => unknown | Promise<unknown>;

export function createInboxServer(inbox: Inbox, herdr: Herdr | null, opts: { port: number; staticDir: string | null; world?: World; machine?: Machine }): Server {
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
  // Browsers coming, going or needing a look change only what is drawn.
  if (opts.machine) opts.machine.onChange = () => broadcast("machine");
  if (herdr) {
    herdr.onChange = () => {
      broadcast("presence");
      react();
    };
  }

  // A page that will not show inline is said at submit time, not discovered by the founder.
  const submitWithWarnings = (req: IncomingMessage, body: SubmitInput) => {
    const result = inbox.submit(body);
    const origin = `http://${req.headers.host ?? "localhost"}`;
    const warnings = inbox.item(result.itemId).pages.map((p) => inlineProblem(p.url, origin)).filter((w): w is string => w !== null);
    return warnings.length ? { ...result, warnings } : result;
  };

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
    // An image you paste or drop, as base64 JSON (so the same-origin JSON guard holds); answers and messages name it by id.
    ["POST", /^\/api\/uploads$/, (_r, b) => inbox.uploads.save(b)],
    // The office world
    ["GET", /^\/api\/world$/, () => needWorld().state()],
    ["GET", /^\/api\/p\/([a-z][a-z0-9-]*)\/queue$/, (_r, _b, [project]) => projectQueue(needWorld().state(), project!)],
    ["POST", /^\/api\/world\/teams$/, (_r, b) => needWorld().createTeam(b)],
    ["PATCH", /^\/api\/world\/teams\/([\w-]+)$/, (_r, b, [id]) => needWorld().updateTeam(id!, b)],
    ["DELETE", /^\/api\/world\/teams\/([\w-]+)$/, (_r, _b, [id]) => needWorld().deleteTeam(id!)],
    // A team's other worktrees (lanes), and folding a project into another; neither touches anything on disk.
    ["GET", /^\/api\/world\/teams\/([\w-]+)\/worktrees$/, (_r, _b, [id]) => needWorld().worktrees(id!)],
    ["POST", /^\/api\/world\/teams\/([\w-]+)\/worktrees$/, (_r, b, [id]) => needWorld().addWorktree(id!, b.path)],
    ["POST", /^\/api\/world\/teams\/([\w-]+)\/worktrees\/remove$/, (_r, b, [id]) => needWorld().removeWorktree(id!, b.path)],
    ["POST", /^\/api\/world\/teams\/([\w-]+)\/merge$/, (_r, b, [id]) => needWorld().mergeTeam(id!, b.into)],
    ["POST", /^\/api\/world\/all-leads\/messages$/, (_r, b) => needWorld().messages.tellAllLeads(b)],
    ["POST", /^\/api\/world\/teams\/([\w-]+)\/messages$/, (_r, b, [id]) => needWorld().messages.instruct(id!, b)],
    ["POST", /^\/api\/world\/messages\/([\w-]+)\/deliveries\/([\w-]+)\/retry$/, (_r, _b, [message, agent]) => needWorld().messages.retry(message!, agent!)],
    ["POST", /^\/api\/world\/agents\/([\w-]+)\/effort$/, (_r, b, [id]) => needWorld().setEffort(id!, b.level)],
    ["PATCH", /^\/api\/world\/agents\/([\w-]+)$/, (_r, b, [id]) => needWorld().updateAgent(id!, b)],
    ["DELETE", /^\/api\/world\/agents\/([\w-]+)$/, (_r, _b, [id]) => (needWorld().removeAgent(id!), { removed: id })],
    ["POST", /^\/api\/world\/agents\/([\w-]+)\/messages$/, (_r, b, [id]) => needWorld().messages.tell(id!, b)],
    // The founder's crew tree: which harness and model a lead picks for each crew member.
    ["GET", /^\/api\/world\/crew-tree$/, () => needWorld().crewTree().state()],
    ["PUT", /^\/api\/world\/crew-tree$/, (_r, b) => needWorld().crewTree().save(b)],
    // What agents left running on the machine; Close is refused for anything but a listed headless browser.
    ["GET", /^\/api\/machine$/, () => needMachine().state()],
    ["POST", /^\/api\/machine\/browsers\/(\d+)\/close$/, (_r, _b, [pid]) => needMachine().close(Number(pid))],
    // Agent protocol
    ["POST", /^\/api\/agent\/items$/, (r, b: SubmitInput) => submitWithWarnings(r, b)],
    ["POST", /^\/api\/agent\/activity$/, (_r, b: ActivityInput) => inbox.activity(b)],
    ["POST", /^\/api\/agent\/replies$/, (_r, b: { session: SessionInput; mode?: "live" | "boundary" | "pull" }) => inbox.pendingReplies(b.session, b.mode ?? "pull")],
    // Agent protocol: the office
    ["POST", /^\/api\/agent\/team$/, (_r, b: { session: SessionInput }) => needWorld().brief(b.session)],
    ["POST", /^\/api\/agent\/crew$/, () => ({ text: needWorld().crewTree().text() })],
    ["POST", /^\/api\/agent\/say$/, (_r, b) => needWorld().messages.say(needWorld().resolve(b.session), b)],
    ["POST", /^\/api\/agent\/events$/, (_r, b: { session: SessionInput; events?: ActivityEvent[] }) => needWorld().report(b.session, Array.isArray(b.events) ? b.events : [])],
    ["POST", /^\/api\/agent\/effort$/, (_r, b) => needWorld().pollEffort(b.session, b.report)],
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

  function needMachine(): Machine {
    if (!opts.machine) throw new InboxError(404, "this service does not watch the machine");
    return opts.machine;
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
      if (file && (method === "GET" || method === "HEAD")) {
        const found = inbox.evidenceFile(file[1]!);
        if (!found || !existsSync(found.path)) throw new InboxError(404, "no such attachment");
        return sendEvidence(req, res, found.path, TYPES[extname(found.path).toLowerCase()] ?? "application/octet-stream");
      }

      const upload = url.pathname.match(/^\/uploads\/([\w.-]+)$/);
      if (upload && method === "GET") {
        const path = inbox.uploads.path(upload[1]!);
        if (!path) throw new InboxError(404, "no such image");
        return sendFile(res, path, { "content-disposition": "inline", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, max-age=31536000, immutable" });
      }

      for (const [m, pattern, handler] of routes) {
        const match = m === method ? url.pathname.match(pattern) : null;
        if (!match) continue;
        const body = method === "GET" ? {} : await readJson(req, url.pathname === "/api/uploads" ? UPLOAD_BODY_LIMIT : undefined);
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
 * frame it? Only the item's own http(s) URLs are ever fetched. `framable` is null when unknown,
 * and false for the inbox's own app (`own`), which shows a card instead of itself.
 */
async function checkPreview(url: string | undefined, officeOrigin?: string): Promise<PageCheck> {
  const checkedAt = new Date().toISOString();
  if (!url) throw new InboxError(404, "this item has no such page");
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(4000) });
    await res.body?.cancel();
    const headers = { xFrameOptions: res.headers.get("x-frame-options"), csp: res.headers.get("content-security-policy") };
    const own = officeOrigin ? ownAppPage(url, officeOrigin) : false;
    const framable = officeOrigin ? !own && frameAllowed(headers, new URL(url).origin, officeOrigin) : null;
    return { reachable: res.status < 500, status: res.status, framable, own, checkedAt };
  } catch {
    return { reachable: false, status: null, framable: null, own: false, checkedAt };
  }
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new InboxError(413, limit > 1_000_000 ? "images are limited to 10 MB" : "request body too large");
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
