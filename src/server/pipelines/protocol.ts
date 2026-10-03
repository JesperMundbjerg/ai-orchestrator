// Pipeline HTTP decoders stay beside the domain. Additions to existing requests remain optional.
import { object, optional, nonempty, positiveInteger, number, list, record, refine, oneOf, sessionSchema, fail, handoffSchema, reviewSchema, submitSchema, type Schema } from "../../shared/agent-protocol.ts";
import type { PipelineAbandonInput, PipelineAgentRequest, PipelineAssignInput, PipelineBranchInput, PipelineDoneInput, PipelineEvidenceInput, PipelineGateInput, PipelineLayoutInput, PipelineOverrideInput, PipelineReportInput, PipelineStartInput, PipelineStatusInput } from "../../shared/pipeline.ts";
import { validateGraph, validateLayout } from "./model.ts";

const revision = refine(number, (n, p) => { if (!Number.isSafeInteger(n) || n < 0) fail(p, "must be a non-negative integer"); });
const values = refine(record, (v, p) => { for (const [k, x] of Object.entries(v)) if (typeof x !== "boolean" && typeof x !== "string") fail(`${p}.${k}`, "must be a boolean or string"); });
const evidence: Schema<PipelineEvidenceInput> = object({ kind: oneOf(["report", "check", "artifact", "review", "approval"]), summary: nonempty,
  path: optional(nonempty), url: optional(nonempty), command: optional(nonempty), exitCode: optional(number),
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
