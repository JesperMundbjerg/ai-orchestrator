// The agent wire contract, shared by the HTTP boundary and injectable client. Existing
// unversioned paths remain aliases for this contract. Unknown object fields are retained:
// older services ignore additions, but every known field is validated without coercion.
import {
  HARNESSES, ITEM_TYPES, ITEM_STATES, REPLY_ACTIONS, REPLY_STATES, MESSAGE_KINDS,
  DELIVERY_STATES, WORK_STATES,
  type SessionInput, type SubmitInput, type ActivityInput, type ActivityEvent,
  type EffortReport, type SubmitResult, type PendingReply, type Task, type Item,
  type Reply, type Message, type Work, type TeamBrief, type AgentSwitch, type FounderAnswer, type QaNext, type QaPrediction,
} from "./types.ts";
import type { LimitReading } from "./usage.ts";
import { parsePage } from "./pages.ts";

export const AGENT_PROTOCOL_VERSION = 1;
export interface FieldProblem { path: string; message: string }
export interface ApiErrorBody {
  /** Kept for existing UI/CLI consumers. */
  error: string;
  /** Open string: domain-specific conflict codes may be added without changing transport. */
  code: string;
  details?: FieldProblem[];
}

export class ValidationError extends Error {
  readonly details: FieldProblem[];
  constructor(path: string, message: string) {
    super(`${path || "body"}: ${message}`);
    this.name = "ValidationError";
    this.details = [{ path: path || "body", message }];
  }
}
export interface Schema<T> { parse(input: unknown, path?: string): T }
export type Infer<S> = S extends Schema<infer T> ? T : never;
const schema = <T>(parse: (input: unknown, path: string) => T): Schema<T> => ({ parse: (input, path = "") => parse(input, path) });
export const fail = (path: string, message: string): never => { throw new ValidationError(path, message); };
const fieldPath = (path: string, key: string | number) => path ? `${path}.${key}` : String(key);
export const text = schema<string>((v, p) => typeof v === "string" ? v : fail(p, "must be a string"));
export const nonempty = schema<string>((v, p) => {
  const s = text.parse(v, p);
  return s.trim() ? s : fail(p, "must be a non-empty string");
});
export const boolean = schema<boolean>((v, p) => typeof v === "boolean" ? v : fail(p, "must be a boolean"));
export const number = schema<number>((v, p) => typeof v === "number" && Number.isFinite(v) ? v : fail(p, "must be a finite number"));
export const positiveInteger = schema<number>((v, p) => {
  const n = number.parse(v, p);
  return Number.isSafeInteger(n) && n > 0 ? n : fail(p, "must be a positive integer");
});
export const oneOf = <const T extends readonly (string | number)[]>(values: T): Schema<T[number]> => schema((v, p) =>
  values.some((x) => x === v) ? v as T[number] : fail(p, `must be one of ${values.join(", ")}`));
export const optional = <T>(s: Schema<T>): Schema<T | undefined> => schema((v, p) => v === undefined ? undefined : s.parse(v, p));
export const nullable = <T>(s: Schema<T>): Schema<T | null> => schema((v, p) => v === null ? null : s.parse(v, p));
export const list = <T>(s: Schema<T>): Schema<T[]> => schema((v, p) => {
  if (!Array.isArray(v)) return fail(p, "must be a list");
  return v.map((x, i) => s.parse(x, fieldPath(p, i)));
});
export const record = schema<Record<string, unknown>>((v, p) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail(p, "must be an object"));
type Shape = Record<string, Schema<unknown>>;
type ObjectValue<S extends Shape> =
  { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> } &
  { [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]> };
