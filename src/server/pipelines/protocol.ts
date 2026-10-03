// Pipeline HTTP decoders stay beside the domain. Additions to existing requests remain optional.
import { object, optional, boolean, nonempty, positiveInteger, number, list, record, refine, oneOf, sessionSchema, fail, handoffSchema, reviewSchema, submitSchema, type Schema, type SessionInput } from "../../shared/agent-protocol.ts";
import type { PipelineAbandonInput, PipelineAgentRequest, PipelineAssignInput, PipelineBranchInput, PipelineDoneInput, PipelineEvidenceInput, PipelineGateInput, PipelineLayoutInput, PipelineOverrideInput, PipelineReportInput, PipelineStartInput, PipelineTelemetryQuery, PipelineTelemetryReport, PipelineStatusInput } from "../../shared/pipeline.ts";
import type { WaiverGateInput, WaiverRequestInput } from "../../shared/waiver.ts";
import { validateGraph, validateLayout } from "./model.ts";

const revision = refine(number, (n, p) => { if (!Number.isSafeInteger(n) || n < 0) fail(p, "must be a non-negative integer"); });
const values = refine(record, (v, p) => { for (const [k, x] of Object.entries(v)) if (typeof x !== "boolean" && typeof x !== "string") fail(`${p}.${k}`, "must be a boolean or string"); });
const evidence: Schema<PipelineEvidenceInput> = object({ kind: oneOf(["report", "check", "artifact", "review", "approval"]), summary: nonempty,
  path: optional(nonempty), url: optional(nonempty), command: optional(nonempty), exitCode: optional(number), onBase: optional(boolean),
  review: optional(object({ workId: nonempty, round: positiveInteger })), approval: optional(object({ itemId: nonempty, revision: positiveInteger })),
});
export const gateSchema: Schema<PipelineGateInput> = object({ runId: nonempty, delivery: oneOf(["handoff", "review", "dev"]), round: positiveInteger, candidate: nonempty,
  workId: optional(nonempty), workRound: optional(positiveInteger), nodeId: optional(nonempty),
  operation: optional(oneOf(["push", "pr", "merge", "land", "publish"])), repo: optional(nonempty), ref: optional(nonempty) });
const deliveryOptions = { operation: optional(oneOf(["push", "pr", "merge", "land", "publish"])), repo: optional(nonempty), ref: optional(nonempty) };
const edit = { session: sessionSchema, runId: nonempty, clientId: nonempty, expectedRevision: positiveInteger };
export const pipelineSchemas = {
  start: object({ session: sessionSchema, clientId: nonempty, checkout: optional(nonempty), base: optional(nonempty), candidate: optional(nonempty), workId: optional(nonempty), workRound: optional(positiveInteger) }) as Schema<PipelineAgentRequest<PipelineStartInput>>,
  branch: refine(object({ ...edit, expectedRevision: optional(positiveInteger), selections: values, rationale: nonempty, base: optional(nonempty), candidate: optional(nonempty) }), (v, p) => {
    if (!v.base && v.expectedRevision === undefined) fail(`${p}.expectedRevision`, "required unless re-basing with base");
  }) as Schema<PipelineAgentRequest<PipelineBranchInput>>,
  abandon: object({ session: sessionSchema, runId: nonempty, clientId: nonempty, notes: nonempty }) as Schema<PipelineAgentRequest<PipelineAbandonInput>>,
  assign: object({ ...edit, nodeId: nonempty, agentId: nonempty }) as Schema<PipelineAgentRequest<PipelineAssignInput>>,
  report: object({ ...edit, nodeId: nonempty, evidence: list(evidence), notes: nonempty }) as Schema<PipelineAgentRequest<PipelineReportInput>>,
  done: object({ ...edit, nodeId: nonempty, evidence: list(evidence), notes: nonempty, evidenceIds: optional(list(nonempty)) }) as Schema<PipelineAgentRequest<PipelineDoneInput>>,
  status: object({ session: sessionSchema, runId: optional(nonempty) }) as Schema<PipelineAgentRequest<PipelineStatusInput>>,
  gate: object({ session: sessionSchema, runId: nonempty, delivery: oneOf(["handoff", "review", "dev"]), round: positiveInteger, candidate: nonempty, workId: optional(nonempty), workRound: optional(positiveInteger), nodeId: optional(nonempty), ...deliveryOptions }) as Schema<PipelineAgentRequest<PipelineGateInput>>,
};
export const waiverSchemas = {
  request: object({ session: sessionSchema, clientId: nonempty, repo: nonempty, ref: nonempty, candidate: nonempty, reason: nonempty }) as Schema<PipelineAgentRequest<WaiverRequestInput>>,
  gate: object({ session: sessionSchema, repo: nonempty, ref: nonempty, candidate: nonempty, operation: deliveryOptions.operation }) as Schema<PipelineAgentRequest<WaiverGateInput>>,
};
export const overrideSchema: Schema<PipelineOverrideInput> = {
  parse(input, path) { const b = object({ expectedRevision: revision, repoRoot: optional(nonempty), graph: { parse(v) { return v === null ? null : validateGraph(v); } } }).parse(input, path); return b; },
};
export const layoutSchema: Schema<PipelineLayoutInput> = object({ expectedRevision: revision, positions: { parse: validateLayout } });
export const pipelineHandoffSchema = object({ ...{ session: sessionSchema }, pipeline: optional(gateSchema) });
export const deliveryHandoffSchema = { parse(input: unknown, path?: string) { return { ...handoffSchema.parse(input, path), ...pipelineHandoffSchema.parse(input, path) }; } };
export const deliveryReviewSchema = { parse(input: unknown, path?: string) { return { ...reviewSchema.parse(input, path), ...pipelineHandoffSchema.parse(input, path) }; } };
export const pipelineSubmitSchema = { parse(input: unknown, path?: string) {
  return { ...submitSchema.parse(input, path), ...object({ pipeline: optional(object({ runId: nonempty })) }).parse(input, path) };
} };
/** The read-only telemetry query, from a GET's search parameters. */
export function telemetryQuery(params: URLSearchParams): PipelineTelemetryQuery {
  const query: PipelineTelemetryQuery = {};
  const run = params.get("run"); const team = params.get("team"); const kind = params.get("kind"); const since = params.get("since"); const limit = params.get("limit");
  if (run) query.runId = run;
  if (team) query.teamId = team;
  if (kind) { if (!TELEMETRY_KINDS.includes(kind)) fail("kind", `must be ${TELEMETRY_KINDS.join(", ")}`); query.kind = kind as PipelineTelemetryQuery["kind"]; }
  if (since) { if (Number.isNaN(Date.parse(since))) fail("since", "must be an ISO time"); query.since = new Date(since).toISOString(); }
  if (limit) { if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1000) fail("limit", "must be 1–1000"); query.limit = Number(limit); }
  return query;
}

