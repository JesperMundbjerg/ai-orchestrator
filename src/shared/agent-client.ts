// What every agent-side integration shares: how to reach the service, and how a reply reads
// when it lands in a conversation. The CLI, the Claude Code hook and the Pi extension use it.

import type { PendingReply, SessionInput } from "./types.ts";
import {
  agentOperations, switchStatusResponse, list, record, ValidationError,
  type Schema, type FieldProblem, type AgentOperations, type OperationInput, type OperationOutput,
} from "./agent-protocol.ts";

export function serviceUrl(): string {
  return process.env.INBOX_URL ?? `http://127.0.0.1:${process.env.INBOX_PORT ?? 4870}`;
}

export type ClientErrorKind = "http" | "transport" | "timeout" | "cancelled" | "protocol" | "validation";
/** Recovery never needs to parse English: HTTP failures preserve status/code/details. */
export class AgentClientError extends Error {
  readonly kind: ClientErrorKind;
  readonly status: number | undefined;
  readonly code: string;
  readonly details: FieldProblem[] | undefined;
  constructor(message: string, info: { kind: ClientErrorKind; status?: number; code: string; details?: FieldProblem[]; cause?: unknown }) {
    super(message, { cause: info.cause });
    this.name = "AgentClientError";
    this.kind = info.kind;
    this.status = info.status;
    this.code = info.code;
    this.details = info.details;
  }
}
export interface RequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface AgentClientOptions {
  baseUrl?: string;
  session?: SessionInput;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
type ClientInput<K extends keyof AgentOperations> = OperationInput<K> extends { session: SessionInput }
  ? Omit<OperationInput<K>, "session"> & { session?: SessionInput } : OperationInput<K>;
type NamedMethod<K extends keyof AgentOperations> = {} extends ClientInput<K>
  ? (input?: ClientInput<K>, options?: RequestOptions) => Promise<OperationOutput<K>>
  : (input: ClientInput<K>, options?: RequestOptions) => Promise<OperationOutput<K>>;
export type AgentClient = { [K in keyof AgentOperations]: NamedMethod<K> } & {
  switchStatus(id: string, options?: RequestOptions): Promise<OperationOutput<"switchAgent">>;
  switches(options?: RequestOptions): Promise<OperationOutput<"switchAgent">[]>;
};

function errorDetails(v: unknown): FieldProblem[] | undefined {
  if (!Array.isArray(v) || !v.every((d) => d && typeof d === "object" && typeof d.path === "string" && typeof d.message === "string")) return undefined;
  return v.map((d) => ({ path: d.path, message: d.message }));
}
function transport(options: AgentClientOptions) {
  // Resolve once, not a process-global environment lookup on each request.
  const baseUrl = (options.baseUrl ?? serviceUrl()).replace(/\/+$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  return async (method: string, path: string, body: unknown, request: RequestOptions = {}, responseSchema?: Schema<unknown>): Promise<unknown> => {
    const ms = request.timeoutMs ?? timeoutMs;
    if (!Number.isSafeInteger(ms) || ms < 0) throw new AgentClientError("timeoutMs: must be a non-negative integer", { kind: "validation", code: "invalid_request" });
    let encoded: string | undefined;
    try { encoded = method === "GET" ? undefined : JSON.stringify(body); }
    catch (err) { throw new AgentClientError("request body is not JSON-serializable", { kind: "validation", code: "invalid_request", cause: err }); }
    const timeout = AbortSignal.timeout(ms);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let res: Response | undefined;
    try {
      signal.throwIfAborted();
      res = await fetcher(`${baseUrl}${path}`, {
        method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: encoded }), signal,
      });
      const raw = await res.text();
      let out: unknown;
      let parseError: unknown;
      try { out = JSON.parse(raw); } catch (err) { parseError = err; }
      if (!res.ok) {
        const envelope = out && typeof out === "object" && !Array.isArray(out) ? out as Record<string, unknown> : {};
        throw new AgentClientError(typeof envelope.error === "string" ? envelope.error : `inbox answered ${res.status}`, {
          kind: "http", status: res.status, code: typeof envelope.code === "string" ? envelope.code : "http_error", details: errorDetails(envelope.details),
        });
      }
      if (parseError) throw new AgentClientError("inbox returned invalid JSON", { kind: "protocol", status: res.status, code: "invalid_response", cause: parseError });
      if (!responseSchema) return out; // legacy arbitrary-path escape hatch
      try { return responseSchema.parse(out, "response"); }
      catch (err) {
        throw new AgentClientError(err instanceof Error ? err.message : "invalid inbox response", {
          kind: "protocol", status: res.status, code: "invalid_response", details: err instanceof ValidationError ? err.details : undefined, cause: err,
        });
      }
    } catch (err) {
      if (err instanceof AgentClientError) throw err;
      const kind = request.signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "transport";
      throw new AgentClientError(kind === "cancelled" ? "inbox request cancelled" : kind === "timeout" ? "inbox request timed out" : "could not reach inbox", {
        kind, status: res?.status, code: kind === "transport" ? "transport_error" : kind, cause: err,
      });
    }
  };
}