export const object = <S extends Shape>(fields: S): Schema<ObjectValue<S>> => schema((v, p) => {
  const source = record.parse(v, p);
  const out = { ...source };
  for (const [key, s] of Object.entries(fields)) {
    const value = s.parse(source[key], fieldPath(p, key));
    if (value !== undefined || Object.hasOwn(source, key)) out[key] = value;
  }
  // This assertion is confined to the decoder: each declared property was checked above.
  return out as ObjectValue<S>;
});
export const refine = <T>(s: Schema<T>, check: (v: T, p: string) => void): Schema<T> => schema((v, p) => {
  const out = s.parse(v, p); check(out, p); return out;
});
export const stringOr = <T>(s: Schema<T>, stringSchema: Schema<string> = text): Schema<string | T> => schema((v, p) =>
  typeof v === "string" ? stringSchema.parse(v, p) : s.parse(v, p));
export const httpUrl = refine(nonempty, (s, p) => {
  try {
    const url = new URL(s);
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return;
  } catch { /* invalid URL */ }
  fail(p, "must be a complete http(s) URL");
});
export const timestamp = refine(nonempty, (s, p) => {
  if (!Number.isFinite(Date.parse(s))) fail(p, "must be a valid date/time");
});
const strings = list(text);
const maybeText = optional(text);
const nullText = nullable(text);

export const sessionSchema: Schema<SessionInput> = refine(object({
  harness: optional(oneOf(HARNESSES)), sessionId: optional(nonempty), cwd: maybeText, paneId: optional(nonempty),
}), (s, p) => {
  if (!(s.harness && s.sessionId) && !s.paneId) fail(p, "identify the session with harness and sessionId, or paneId");
});
export const effortReportSchema: Schema<EffortReport> = object({
  current: nonempty, levels: list(nonempty), result: optional(object({ id: nonempty, error: maybeText })),
});
// Tool input is otherwise opaque. Helper tools' calls are consumed by the service,
// so malformed entries must not reach activity bookkeeping as unchecked objects.
export function validateToolInput(tool: string | undefined, input: Record<string, unknown> | undefined, path: string): void {
  if ((tool === "agent" || tool === "agents") && Array.isArray(input?.calls)) list(record).parse(input.calls, `${path}.calls`);
}
export const eventSchema: Schema<ActivityEvent> = refine(object({
  kind: oneOf(["tool", "tool_end", "idle", "helper_start", "helper_stop", "model", "session_name", "effort"]),
  tool: maybeText, input: optional(record), callId: maybeText, helperId: maybeText, helperType: maybeText,
  model: optional(object({ id: nonempty, label: text })), sessionName: optional(nullText), effort: optional(effortReportSchema),
}), (e, p) => { if (e.kind === "tool") validateToolInput(e.tool, e.input, fieldPath(p, "input")); });
const pageString = refine(nonempty, (s, p) => {
  httpUrl.parse(parsePage(s).url, p);
});
export const submitSchema: Schema<SubmitInput> = object({
  session: sessionSchema,
  project: optional(object({ name: maybeText, root: maybeText, objective: maybeText })),
  task: optional(object({ title: maybeText, objective: maybeText })),
  item: object({
    key: maybeText, type: oneOf(ITEM_TYPES), title: nonempty, request: maybeText, context: maybeText,
    recommendation: maybeText, check: maybeText, blocking: optional(boolean),
    options: optional(list(stringOr(object({ id: maybeText, label: maybeText, consequence: maybeText })))),
    preview: optional(stringOr(object({ url: optional(httpUrl), viewport: optional(nullable(oneOf(["desktop", "phone"]))), setup: maybeText }), httpUrl)),
    pages: optional(list(stringOr(object({ url: httpUrl, label: maybeText, look: maybeText }), pageString))),
    evidence: optional(list(refine(object({
      kind: optional(oneOf(["image", "video", "url", "document"])), path: optional(nonempty), url: optional(httpUrl),
      caption: maybeText, sourceRevision: maybeText,
    }), (e, p) => { if (!e.path && !e.url) fail(p, "needs a path or URL"); }))),
  }),
});
export const activitySchema: Schema<ActivityInput> = object({ session: sessionSchema, activity: maybeText, nextMilestone: maybeText, title: maybeText });
export const sessionRequestSchema = object({ session: sessionSchema });
export const repliesSchema = object({ session: sessionSchema, mode: optional(oneOf(["live", "boundary", "pull"])) });
export const ackSchema = object({ session: sessionSchema, deliveryId: nonempty, error: maybeText });
export const closeItemSchema = object({ session: sessionSchema, item: nonempty });
export const paneSchema = object({ session: sessionSchema, paneId: nonempty });
export const storySchema = object({ session: sessionSchema, text: nonempty });
export const saySchema = object({ session: sessionSchema, to: nonempty, text: nonempty, clientId: optional(nonempty) });
export const handoffSchema = object({ session: sessionSchema, title: maybeText, summary: nonempty, to: maybeText, work: maybeText, clientId: optional(nonempty) });
export const reviewSchema = object({ session: sessionSchema, work: nonempty, verdict: oneOf(["accept", "changes"]), notes: maybeText,
  clientId: optional(nonempty), round: optional(positiveInteger) });
