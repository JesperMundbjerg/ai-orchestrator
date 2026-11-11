// The service's HTTP surface: UI endpoints, the agent protocol, a server-sent change stream,
// evidence files and the built UI. It binds to loopback; mutations must be JSON from this
// origin, which keeps unrelated websites (and DNS-rebinding hosts) from driving it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { frameAllowed, inlineProblem, ownAppPage } from "../shared/pages.ts";
import type { AgentModel, PageCheck, SessionInput, SubmitInput } from "../shared/types.ts";
import {
  agentOperations as protocol, emptySchema, ValidationError, type Schema, type ApiErrorBody,
} from "../shared/agent-protocol.ts";
import * as validation from "./request-validation.ts";
import { claudeHookEvents, claudeModel } from "./activity.ts";
import { Inbox, InboxError } from "./inbox.ts";
import { answerWithGit } from "./gitcache.ts";
import { sendEvidence } from "./evidence.ts";
import { projectQueue } from "./queue.ts";
import { UPLOAD_BODY_LIMIT } from "./uploads.ts";
import type { AutoApprove } from "./autoapprove.ts";
import type { Herdr } from "./herdr.ts";
import type { Machine } from "./machine.ts";
import type { StallWatch } from "./stallwatch.ts";
import type { StandingLanes } from "./standing.ts";
import type { Switches } from "./switch.ts";
import type { Leases } from "./leases.ts";
import { leaseSchemas } from "./leases-protocol.ts";
import type { Usage } from "./usage.ts";
import type { World } from "./world.ts";
import { InputLog, inputLogBatchSchema } from "./inputlog.ts";
import { commentAnswerSchema, commentAskSchema, commentEditSchema, commentReleaseSchema, commentStatusSchema, commentVerifySchema, commentWithdrawSchema, pageCommentGroupSchema, pageCommentSchema, pageOriginsSchema, type PageComments } from "./pagecomments.ts";
import { COMMENT_ID, commentEvent, parseVerificationFilter, type CommentVerificationFilter } from "../shared/pagecomments.ts";
import { pipelineSchemas, waiverSchemas, overrideSchema, layoutSchema, deliveryHandoffSchema, deliveryReviewSchema, pipelineSubmitSchema, telemetryQuery, telemetryReportSchema } from "./pipelines/protocol.ts";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

type Handler = (req: IncomingMessage, body: unknown, params: string[]) => unknown | Promise<unknown>;
type Route = [method: string, pattern: RegExp, handler: Handler];
function route<T>(method: string, pattern: RegExp, schema: Schema<T>, handler: (req: IncomingMessage, body: T, params: string[]) => unknown | Promise<unknown>): Route {
  return [method, pattern, (req, body, params) => handler(req, schema.parse(body), params)];
}