/** Named, decoded operations; session identity can be supplied per instance or per call.
 * Mutations are never automatically retried. Keep the same clientId on an explicit replay. */
export function createAgentClient(options: AgentClientOptions = {}): AgentClient {
  const send = transport(options);
  const session = options.session ? { ...options.session } : undefined;
  const methods = Object.fromEntries(Object.entries(agentOperations).map(([name, op]) => [name, async (input: unknown = {}, request?: RequestOptions) => {
    let body: unknown;
    try { body = op.request.parse({ ...(session ? { session } : {}), ...record.parse(input) }); }
    catch (err) {
      throw new AgentClientError(err instanceof Error ? err.message : "invalid request", {
        kind: "validation", code: "invalid_request", details: err instanceof ValidationError ? err.details : undefined, cause: err,
      });
    }
    return send(op.method, op.path, body, request, op.response);
  }]));
  // The map's method types derive from the same operation schemas used for decoding above.
  return {
    ...methods,
    switchStatus: async (id: string, request?: RequestOptions) => {
      if (typeof id !== "string" || !/^[\w-]+$/.test(id)) throw new AgentClientError("id: must be a switch id", { kind: "validation", code: "invalid_request" });
      return send("GET", `/api/world/switches/${id}`, undefined, request, switchStatusResponse);
    },
    switches: (request?: RequestOptions) => send("GET", "/api/world/switches", undefined, request, list(switchStatusResponse)),
  } as AgentClient;
}

function legacyResponse(method: string, path: string): Schema<unknown> | undefined {
  const known = Object.values(agentOperations).find((op) => op.method === method && op.path === path);
  if (known) return known.response;
  if (method === "GET" && /^\/api\/world\/switches\/[\w-]+$/.test(path)) return switchStatusResponse;
  if (method === "GET" && path === "/api/world/switches") return list(switchStatusResponse);
  return undefined;
}
/** Compatibility escape hatches for existing CLI/extensions. Prefer the named client. */
export async function call<T>(path: string, body: unknown, timeoutMs = 5000): Promise<T> {
  return await transport({ timeoutMs })("POST", path, body, {}, legacyResponse("POST", path)) as T;
}
export async function get<T>(path: string, timeoutMs = 5000): Promise<T> {
  return await transport({ timeoutMs })("GET", path, undefined, {}, legacyResponse("GET", path)) as T;
}
export const fetchReplies = (session: SessionInput, mode: "live" | "boundary" | "pull") =>
  createAgentClient({ session }).replies({ mode });
export const acknowledge = (session: SessionInput, deliveryId: string, error?: string) =>
  createAgentClient({ session }).acknowledge({ deliveryId, error });

const ACTION_LEAD: Record<PendingReply["action"], string> = {
  choose: "Decision",
  answer: "Answer",
  accept: "Milestone accepted",
  request_changes: "Changes requested",
  tried: "Tried it", // an old try-it reply, still handed over if one was queued
  discuss: "Message",
};

/** What a try-it request's answer is called: the user approved it, or it needs changes. */
const TRY_LEAD: Partial<Record<PendingReply["action"], string>> = { accept: "Approved", request_changes: "Needs changes" };

/** Attached images as the agent reads them: one absolute path per line, never the bytes, since the text may be typed into a terminal. */
export function imageLines(paths: string[]): string {
  return paths.map((p) => `Image: ${p}`).join("\n");
}

/** A reply as the owning agent reads it: which request it answers, what was chosen, what was said. */
export function formatReply(r: PendingReply): string {
  const lines = [`[Review inbox] Reply to your ${r.itemType} request "${r.itemTitle}" (key ${r.itemKey}, revision ${r.revision}).`];
  const lead = (r.itemType === "try" ? TRY_LEAD[r.action] : undefined) ?? ACTION_LEAD[r.action];
  if (r.action === "choose") lines.push(`${lead}: ${r.choiceLabel ?? r.choice}`);
  else if (r.action === "answer") lines.push(`${lead}: ${r.text}`);
  else lines.push(`${lead}.`);
  if (r.text && r.action !== "answer") lines.push("", r.text);
  if (r.images?.length) lines.push("", imageLines(r.images));
  lines.push("", "This is the user's answer. It authorizes only what it says; act on it, then submit a new review item when there is something new to look at.");
  return lines.join("\n");
}