export const eventsSchema = object({ session: sessionSchema, events: optional(list(eventSchema)) });
export const effortSchema = object({ session: sessionSchema, report: effortReportSchema });
const resetsAt = schema<string | number | null>((v, p) => {
  if (v === null) return null;
  if (typeof v === "number") return number.parse(v, p);
  const s = text.parse(v, p);
  return s.trim() && Number.isFinite(Number(s)) ? s : timestamp.parse(s, p);
});
const creditsSchema = object({ hasCredits: nullable(boolean), unlimited: nullable(boolean), balance: nullable(number) });
export const limitReadingSchema: Schema<LimitReading> = object({
  window: optional(oneOf(["five_hour", "week"])), windowMinutes: optional(number), usedPercent: number, resetsAt: optional(resetsAt),
  credits: optional(creditsSchema),
});
export const usageSchema = object({ provider: oneOf(["claude", "codex"]), limits: list(limitReadingSchema) });
export const switchOptions = { to: optional(oneOf(["claude", "pi"])), model: optional(nonempty), effort: optional(nonempty) };
export const switchSchema = object({ agent: nonempty, ...switchOptions });
export const switchAllSchema = object({ from: oneOf(["claude", "pi"]), ...switchOptions });
export const emptySchema = object({});
// The QA agent's side of QA answers: the next question, its decision, and the founder's answers it learns from.
export const qaAnswerSchema = object({
  session: sessionSchema, item: nonempty, revision: positiveInteger,
  action: oneOf(["choose", "answer", "accept", "request_changes"]), choice: optional(nonempty), text: maybeText,
  reason: nonempty, learnings: optional(list(nonempty)),
});
export const qaAnswersSchema = object({ session: sessionSchema, limit: optional(positiveInteger) });
export const qaLearnedSchema = object({ session: sessionSchema, through: number });
export const qaJudgeSchema = object({ session: sessionSchema, item: nonempty, revision: positiveInteger, agrees: boolean });

export type RepliesRequest = Infer<typeof repliesSchema>;
export type AcknowledgeRequest = Infer<typeof ackSchema>;
export type SayRequest = Infer<typeof saySchema>;
export type HandoffRequest = Infer<typeof handoffSchema>;
export type ReviewRequest = Infer<typeof reviewSchema>;
export type EventsRequest = Infer<typeof eventsSchema>;
export type UsageRequest = Infer<typeof usageSchema>;
export type EffortRequest = Infer<typeof effortSchema>;
export type SwitchRequest = Infer<typeof switchSchema>;
export type SwitchAllRequest = Infer<typeof switchAllSchema>;
export type { SessionInput, SubmitInput, ActivityInput, PendingReply, SubmitResult };

