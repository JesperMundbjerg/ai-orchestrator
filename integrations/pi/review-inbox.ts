// Review Inbox for Pi: gives the agent `review_submit` / `review_activity` tools, delivers
// the user's replies into this running session (acknowledging each one once Pi has taken it),
// and tells the office which tool the agent is using, which helpers it has running, which model it runs
// and the session's name (Pi's /name, the one in its terminal title), which a project's lane can name it by.
// Install: add this file's absolute path to `extensions` in ~/.pi/agent/settings.json.

import { Type } from "typebox";
import { acknowledge, call, fetchReplies, formatReply } from "../../src/shared/agent-client.ts";
import { lengthHints, SOFT_CAPS } from "../../src/shared/decision.ts";
import { modelLabel } from "../../src/shared/models.ts";
import { projectRoot } from "../../src/shared/project.ts";
import { codexHeaderReadings } from "../../src/shared/usage.ts";
import type { ActivityEvent, EffortReport, ItemType, SessionInput, SubmitResult } from "../../src/shared/types.ts";

// The slice of Pi's extension API this uses (the full types ship with @earendil-works/pi-coding-agent).
interface PiModel { id: string; provider: string; reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Same supported-level rule as Pi's getSupportedThinkingLevels; no runtime SDK dependency here. */
export function thinkingLevels(model: PiModel | undefined): ThinkingLevel[] {
  if (!model) return [...THINKING_LEVELS];
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined));
}
interface PiContext {
  cwd: string;
  model?: PiModel;
  sessionManager: { getSessionFile(): string | undefined };
  isIdle(): boolean;
}
interface PiApi {
  on(event: "session_start" | "session_shutdown" | "agent_end", handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  on(event: "tool_call", handler: (event: { toolName: string; toolCallId: string; input: unknown }, ctx: PiContext) => void): void;
  on(event: "model_select", handler: (event: { model: PiModel }, ctx: PiContext) => void): void;
  on(event: "session_info_changed", handler: (event: { name: string | undefined }, ctx: PiContext) => void): void;
  on(event: "tool_execution_end", handler: (event: { toolName: string; toolCallId: string }, ctx: PiContext) => void): void;
  on(event: "after_provider_response", handler: (event: { status: number; headers: Record<string, string> }, ctx: PiContext) => void): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
  sendUserMessage(text: string, options?: { deliverAs: "steer" | "followUp" }): void;
  getSessionName(): string | undefined;
  getThinkingLevel(): ThinkingLevel;
  setThinkingLevel(level: ThinkingLevel): void;
  on(event: "thinking_level_select", handler: (event: { level: ThinkingLevel }, ctx: PiContext) => void): void;
}

const POLL_MS = 2000;
const BACKOFF_MS = 10_000;

/** The session id is the session FILE'S PATH, not the id in the file's header: replies are addressed to it, so anyone submitting for this agent must use the path too. */
function sessionOf(ctx: PiContext): SessionInput | null {
  const file = ctx.sessionManager.getSessionFile();
  return file ? { harness: "pi", sessionId: file, cwd: ctx.cwd } : null;
}

/** Fire and forget: the office is a view, and a tool call never waits for it. */
function report(ctx: PiContext, ...events: ActivityEvent[]): void {
  const session = sessionOf(ctx);
  // herdr's pane id finds this agent in the office however herdr names the session.
  if (session && events.length) call("/api/agent/events", { session: { ...session, paneId: process.env.HERDR_PANE_ID }, events }, 1500).catch(() => {});
}

/** The model Pi runs, as Pi names it: "anthropic/claude-opus-5-5", shown as "Opus 5.5" like everywhere in the office. */
function modelEvent(model: PiModel | undefined): ActivityEvent[] {
  if (!model?.id) return [];
  return [{ kind: "model", model: { id: `${model.provider}/${model.id}`, label: modelLabel(model.id) } }];
}

/** The session's name as Pi keeps it; none is reported too, so a cleared name is forgotten. */
function nameEvent(name: string | undefined): ActivityEvent[] {
  return [{ kind: "session_name", sessionName: name ?? null }];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function reviewInbox(pi: PiApi): void {
  let timer: NodeJS.Timeout | null = null;
  let generation = 0;
  let effortResult: EffortReport["result"];
  const effortReport = (ctx: PiContext): EffortReport => ({ current: pi.getThinkingLevel(), levels: thinkingLevels(ctx.model), result: effortResult });
  // Replies already handed to Pi: if only the acknowledgement failed, retry that, never the send.
  const sent = new Set<string>();

  pi.registerTool({
    name: "review_submit",
    label: "Review inbox",
    description:
      "Put a result in front of the user in their Review Inbox and get their answer back in this conversation. " +
      "Use at a meaningful point, not for every turn: `decide` for a concrete question with 2-3 options (or none, for an open question the user answers in words: you get \"Answer: <text>\"; one option is refused), " +
      "`try` for a preview the user should interact with (or `pages`, a walkthrough of live pages they step through), `milestone` for an increment to accept or send back. A `try` comes back as \"Approved\" or \"Needs changes\" with a note saying what. " +
      "Write a decision the way an engineer asks a colleague, e.g. title \"Should the tutor cover the slider or push it aside?\", " +
      "request \"I need this to finish the isotope step. Until you answer I'll keep it docked.\", " +
      "options [\"Overlay: tutor covers the right third; slider hidden while it talks\", \"Docked: the stage narrows; everything stays visible\"], " +
      "recommendation \"Docked, because the lesson depends on the slider staying in view\". " +
      "Attach screenshots as evidence. Resubmitting the same key revises the item. The answer arrives later as a user message.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("decide"), Type.Literal("try"), Type.Literal("milestone")]),
      title: Type.String({ description: `For decide, the question itself, ending in "?"; otherwise what this is. About ${SOFT_CAPS.title} characters` }),
      request: Type.Optional(Type.String({ description: `1-2 sentences: what you need from the user and what happens if nobody answers. About ${SOFT_CAPS.request} characters` })),
      context: Type.Optional(Type.String({ description: "Only what matters for choosing or checking, not a report of what you did; a few sentences" })),
      recommendation: Type.Optional(Type.String({ description: "Your pick and the reason for it" })),
      options: Type.Optional(Type.Array(Type.String({ description: "\"Label: consequence in plain words\"" }), { description: "For decide: 2-3 options, or none for an open question answered in words. Never one; a recommendation needs options" })),
      check: Type.Optional(Type.String({ description: "For try: the interaction to perform and the expected behaviour" })),
      preview_url: Type.Optional(Type.String()),
      pages: Type.Optional(Type.Array(
        Type.Object({
          url: Type.String({ description: "http(s) URL of a live page, e.g. http://localhost:3000/sim/isotopes?step=1. Use localhost: dev servers such as Next only answer on localhost, not 127.0.0.1" }),
          label: Type.Optional(Type.String({ description: "Short name, e.g. \"Step 2\"" })),
          look: Type.Optional(Type.String({ description: "What to look at on this page" })),
        }),
        { description: "To show what you did in the app itself: the pages to go through in order. The user sees each live in a frame and presses Next. Works on any type" },
      )),
      viewport: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("phone")])),
      setup: Type.Optional(Type.String()),
      screenshots: Type.Optional(Type.Array(Type.String({ description: "Absolute path of an image to attach" }))),
      videos: Type.Optional(Type.Array(Type.String({ description: "Absolute path of an MP4, WebM or MOV video to attach (up to 200 MB each; browser-supported codecs)" }))),
      key: Type.Optional(Type.String({ description: "Stable id; reuse it to revise this item" })),
      blocking: Type.Optional(Type.Boolean({ description: "true if you are waiting on this answer rather than continuing other work" })),
      task_title: Type.Optional(Type.String({ description: "Name of your overall task, e.g. \"Voice teacher\"" })),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      const session = sessionOf(ctx);
      if (!session) return text("This session is not saved to disk, so the inbox cannot route replies back to it.");
      const result = await call<SubmitResult>("/api/agent/items", {
        session,
        project: projectRoot(ctx.cwd),
        task: p.task_title ? { title: p.task_title } : undefined,
        item: {
          type: p.type as ItemType,
          title: p.title,
          key: p.key,
          request: p.request,
          context: p.context,
          recommendation: p.recommendation,
          options: p.options,
          check: p.check,
          preview: p.preview_url || (p.pages?.length && (p.viewport || p.setup)) ? { url: p.preview_url, viewport: p.viewport ?? null, setup: p.setup ?? "" } : undefined,
          pages: p.pages,
          blocking: p.blocking,
          evidence: [
            ...(p.screenshots ?? []).map((path: string) => ({ path })),
            ...(p.videos ?? []).map((path: string) => ({ path, kind: "video" as const })),
          ],
        },
      });
      const hints = lengthHints({ title: p.title, request: p.request }).map((h) => `\nHint: ${h}`).join("") + (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join("");
      return text((result.changed
        ? `In the review inbox (revision ${result.revision}). The user's answer will arrive in this conversation; carry on with other work unless you are blocked on it.`
        : `Unchanged: the inbox already shows revision ${result.revision} of this item.`) + hints);
    },
  });

  pi.registerTool({
    name: "review_activity",
    label: "Review inbox activity",
    description: "Tell the Review Inbox what you are working on now and what the next milestone is. Call when the objective or next milestone changes, not every turn.",
    parameters: Type.Object({
      activity: Type.String(),
      next_milestone: Type.Optional(Type.String()),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      const session = sessionOf(ctx);
      if (!session) return text("This session is not saved to disk, so the inbox cannot track it.");
      await call("/api/agent/activity", { session, activity: p.activity, nextMilestone: p.next_milestone });
      return text("Activity updated.");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const session = sessionOf(ctx);
    if (!session) return;
    const run = ++generation;
    effortResult = undefined;
    report(ctx, ...modelEvent(ctx.model), ...nameEvent(pi.getSessionName()), { kind: "effort", effort: effortReport(ctx) });
    let reachable = false;
    const poll = async () => {
      let wait = POLL_MS;
      try {
        const control = await call<{ request: { id: string; level: string } | null }>("/api/agent/effort", {
          session: { ...session, paneId: process.env.HERDR_PANE_ID }, report: effortReport(ctx),
        }, 1500).catch(() => ({ request: null })); // Older offices still deliver replies without effort control.
        if (run !== generation) return;
        if (control.request && control.request.id !== effortResult?.id && ctx.isIdle()) {
          const { id, level } = control.request;
          let error: string | undefined;
          try {
            if (!thinkingLevels(ctx.model).includes(level as ThinkingLevel)) throw new Error("This model no longer supports that effort level");
            pi.setThinkingLevel(level as ThinkingLevel);
          } catch (err) { error = (err as Error).message; }
          effortResult = { id, error };
          report(ctx, { kind: "effort", effort: effortReport(ctx) });
        }
        for (const reply of await fetchReplies(session, "live")) {
          if (run !== generation) return;
          if (!sent.has(reply.deliveryId)) {
            try {
              pi.sendUserMessage(formatReply(reply), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
              sent.add(reply.deliveryId);
            } catch (err) {
              await acknowledge(session, reply.deliveryId, `Pi could not take the message: ${(err as Error).message}`);
              continue;
            }
          }
          await acknowledge(session, reply.deliveryId);
        }
        // An office started again keeps nothing in memory: tell it the name and model again.
        if (!reachable) report(ctx, ...modelEvent(ctx.model), ...nameEvent(pi.getSessionName()));
        reachable = true;
      } catch {
        wait = BACKOFF_MS; // the inbox is not running; keep quiet and try again later
        reachable = false;
      }
      if (run !== generation) return;
      timer = setTimeout(poll, wait);
      timer.unref?.();
    };
    void poll();
  });

  pi.on("tool_call", (e, ctx) => report(ctx, { kind: "tool", tool: e.toolName, callId: e.toolCallId, input: (e.input ?? {}) as Record<string, unknown> }));
  pi.on("tool_execution_end", (e, ctx) => report(ctx, { kind: "tool_end", tool: e.toolName, callId: e.toolCallId }));
  // Every turn's end repeats the model and name, so an office started later still learns them.
  pi.on("agent_end", (_e, ctx) => report(ctx, { kind: "idle" }, ...modelEvent(ctx.model), ...nameEvent(pi.getSessionName())));
  pi.on("model_select", (e, ctx) => report(ctx, ...modelEvent(e.model), { kind: "effort", effort: effortReport(ctx) }));
  pi.on("thinking_level_select", (_e, ctx) => report(ctx, { kind: "effort", effort: effortReport(ctx) }));
  pi.on("session_info_changed", (e, ctx) => report(ctx, ...nameEvent(e.name)));

  // Codex says the plan's limits in each reply's headers; the office keeps the latest for its meters.
  let lastLimits = "";
  pi.on("after_provider_response", (e) => {
    const limits = codexHeaderReadings(e.headers ?? {});
    const key = JSON.stringify(limits.map((l) => [l.usedPercent, l.windowMinutes, l.resetsAt]));
    if (!limits.length || key === lastLimits) return;
    lastLimits = key;
    call("/api/agent/usage", { provider: "codex", limits }, 1500).catch(() => { lastLimits = ""; });
  });

  pi.on("session_shutdown", () => {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
  });
}