export function createInboxServer(inbox: Inbox, herdr: Herdr | null, opts: { port: number; staticDir: string | null; world?: World; machine?: Machine; stalls?: StallWatch; switches?: Switches; usage?: Usage; autoApprove?: AutoApprove; standing?: StandingLanes; leases?: Leases; pageComments?: PageComments; inputLog?: InputLog }): Server {
  const inputLog = opts.inputLog ?? new InputLog();
  const clients = new Set<ServerResponse>();
  const broadcast = (reason: string) => {
    for (const res of clients) res.write(`event: changed\ndata: ${JSON.stringify({ reason })}\n\n`);
  };
  const world = opts.world;
  // Whatever changes in the inbox or in herdr may free an agent for an instruction or block a team.
  const react = () => {
    void world?.react().catch((err: Error) => console.error(`office: ${err.message}`));
    // A delivery done or a lead back may move a page comment on.
    try { opts.pageComments?.sync(); } catch (err) { console.error(`page comments: ${(err as Error).message}`); }
  };
  if (opts.pageComments) opts.pageComments.onChange = () => broadcast("page-comments");
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
  // Browsers coming, going or needing a look change only what is drawn; so does a usage meter.
  if (opts.machine) opts.machine.onChange = () => broadcast("machine");
  if (opts.usage) opts.usage.onChange = () => broadcast("usage");
  if (opts.standing) opts.standing.onChange = () => broadcast("lanes");
  if (opts.leases) opts.leases.onChange = () => broadcast("lease");
  if (herdr) {
    herdr.onChange = () => {
      broadcast("presence");
      react();
    };
  }

  // A page that will not show inline is said at submit time, not discovered by the founder.
  const submitWithWarnings = (req: IncomingMessage, body: SubmitInput & { pipeline?: { runId: string } }) => {
    const actor = body.pipeline ? needWorld().resolve(body.session) : null;
    const snapshot = actor && body.pipeline ? needWorld().pipelines.presentation(actor, body.pipeline.runId) : null;
    // The run binding commits with the item, so approve-all already sees that a pipeline needs the founder's own acceptance.
    const bind = actor && body.pipeline ? (r: { itemId: string; revision: number }) => needWorld().pipelines.bindItem(actor, body.pipeline!.runId, r.itemId, r.revision) : undefined;
    const result = inbox.submit(snapshot ? { ...body, item: { ...body.item, context: [body.item.context, snapshot].filter(Boolean).join("\n\n") } } : body, bind);
    const origin = `http://${req.headers.host ?? "localhost"}`;
    const warnings = inbox.item(result.itemId).pages.map((p) => inlineProblem(p.url, origin)).filter((w): w is string => w !== null);
    return warnings.length ? { ...result, warnings } : result;
  };

  const routes: Route[] = [
    // UI
    route("GET", /^\/api\/state$/, emptySchema, () => inbox.state()),
    route("GET", /^\/api\/auto-approve$/, emptySchema, () => needAutoApprove().state()),
    route("POST", /^\/api\/auto-approve$/, validation.autoApproveSchema, (_r, b) => needAutoApprove().setEnabled(b.enabled)),
    route("GET", /^\/api\/items\/([\w-]+)$/, emptySchema, (_r, _b, [id]) => inbox.detail(id!)),
    route("POST", /^\/api\/items\/([\w-]+)\/replies$/, validation.answerSchema, (_r, b, [id]) => inbox.answer(id!, b)),
    route("POST", /^\/api\/items\/([\w-]+)\/snooze$/, validation.snoozeSchema, (_r, b, [id]) => inbox.snooze(id!, b.until)),
    route("POST", /^\/api\/items\/([\w-]+)\/back-of-queue$/, emptySchema, (_r, _b, [id]) => inbox.backOfQueue(id!)),
    route("POST", /^\/api\/items\/([\w-]+)\/resolve$/, emptySchema, (_r, _b, [id]) => inbox.resolve(id!)),
    route("GET", /^\/api\/items\/([\w-]+)\/preview-check$/, emptySchema, (_r, _b, [id]) => checkPreview(inbox.item(id!).preview?.url)),
    route("GET", /^\/api\/items\/([\w-]+)\/pages\/(\d+)\/check$/, emptySchema, (r, _b, [id, n]) => checkPreview(inbox.item(id!).pages[Number(n)]?.url, `http://${r.headers.host ?? "localhost"}`)),
    route("POST", /^\/api\/replies\/([\w-]+)\/retry$/, emptySchema, (_r, _b, [id]) => inbox.retry(id!)),
    route("PATCH", /^\/api\/tasks\/([\w-]+)$/, validation.taskPatchSchema, (_r, b, [id]) => inbox.updateTask(id!, pickTaskPatch(b))),
    route("POST", /^\/api\/tasks\/([\w-]+)\/open$/, emptySchema, async (_r, _b, [id]) => {
      const task = inbox.task(id!);
      if (!herdr || !task.presence) throw new InboxError(409, "this session is not open in herdr, so it cannot be brought to the front");
      await herdr.focus(task.presence.paneId);
      return { ok: true };
    }),
    route("POST", /^\/api\/projects\/([\w-]+)\/pin$/, validation.pinSchema, (_r, b, [id]) => inbox.setPinned(id!, b.pinned)),
    // An image you paste or drop, as base64 JSON (so the same-origin JSON guard holds); answers and messages name it by id.
    route("POST", /^\/api\/uploads$/, validation.uploadSchema, (_r, b) => inbox.uploads.save(b)),
    // The office world
    route("GET", /^\/api\/world$/, emptySchema, () => needWorld().state()),
    route("GET", /^\/api\/p\/([a-z][a-z0-9-]*)\/queue$/, emptySchema, (_r, _b, [project]) => projectQueue(needWorld().state(), project!, opts.standing?.registered)),
    // Standing lanes whose project declares an attach command: checked when read, recovered only when asked.
    route("GET", /^\/api\/lanes$/, emptySchema, () => needStanding().list()),
    route("POST", /^\/api\/p\/([a-z][a-z0-9-]*)\/lanes\/([\w-]+)\/check$/, emptySchema, (_r, _b, [project, lane]) => needStanding().check(project!, lane!)),
    route("POST", /^\/api\/p\/([a-z][a-z0-9-]*)\/lanes\/([\w-]+)\/recover$/, validation.laneRecoverSchema, (_r, b, [project, lane]) => needStanding().recover(project!, lane!, b.agentId)),
    route("POST", /^\/api\/world\/teams$/, validation.teamCreateSchema, (_r, b) => needWorld().createTeam(b)),
    route("PATCH", /^\/api\/world\/teams\/([\w-]+)$/, validation.teamPatchSchema, (_r, b, [id]) => needWorld().updateTeam(id!, b)),
    route("DELETE", /^\/api\/world\/teams\/([\w-]+)$/, validation.teamDeleteSchema, (_r, b, [id]) => needWorld().deleteTeam(id!, b)),
    // A team's other worktrees (lanes), and folding a project into another; neither touches anything on disk.
    route("GET", /^\/api\/world\/teams\/([\w-]+)\/worktrees$/, emptySchema, (_r, _b, [id]) => needWorld().worktrees(id!)),
    route("POST", /^\/api\/world\/teams\/([\w-]+)\/worktrees$/, validation.worktreeSchema, (_r, b, [id]) => needWorld().addWorktree(id!, b.path)),
    route("POST", /^\/api\/world\/teams\/([\w-]+)\/worktrees\/remove$/, validation.worktreeSchema, (_r, b, [id]) => needWorld().removeWorktree(id!, b.path)),
    route("GET", /^\/api\/world\/teams\/([\w-]+)\/pipeline\/palette$/, emptySchema, (_r, _b, [id]) => needWorld().pipelines.palette(id!)),
    route("GET", /^\/api\/world\/teams\/([\w-]+)\/pipeline$/, emptySchema, (_r, _b, [id]) => needWorld().pipelines.teamView(id!)),
    route("PUT", /^\/api\/world\/teams\/([\w-]+)\/pipeline$/, overrideSchema, (_r, b, [id]) => needWorld().pipelines.saveOverride(id!, b)),
    route("PUT", /^\/api\/world\/teams\/([\w-]+)\/pipeline\/layout$/, layoutSchema, (_r, b, [id]) => needWorld().pipelines.saveLayout(id!, b)),
    route("POST", /^\/api\/agent\/unlanded$/, validation.unlandedSchema, (_r, b) => unlanded(needWorld(), b)),
    route("POST", /^\/api\/agent\/pipeline\/start$/, pipelineSchemas.start, (_r, b) => needWorld().pipelines.start(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/branch$/, pipelineSchemas.branch, (_r, b) => needWorld().pipelines.branch(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/abandon$/, pipelineSchemas.abandon, (_r, b) => needWorld().pipelines.abandon(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/assign$/, pipelineSchemas.assign, (_r, b) => needWorld().pipelines.assign(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/report$/, pipelineSchemas.report, (_r, b) => needWorld().pipelines.report(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/done$/, pipelineSchemas.done, (_r, b) => needWorld().pipelines.done(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/status$/, pipelineSchemas.status, (_r, b) => needWorld().pipelines.status(needWorld().resolve(b.session), b.runId)),
    // Read-only delivery telemetry (gate results, integration, publication, decision waits); never authorizes.
    route("GET", /^\/api\/pipeline\/telemetry$/, emptySchema, (r) => needWorld().pipelines.telemetry.read(telemetryQuery(new URL(r.url ?? "/", "http://localhost").searchParams))),
    route("POST", /^\/api\/agent\/pipeline\/telemetry\/log$/, telemetryReportSchema, (_r, b) => needWorld().pipelines.reportTelemetry(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/gate$/, pipelineSchemas.gate, (_r, b) => needWorld().pipelines.gate(needWorld().resolve(b.session), b)),
    // Founder-only exact-SHA repair waivers: the request becomes one inbox decision; the gate answers a delivery that names no run.
    route("POST", /^\/api\/agent\/pipeline\/waiver$/, waiverSchemas.request, (_r, b) => needWorld().waivers.request(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/pipeline\/waiver\/gate$/, waiverSchemas.gate, (_r, b) => needWorld().waivers.gate(needWorld().resolve(b.session), b)),
    route("GET", /^\/api\/world\/teams\/([\w-]+)\/pipeline\/waivers$/, emptySchema, (_r, _b, [id]) => needWorld().waivers.list(needWorld().pipelines.teamView(id!).repoRoot)),
    // The office-run capture lease: one per repository, FIFO; the caller is resolved by session, the repository from its checkout.
    route("POST", /^\/api\/agent\/lease\/acquire$/, leaseSchemas.acquire, (_r, b) => needLeases().acquire(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd, run: b.run, reason: b.reason })),
    route("POST", /^\/api\/agent\/lease\/release$/, leaseSchemas.release, (_r, b) => needLeases().release(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd })),
    route("POST", /^\/api\/agent\/lease\/leave$/, leaseSchemas.leave, (_r, b) => needLeases().leave(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd })),
    route("POST", /^\/api\/agent\/lease\/renew$/, leaseSchemas.renew, (_r, b) => needLeases().renew(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd })),
    route("POST", /^\/api\/agent\/lease\/status$/, leaseSchemas.status, (_r, b) => needLeases().status(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd })),
    route("POST", /^\/api\/agent\/lease\/revoke$/, leaseSchemas.revoke, (_r, b) => needLeases().revoke(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd, reason: b.reason, holder: b.holder })),
    route("POST", /^\/api\/agent\/lease\/capacity$/, leaseSchemas.capacity, (_r, b) => needLeases().setCapacity(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd, capacity: b.capacity })),
    route("POST", /^\/api\/agent\/lease\/limit$/, leaseSchemas.limit, (_r, b) => needLeases().limit(needWorld().resolve(b.session), { resource: b.resource, path: b.repo ?? b.session.cwd, minutes: b.minutes })),
    route("GET", /^\/api\/world\/teams\/([\w-]+)\/lease$/, emptySchema, (_r, _b, [id]) => ({ lease: needLeases().forTeam(id!) })),
    route("POST", /^\/api\/world\/teams\/([\w-]+)\/merge$/, validation.mergeSchema, (_r, b, [id]) => needWorld().mergeTeam(id!, b.into)),
    route("POST", /^\/api\/world\/all-leads\/messages$/, validation.allLeadsSchema, (_r, b) => needWorld().messages.tellAllLeads(b)),
    route("POST", /^\/api\/world\/teams\/([\w-]+)\/messages$/, validation.messageSchema, (_r, b, [id]) => needWorld().messages.instruct(id!, b)),
    route("POST", /^\/api\/world\/messages\/([\w-]+)\/deliveries\/([\w-]+)\/retry$/, emptySchema, (_r, _b, [message, agent]) => needWorld().messages.retry(message!, agent!)),
    route("POST", /^\/api\/world\/agents\/([\w-]+)\/effort$/, validation.setEffortSchema, (_r, b, [id]) => needWorld().setEffort(id!, b.level)),
    route("PATCH", /^\/api\/world\/agents\/([\w-]+)$/, validation.agentPatchSchema, (_r, b, [id]) => needWorld().updateAgent(id!, b)),
    route("DELETE", /^\/api\/world\/agents\/([\w-]+)$/, emptySchema, (_r, _b, [id]) => (needWorld().removeAgent(id!), { removed: id })),
    route("POST", /^\/api\/world\/agents\/([\w-]+)\/messages$/, validation.messageSchema, (_r, b, [id]) => needWorld().messages.tell(id!, b)),
    // The founder's crew tree: which harness and model a lead picks for each crew member.
    route("GET", /^\/api\/world\/crew-tree$/, emptySchema, () => needWorld().crewTree().state()),
    route("PUT", /^\/api\/world\/crew-tree$/, validation.crewTreeSchema, (_r, b) => needWorld().crewTree().save(b)),
    // Moving agents to another harness: one, or everyone on a harness one by one; each reports its progress.
    route("GET", /^\/api\/world\/switches$/, emptySchema, () => needSwitches().list()),
    route("POST", /^\/api\/world\/switches$/, protocol.switchAgent.request, (_r, b) => needSwitches().start(b.agent, b)),
    route("POST", /^\/api\/world\/switches\/all-from$/, protocol.switchAll.request, (_r, b) => needSwitches().allFrom(b.from, b)),
    route("GET", /^\/api\/world\/switches\/((?!all-from$)[\w-]+)$/, emptySchema, (_r, _b, [id]) => needSwitches().get(id!)),
    // What agents left running on the machine; Close is refused for anything but a listed headless browser.
    route("GET", /^\/api\/machine$/, emptySchema, () => needMachine().state()),
    // The blocks of the office's own event loop, with what ran during each.
    route("GET", /^\/api\/machine\/stalls$/, emptySchema, () => needStalls().state()),
    route("POST", /^\/api\/machine\/browsers\/(\d+)\/close$/, emptySchema, (_r, _b, [pid]) => needMachine().close(Number(pid))),
    // Page comments: any page's comment to a team the office lists, by id; the founder's allowlist of hosting pages.
    route("GET", /^\/api\/page-comments\/teams$/, emptySchema, () => needPageComments().teams()),
    route("POST", /^\/api\/page-comments\/teams\/([\w-]+)\/comments$/, pageCommentSchema, (_r, b, [id]) => needPageComments().enqueue(id!, b)),
    route("GET", /^\/api\/page-comments$/, emptySchema, (r) => needPageComments().list(commentFilter(r))),
    route("GET", /^\/api\/page-comments\/(pc-[0-9a-f]+)$/, emptySchema, (_r, _b, [id]) => needPageComments().get(id!)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/status$/, commentStatusSchema, (_r, b, [id]) => needPageComments().setStatus(id!, b)),
    route("POST", /^\/api\/page-comments\/teams\/([\w-]+)\/groups$/, pageCommentGroupSchema, (_r, b, [id]) => needPageComments().enqueueGroup(id!, b)),
    route("POST", /^\/api\/page-comments\/groups\/(pg-[0-9a-f]+)\/send$/, emptySchema, (_r, _b, [id]) => needPageComments().sendGroup(id!)),
    route("POST", /^\/api\/page-comments\/groups\/(pg-[0-9a-f]+)\/discard$/, emptySchema, (_r, _b, [id]) => needPageComments().discardGroup(id!)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/edit$/, commentEditSchema, (_r, b, [id]) => needPageComments().edit(id!, b)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/withdraw$/, commentWithdrawSchema, (_r, b, [id]) => needPageComments().withdraw(id!, b)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/ask$/, commentAskSchema, (_r, b, [id]) => needPageComments().ask(id!, b)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/answer$/, commentAnswerSchema, (_r, b, [id]) => needPageComments().answer(id!, b)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/verify$/, commentVerifySchema, (_r, b, [id]) => needPageComments().verify(id!, b)),
    route("POST", /^\/api\/page-comments\/(pc-[0-9a-f]+)\/release-without$/, commentReleaseSchema, (_r, b, [id]) => needPageComments().releaseWithout(id!, b)),
    route("GET", /^\/api\/page-comments\/awaiting$/, emptySchema, (r) => needPageComments().awaiting(awaitingFilter(r))),
    route("GET", /^\/api\/page-comments\/origins$/, emptySchema, () => needPageComments().origins()),
    route("PUT", /^\/api\/page-comments\/origins$/, pageOriginsSchema, (_r, b) => needPageComments().setOrigins(b)),
    // Agent protocol
    route("POST", /^\/api\/agent\/items$/, pipelineSubmitSchema, (r, b) => submitWithWarnings(r, b)),
    route("POST", /^\/api\/agent\/activity$/, protocol.activity.request, (_r, b) => inbox.activity(b)),
    route("POST", /^\/api\/agent\/replies$/, protocol.replies.request, (_r, b) => inbox.pendingReplies(b.session, b.mode ?? "pull")),
    // Agent protocol: the office
    route("POST", /^\/api\/agent\/team$/, protocol.team.request, (_r, b) => needWorld().brief(b.session)),
    route("POST", /^\/api\/agent\/pane$/, protocol.pane.request, (_r, b) => needWorld().paneOpened(b.session, b.paneId)),
    route("POST", /^\/api\/agent\/worktree$/, protocol.worktree.request, (_r, b) => needWorld().openWorktree(b.session, b.slug)),
    // A session outside herdr (a Claude Code desktop session): known without a task, and a project it leads itself.
    route("POST", /^\/api\/agent\/hello$/, protocol.hello.request, (_r, b) => needWorld().hello(b.session)),
    route("POST", /^\/api\/agent\/team\/create$/, protocol.createTeam.request, (_r, b) => needWorld().createDesktopTeam(b.session, b)),
    route("POST", /^\/api\/agent\/crew$/, protocol.crew.request, () => ({ text: needWorld().crewTree().text() })),
    route("POST", /^\/api\/agent\/say$/, protocol.say.request, (_r, b) => needWorld().messages.say(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/events$/, protocol.events.request, (_r, b) => needWorld().report(b.session, b.events ?? [])),
    // A plan's limits as a harness was told them in a reply's headers (Claude Code's statusline, Pi's Codex replies).
    route("POST", /^\/api\/agent\/usage$/, protocol.usage.request, (_r, b) => {
      if (!opts.usage) throw new InboxError(404, "this service does not keep usage");
      return { changed: opts.usage.record(b.provider, b.limits, b.provider === "claude" ? "statusline" : "pi-headers") };
    }),
    route("POST", /^\/api\/agent\/effort$/, protocol.effort.request, (_r, b) => needWorld().pollEffort(b.session, b.report)),
    // Claude Code's HTTP hook posts its hook input as is. Valid input answers {}: no decision.
    route("POST", /^\/api\/hooks\/claude$/, validation.claudeHookSchema, (_r, b) => {
      if (world && typeof b.session_id === "string") {
        const { events, helperId } = claudeHookEvents(b);
        // A turn's end, or a session the office has no model for yet, is when the transcript is read.
        const modelFor = !helperId ? (known: AgentModel | null) => (!known || b.hook_event_name === "Stop" || typeof b.model === "string" ? claudeModel(b) : null) : undefined;
        world.report({ harness: "claude", sessionId: b.session_id, cwd: typeof b.cwd === "string" ? b.cwd : undefined }, events, helperId, modelFor);
      }
      return {};
    }),
    route("POST", /^\/api\/agent\/handoff$/, deliveryHandoffSchema, (_r, b) => needWorld().messages.handoff(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/review$/, deliveryReviewSchema, (_r, b) => needWorld().messages.review(needWorld().resolve(b.session), b)),
    route("POST", /^\/api\/agent\/ack$/, protocol.acknowledge.request, (_r, b) => inbox.acknowledge(b.session, b.deliveryId, b.error)),
    route("POST", /^\/api\/agent\/messages$/, protocol.messages.request, (_r, b) => needWorld().collectMessages(b.session, b.mode ?? "pull")),
    route("POST", /^\/api\/agent\/messages\/ack$/, protocol.acknowledgeMessage.request, (_r, b) => needWorld().acknowledgeMessage(b.session, b.deliveryId, b.error)),
    route("POST", /^\/api\/agent\/withdraw$/, protocol.withdraw.request, (_r, b) => {
      // A waiver request lives on the office's own task, not the asker's: its asker withdraws it by `waiver-<id>` or item id.
      const waiver = world?.waivers.names(b.item) ? world.waivers.withdraw(world.resolve(b.session), b.item) : null;
      return waiver?.itemId ? inbox.item(waiver.itemId) : inbox.closeItem(b.session, b.item, "withdrawn");
    }),
    // Debug: the UI's opt-in input recorder (?inputlog=1); memory only, and only from the office's own page.
    route("GET", /^\/api\/debug\/inputlog$/, emptySchema, () => inputLog.read()),
    route("POST", /^\/api\/debug\/inputlog$/, inputLogBatchSchema, (r, b) => {
      if (!allowedHosts.has(String(r.headers.origin ?? "").replace(/^https?:\/\//, ""))) throw new InboxError(403, "the input log takes batches only from the office's own page");
      return inputLog.add(b.events);
    }),
    route("POST", /^\/api\/agent\/resolve$/, protocol.resolve.request, (_r, b) => inbox.closeItem(b.session, b.item, "resolved")),
  ];

  function needAutoApprove(): AutoApprove {
    if (!opts.autoApprove) throw new InboxError(404, "this service has no approve-all setting");
    return opts.autoApprove;
  }

  /** `inbox unlanded`: the caller is the agent its session resolves to; the rules are the watch's (unlanded.ts). */
  function unlanded(w: World, b: { session: SessionInput; action: "list" | "hold" | "release"; reason?: string; path?: string }) {
    const me = w.resolve(b.session);
    if (b.action === "list") return w.unlanded.answer(me);
    const answer = b.action === "hold" ? w.unlanded.hold(me, b.reason ?? "", b.path) : w.unlanded.release(me, b.path);
    w.onChange("world");
    return answer;
  }

  function needWorld(): World {
    if (!world) throw new InboxError(404, "this service runs without the office world");
    return world;
  }

  function needSwitches(): Switches {
    if (!opts.switches) throw new InboxError(404, "this service cannot switch agents between harnesses");
    return opts.switches;
  }

  function needStanding(): StandingLanes {
    if (!opts.standing) throw new InboxError(404, "this service does not check standing lanes");
    return opts.standing;
  }

  function needLeases(): Leases {
    if (!opts.leases) throw new InboxError(404, "this service runs no capture leases");
    return opts.leases;
  }

  function needPageComments(): PageComments {
    if (!opts.pageComments) throw new InboxError(404, "this service takes no page comments");
    return opts.pageComments;
  }

  function needMachine(): Machine {
    if (!opts.machine) throw new InboxError(404, "this service does not watch the machine");
    return opts.machine;
  }

  function needStalls(): StallWatch {
    if (!opts.stalls) throw new InboxError(404, "this service does not watch its own event loop");
    return opts.stalls;
  }

  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);

  return createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) throw new InboxError(403, "unexpected Host header");
      let url: URL;
      try { url = new URL(req.url ?? "/", "http://localhost"); }
      catch { throw new ValidationError("url", "invalid request URL"); }
      const method = req.method ?? "GET";
      const allowed = new Set(routes.filter(([, pattern]) => pattern.test(url.pathname)).map(([m]) => m));
      if (url.pathname === "/api/events" || url.pathname === "/api/page-comments/events") allowed.add("GET");
      if (/^\/api\/pipeline\/evidence\/([\w-]+)$/.test(url.pathname)) { allowed.add("GET"); allowed.add("HEAD"); }
      if (/^\/files\/([\w-]+)$/.test(url.pathname)) { allowed.add("GET"); allowed.add("HEAD"); }
      if (/^\/uploads\/([\w.-]+)$/.test(url.pathname)) allowed.add("GET");
      if (!allowed.size && opts.staticDir && !url.pathname.startsWith("/api/")) allowed.add("GET");
      if (allowed.size && !allowed.has(method)) {
        res.setHeader("allow", [...allowed].join(", "));
        throw new InboxError(405, `method ${method} is not allowed; use ${[...allowed].join(" or ")}`);
      }
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) throw new InboxError(403, "cross-origin request refused");
        if (!/^application\/json(?:\s*;|\s*$)/i.test(String(req.headers["content-type"] ?? ""))) throw new InboxError(415, "send application/json");
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

      // Page-comment status changes, filtered by team, page origin or ids; first the current state of the newest `limit` (50) that match.
      if (url.pathname === "/api/page-comments/events") {
        const comments = needPageComments();
        const filter = commentFilter(req);
        const matches = (c: { id: string; teamId: string; origin: string | null; status: string; verification: string | null }) =>
          (!filter.team || c.teamId === filter.team) && (!filter.origin || c.origin === filter.origin.toLowerCase()) && (!filter.ids?.length || filter.ids.includes(c.id))
          && (!filter.status || c.status === filter.status)
          && (filter.verified === undefined || (c.status === "fixed" && (c.verification === "verified") === filter.verified))
          && (!filter.verification || (c.status === "fixed" && filter.verification.includes((c.verification ?? "none") as CommentVerificationFilter)));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        for (const c of comments.list({ ...filter, limit: Math.min(filter.limit ?? 50, 200) }).comments.reverse()) res.write(`event: comment\ndata: ${JSON.stringify(commentEvent(c))}\n\n`);
        const listener = (event: ReturnType<typeof commentEvent>, c: { id: string; teamId: string; origin: string | null; status: string; verification: string | null }) => {
          if (matches(c)) res.write(`event: comment\ndata: ${JSON.stringify(event)}\n\n`);
        };
        comments.listeners.add(listener);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          comments.listeners.delete(listener);
        });
        return;
      }

      const file = url.pathname.match(/^\/files\/([\w-]+)$/);
      if (file && (method === "GET" || method === "HEAD")) {
        const found = inbox.evidenceFile(file[1]!);
        if (!found || !existsSync(found.path)) throw new InboxError(404, "no such attachment");
        return sendEvidence(req, res, found.path, TYPES[extname(found.path).toLowerCase()] ?? "application/octet-stream");
      }

      const pipelineFile = url.pathname.match(/^\/api\/pipeline\/evidence\/([\w-]+)$/);
      if (pipelineFile && (method === "GET" || method === "HEAD")) {
        const path = needWorld().pipelines.evidenceFile(pipelineFile[1]!);
        if (!existsSync(path)) throw new InboxError(404, "no pipeline attachment");
        return sendEvidence(req, res, path, TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
      }

      const upload = url.pathname.match(/^\/uploads\/([\w.-]+)$/);
      if (upload && method === "GET") {
        const path = inbox.uploads.path(upload[1]!);
        if (!path) throw new InboxError(404, "no such image");
        return sendFile(res, path, { "content-disposition": "inline", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "cache-control": "private, max-age=31536000, immutable" });
      }

      // The page-comment widget, framable only by the page origins the founder allowed.
      if (/^\/embed\/comment(?:\.html)?$/.test(url.pathname) && method === "GET") {
        const path = opts.staticDir ? join(opts.staticDir, "embed", "comment.html") : null;
        if (!path || !existsSync(path)) throw new InboxError(404, "UI not built: run npm run build");
        return sendFile(res, path, needPageComments().embedHeaders());
      }

      for (const [m, pattern, handler] of routes) {
        const match = m === method ? url.pathname.match(pattern) : null;
        if (!match) continue;
        const body = method === "GET" ? {} : await readJson(req, url.pathname === "/api/uploads" ? UPLOAD_BODY_LIMIT : undefined);
        // A request missing Git facts waits briefly for them, then answers "retry" (gitcache.ts): never git on the event loop.
        const out = await answerWithGit(() => handler(req, body, match.slice(1)));
        return sendJson(res, 200, out);
      }

      if (url.pathname.startsWith("/api/")) throw new InboxError(404, "no such endpoint");
      if (opts.staticDir && method === "GET") return serveStatic(res, opts.staticDir, url.pathname);
      throw new InboxError(404, "not found");
    } catch (err) {
      req.resume(); // drain an unread body so a refusal reaches the client instead of a reset
      const status = err instanceof ValidationError ? 400 : err instanceof InboxError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, errorBody(err, status));
    }
  });
}