const TELEMETRY_KINDS = ["gate", "integration", "publication", "lease", "attempt"];
const token = refine(nonempty, (v, p) => { if (!/^[\w.:@/-]{1,128}$/.test(v)) fail(p, "must be 1–128 letters, digits or _ . : @ / -"); });
const bounded = (max: number) => refine(nonempty, (v, p) => { if (v.length > max) fail(p, `must be at most ${max} characters`); });
const reasonCode = refine(nonempty, (v, p) => { if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(v)) fail(p, "must be a lowercase code of at most 64 characters (a-z 0-9 _ . -)"); });
const isoTime = refine(nonempty, (v, p) => { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(Date.parse(v))) fail(p, "must be an ISO time such as 2026-10-03T10:00:00Z"); });
/** Rejects any field the event does not define, so a typo is a 400, not a silently dropped field. */
const only = <T extends object>(s: Schema<T>, fields: string[]): Schema<T> => refine(s, (v, p) => {
  for (const key of Object.keys(v)) if (!fields.includes(key)) fail(p ? `${p}.${key}` : key, "is not a field of this event");
});
const leaseReport = only(object({ session: sessionSchema, kind: oneOf(["lease"]), action: oneOf(["grant", "release", "expire"]), lease: token, holder: bounded(200), run: optional(token), resource: optional(bounded(500)), at: optional(isoTime) }),
  ["session", "kind", "action", "lease", "holder", "run", "resource", "at"]);
const attemptReport = only(object({ session: sessionSchema, kind: oneOf(["attempt"]), attempt: token, lease: optional(token), run: optional(token), outcome: oneOf(["started", "succeeded", "failed", "abandoned"]), reason: optional(reasonCode), at: optional(isoTime) }),
  ["session", "kind", "attempt", "lease", "run", "outcome", "reason", "at"]);
/** One externally reported capture lease or attempt event; strictly validated, any other shape is a 400. */
export const telemetryReportSchema: Schema<PipelineTelemetryReport & { session: SessionInput }> = { parse(input, path = "") {
  const kind = record.parse(input, path).kind;
  if (kind === "lease") return leaseReport.parse(input, path) as PipelineTelemetryReport & { session: SessionInput };
  if (kind === "attempt") return attemptReport.parse(input, path) as PipelineTelemetryReport & { session: SessionInput };
  return fail(path ? `${path}.kind` : "kind", "must be lease or attempt");
} };