// Responses are decoded too: an HTTP 200 with HTML, null, or a malformed DTO is not success.
const optionSchema = object({ id: text, label: text, consequence: text });
const pageSchema = object({ url: text, label: text, look: text });
const previewSchema = object({ url: text, viewport: nullable(oneOf(["desktop", "phone"])), setup: text });
export const itemResponse: Schema<Item> = object({
  id: text, taskId: text, key: text, type: oneOf(ITEM_TYPES), revision: positiveInteger,
  title: text, request: text, context: text, recommendation: text, options: list(optionSchema), check: text,
  preview: nullable(previewSchema), pages: list(pageSchema), blocking: boolean, state: oneOf(ITEM_STATES),
  snoozedUntil: nullText, backedAt: nullText, createdAt: text, updatedAt: text, presentedHead: optional(nullText),
});
export const replyResponse: Schema<Reply> = object({
  id: text, itemId: text, revision: positiveInteger, action: oneOf(REPLY_ACTIONS), choice: nullText, text,
  images: strings, state: oneOf(REPLY_STATES), error: nullText, createdAt: text, deliveredAt: nullText,
  answeredBy: optional(oneOf(["founder", "approve_all", "qa_agent"])), overridesQa: optional(boolean),
});
const pendingReplyResponse: Schema<PendingReply> = object({
  deliveryId: text, itemId: text, itemKey: text, itemTitle: text, itemType: oneOf(ITEM_TYPES), revision: positiveInteger,
  action: oneOf(REPLY_ACTIONS), choice: nullText, choiceLabel: nullText, text, images: strings, createdAt: text,
  answeredBy: optional(oneOf(["founder", "approve_all", "qa_agent"])), overridesQa: optional(boolean),
});
export const taskResponse: Schema<Task> = object({
  id: text, projectId: text, title: text, objective: text, activity: text, nextMilestone: text,
  lastDecision: text, lastAcceptedMilestone: text, parked: boolean,
  binding: object({ harness: oneOf(HARNESSES), sessionId: text, cwd: nullText }),
  capabilities: object({ submit: boolean, reply: oneOf(["live", "boundary", "pull", "none"]), ack: boolean,
    openConversation: boolean, openPreview: boolean, changeEffort: optional(object({ levels: strings })), effortUnavailable: maybeText }),
  presence: nullable(object({ source: oneOf(["herdr"]), paneId: text, status: oneOf(["idle", "working", "blocked", "done", "unknown"]),
    name: nullText, title: nullText, seenAt: text })), createdAt: text, updatedAt: text,
});
export const messageResponse: Schema<Message> = object({
  id: text, kind: oneOf(MESSAGE_KINDS), fromAgentId: nullText, teamId: nullText, text, images: strings,
  workId: nullText, createdAt: text, deliveries: list(object({ agentId: text, state: oneOf(DELIVERY_STATES), error: nullText, updatedAt: text })),
  toFounder: boolean, fromOffice: optional(boolean), aboutAgentIds: optional(strings), allLeads: optional(boolean),
});
const workResponse: Schema<Work> = object({
  id: text, title: text, summary: text, fromAgentId: text, fromTeamId: nullText, toTeamId: text, state: oneOf(WORK_STATES),
  round: positiveInteger, reviewerId: nullText, notes: text, createdAt: text, updatedAt: text,
});
const switchResponse: Schema<AgentSwitch> = object({
  id: text, agentId: text, agentName: text, from: oneOf(HARNESSES), to: oneOf(HARNESSES), toLabel: text,
  model: text, effort: text, step: oneOf(["queued", "waiting", "handoff", "opening", "starting", "closing", "taking_over", "briefing", "done", "failed"]),
  says: text, handoff: nullText, error: nullText,
  batchId: nullText, startedAt: text, updatedAt: text,
});
const qaPredictionResponse: Schema<QaPrediction> = object({
  predicted: schema<true>((v, p) => v === true ? true : fail(p, "must be true")),
  itemId: text, revision: positiveInteger, action: oneOf(["choose", "answer", "accept", "request_changes"]), choice: nullText, text,
  reason: text, learnings: strings, at: text, verdict: nullable(oneOf(["match", "mismatch", "needs_judging"])),
});
// QA answers mode answers (a Reply); manual mode only records a prediction of the founder's answer.
const qaAnswerResponse = schema<Reply | QaPrediction>((v, p) =>
  (record.parse(v, p) as { predicted?: unknown }).predicted === true ? qaPredictionResponse.parse(v, p) : replyResponse.parse(v, p));