/** `?team=ID&origin=ORIGIN&ids=a,b&status=S&verified=true|false&verification=none,verified,still-wrong&limit=N` for the page-comment list and stream. */
function awaitingFilter(req: IncomingMessage): { team?: string; origin?: string } {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  return { ...(q.get("team") ? { team: q.get("team")! } : {}), ...(q.get("origin") ? { origin: q.get("origin")! } : {}) };
}

function commentFilter(req: IncomingMessage): { team?: string; origin?: string; ids?: string[]; status?: string; verified?: boolean; verification?: CommentVerificationFilter[]; limit?: number } {
  const q = new URL(req.url ?? "/", "http://localhost").searchParams;
  const ids = q.get("ids")?.split(",").map((s) => s.trim()).filter((s) => COMMENT_ID.test(s));
  const limit = Number(q.get("limit"));
  const verification = q.has("verification") ? parseVerificationFilter(q.get("verification")!) : undefined;
  if (typeof verification === "string") throw new InboxError(400, verification);
  if (verification && q.has("verified")) throw new InboxError(400, "give either verified=true|false or verification=none|verified|still-wrong, not both");
  return {
    ...(q.get("team") ? { team: q.get("team")! } : {}),
    ...(q.get("origin") ? { origin: q.get("origin")! } : {}),
    ...(ids?.length ? { ids: ids.slice(0, 200) } : {}),
    ...(q.get("status") ? { status: q.get("status")! } : {}),
    ...(q.get("verified") === "true" || q.get("verified") === "false" ? { verified: q.get("verified") === "true" } : {}),
    ...(verification ? { verification } : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
  };
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

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
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
    const err = new InboxError(400, "invalid JSON");
    Object.assign(err, { code: "invalid_json" });
    throw err;
  }
}

