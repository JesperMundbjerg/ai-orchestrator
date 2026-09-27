// Review Inbox for Pi: gives the agent `review_submit` / `review_activity` tools and delivers
// the user's replies into this running session, acknowledging each one once Pi has taken it.
// Install: add this file's absolute path to `extensions` in ~/.pi/agent/settings.json.

import { Type } from "typebox";
import { acknowledge, call, fetchReplies, formatReply } from "../../src/shared/agent-client.ts";
import { projectRoot } from "../../src/shared/project.ts";
import type { ItemType, SessionInput, SubmitResult } from "../../src/shared/types.ts";

// The slice of Pi's extension API this uses (the full types ship with @earendil-works/pi-coding-agent).
interface PiContext {
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined };
  isIdle(): boolean;
}
interface PiApi {
  on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
  sendUserMessage(text: string, options?: { deliverAs: "steer" | "followUp" }): void;
}

const POLL_MS = 2000;
const BACKOFF_MS = 10_000;

function sessionOf(ctx: PiContext): SessionInput | null {
  const file = ctx.sessionManager.getSessionFile();
  return file ? { harness: "pi", sessionId: file, cwd: ctx.cwd } : null;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function reviewInbox(pi: PiApi): void {
  let timer: NodeJS.Timeout | null = null;
  // Replies already handed to Pi: if only the acknowledgement failed, retry that, never the send.
  const sent = new Set<string>();

  pi.registerTool({
    name: "review_submit",
    label: "Review inbox",
    description:
      "Put a result in front of the user in their Review Inbox and get their answer back in this conversation. " +
      "Use at a meaningful point, not for every turn: `decide` for a concrete question with 2-3 options, " +
      "`try` for a preview the user should interact with, `milestone` for an increment to accept or send back. " +
      "Attach screenshots as evidence. Resubmitting the same key revises the item. The answer arrives later as a user message.",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("decide"), Type.Literal("try"), Type.Literal("milestone")]),
      title: Type.String({ description: "Short, specific: what this is about" }),
      request: Type.Optional(Type.String({ description: "Exactly what you need from the user" })),
      context: Type.Optional(Type.String({ description: "What changed and the context needed now; a few sentences" })),
      recommendation: Type.Optional(Type.String()),
      options: Type.Optional(Type.Array(Type.String({ description: "\"Label: consequence\"" }), { description: "For decide: 2-3 options" })),
      check: Type.Optional(Type.String({ description: "For try: the interaction to perform and the expected behaviour" })),
      preview_url: Type.Optional(Type.String()),
      viewport: Type.Optional(Type.Union([Type.Literal("desktop"), Type.Literal("phone")])),
      setup: Type.Optional(Type.String()),
      screenshots: Type.Optional(Type.Array(Type.String({ description: "Absolute path of an image to attach" }))),
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
          preview: p.preview_url ? { url: p.preview_url, viewport: p.viewport ?? null, setup: p.setup ?? "" } : undefined,
          blocking: p.blocking,
          evidence: (p.screenshots ?? []).map((path: string) => ({ path })),
        },
      });
      return text(result.changed
        ? `In the review inbox (revision ${result.revision}). The user's answer will arrive in this conversation; carry on with other work unless you are blocked on it.`
        : `Unchanged: the inbox already shows revision ${result.revision} of this item.`);
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
    const poll = async () => {
      let wait = POLL_MS;
      try {
        for (const reply of await fetchReplies(session, "live")) {
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
      } catch {
        wait = BACKOFF_MS; // the inbox is not running; keep quiet and try again later
      }
      timer = setTimeout(poll, wait);
      timer.unref?.();
    };
    void poll();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
}