const founderAnswerResponse: Schema<FounderAnswer> = object({
  seq: number, at: text, itemId: text, revision: positiveInteger, project: text, itemType: oneOf(ITEM_TYPES), title: text, request: text,
  recommendation: text, options: list(optionSchema), action: oneOf(REPLY_ACTIONS), choice: nullText, choiceLabel: nullText, text,
  overrode: nullable(object({ action: oneOf(REPLY_ACTIONS), choice: nullText, learnings: strings })),
  predicted: optional(nullable(qaPredictionResponse)),
});
const okResponse = object({ ok: boolean });
const workResult = object({ work: workResponse, message: messageResponse });
export interface Operation<I, O> { method: "POST" | "GET"; path: string; request: Schema<I>; response: Schema<O> }
const post = <I, O>(path: string, request: Schema<I>, response: Schema<O>): Operation<I, O> => ({ method: "POST", path, request, response });
export const agentOperations = {
  submit: post("/api/agent/items", submitSchema, object({ itemId: text, taskId: text, revision: positiveInteger, changed: boolean, warnings: optional(strings) }) satisfies Schema<SubmitResult>),
  activity: post("/api/agent/activity", activitySchema, taskResponse),
  replies: post("/api/agent/replies", repliesSchema, list(pendingReplyResponse)),
  acknowledge: post("/api/agent/ack", ackSchema, replyResponse),
  team: post("/api/agent/team", sessionRequestSchema, object({ agentId: text, text }) satisfies Schema<TeamBrief>),
  pane: post("/api/agent/pane", paneSchema, object({ recorded: boolean })),
  crew: post("/api/agent/crew", emptySchema, object({ text })),
  story: post("/api/agent/story", storySchema, object({ story: text })),
  say: post("/api/agent/say", saySchema, messageResponse),
  events: post("/api/agent/events", eventsSchema, okResponse),
  usage: post("/api/agent/usage", usageSchema, object({ changed: boolean })),
  effort: post("/api/agent/effort", effortSchema, object({ request: nullable(object({ id: text, level: text })) })),
  handoff: post("/api/agent/handoff", handoffSchema, workResult),
  review: post("/api/agent/review", reviewSchema, workResult),
  withdraw: post("/api/agent/withdraw", closeItemSchema, itemResponse),
  resolve: post("/api/agent/resolve", closeItemSchema, itemResponse),
  qaNext: post("/api/agent/qa/next", sessionRequestSchema, object({
    item: nullable(refine(record, (v, p) => { itemResponse.parse(v, p); object({ project: text, taskTitle: text }).parse(v, p); })),
    waiting: number, toLearn: number, learnings: text, predicting: optional(boolean),
  }) as Schema<QaNext>),
  qaAnswer: post("/api/agent/qa/answer", qaAnswerSchema, qaAnswerResponse),
  qaAnswers: post("/api/agent/qa/answers", qaAnswersSchema, object({ answers: list(founderAnswerResponse), remaining: number, learnedThrough: number })),
  qaLearned: post("/api/agent/qa/learned", qaLearnedSchema, object({ learnedThrough: number })),
  qaJudge: post("/api/agent/qa/judge", qaJudgeSchema, qaPredictionResponse),
  switchAgent: post("/api/world/switches", switchSchema, switchResponse),
  switchAll: post("/api/world/switches/all-from", switchAllSchema, object({ batchId: text, switches: list(switchResponse), skipped: list(object({ name: text, why: text })) })),
};
export const switchStatusResponse = switchResponse;
export type AgentOperations = typeof agentOperations;
export type OperationInput<K extends keyof AgentOperations> = Infer<AgentOperations[K]["request"]>;
export type OperationOutput<K extends keyof AgentOperations> = Infer<AgentOperations[K]["response"]>;