const ERROR_CODES: Record<number, string> = {
  400: "invalid_request", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
  409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type", 422: "invalid_request",
  500: "internal_error", 502: "upstream_error", 503: "unavailable",
};
function errorBody(err: unknown, status: number): ApiErrorBody {
  if (status === 500) return { error: "internal server error", code: "internal_error" };
  if (err instanceof ValidationError) return { error: err.message, code: "invalid_request", details: err.details };
  // Domain modules can add a more specific code/details without changing the old error string.
  const domain = err as InboxError & { code?: string; details?: ApiErrorBody["details"] };
  return { error: domain.message, code: domain.code ?? ERROR_CODES[status] ?? "request_failed", ...(domain.details ? { details: domain.details } : {}) };
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
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new ValidationError("url", "invalid URL encoding"); }
  const target = normalize(join(dir, decoded));
  const inside = target.startsWith(normalize(dir));
  const file = inside && existsSync(target) && statSync(target).isFile() ? target : null;
  // Only client-side routes fall back to the app shell. A missing asset (anything with a file extension)
  // is a 404: answering index.html there makes a tab from before a rebuild fail on a MIME error.
  if (!file && (pathname.startsWith("/assets/") || extname(decoded))) throw new InboxError(404, `no such file: ${pathname}`);
  const index = join(dir, "index.html");
  const path = file ?? index;
  if (!existsSync(path)) throw new InboxError(404, "UI not built: run npm run build, or use npm run dev");
  // The shell names the current build's hashed chunks, so it must be revalidated on every load.
  sendFile(res, path, path === index ? { "cache-control": "no-cache" } : {});
}
