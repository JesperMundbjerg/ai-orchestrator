import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { call, get } from "../shared/agent-client.ts";
import type { SessionInput, WorldState } from "../shared/types.ts";
import type { PipelineGateInput, PipelineGateResult, PipelineRun, PipelineStatus, PipelineValue } from "../shared/pipeline.ts";

interface Flags {
  json?: string; run?: string; base?: string; candidate?: string; checkout?: string; revision?: string; round?: string;
  select?: string[]; notes?: string; report?: string[]; screenshot?: string[]; url?: string[]; check?: string; "exit-code"?: string;
  work?: string; "work-round"?: string; "client-id"?: string; operation?: string; repo?: string; ref?: string; delivery?: string; node?: string;
}
const integer = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
};
export async function pipelineCommand(args: string[], flags: Flags, session: SessionInput): Promise<void> {
  const [operation, positionalRun, node, agent] = args;
  if (!["start", "branch", "abandon", "assign", "done", "report", "status", "gate"].includes(operation ?? "")) throw new Error("inbox pipeline start|branch|abandon|assign|done|report|status|gate; --json FILE accepts a full operation payload");
  const payload = flags.json ? JSON.parse(readFileSync(flags.json === "-" ? 0 : flags.json, "utf8")) as Record<string, unknown> : {};
  const runId = flags.run ?? positionalRun ?? payload.runId as string | undefined;
  if (operation !== "start" && operation !== "status" && !runId) throw new Error("name the pipeline run with RUN or --run RUN");
  if (operation === "status") {
    const result = await call<PipelineStatus>("/api/agent/pipeline/status", { session, runId });
    return console.log(result.text);
  }
  const status = operation === "start" ? null : await call<PipelineStatus>("/api/agent/pipeline/status", { session, runId });
  const run = status?.run;
  const body: Record<string, unknown> = { ...payload, session, runId };
  if (operation === "gate") {
    const input = { ...body, round: integer(flags.round ?? payload.round, "round") ?? run!.round,
      candidate: flags.candidate ?? payload.candidate ?? run!.candidate.head,
      delivery: flags.delivery ?? payload.delivery ?? "dev", operation: flags.operation ?? payload.operation,
      repo: flags.repo ? resolve(flags.repo) : payload.repo, ref: flags.ref ?? payload.ref,
      nodeId: flags.node ?? payload.nodeId, workId: flags.work ?? payload.workId, workRound: integer(flags["work-round"] ?? payload.workRound, "work-round") };
    const result = await call<PipelineGateResult>("/api/agent/pipeline/gate", input);
    if (!result.allowed) throw new Error(`delivery refused: ${result.reasons.join("; ")}`);
    return console.log(JSON.stringify(result));
  }
  body.clientId = flags["client-id"] ?? payload.clientId ?? randomUUID();
  // Preserve this key if a response is lost: an explicit retry must reuse it.
  console.error(`pipeline clientId: ${body.clientId}`);
  if (operation === "start") {
    body.checkout = flags.checkout ? resolve(flags.checkout) : payload.checkout;
    body.base = flags.base ?? payload.base; body.candidate = flags.candidate ?? payload.candidate;
    body.workId = flags.work ?? payload.workId; body.workRound = integer(flags["work-round"] ?? payload.workRound, "work-round");
  } else if (operation === "abandon") {
    // Do not derive a revision from status: retries must send the same payload
    // after closure, including when the original response was lost.
    body.notes = flags.notes ?? payload.notes;
  } else {
    // A base-only retry must not silently acquire the ledger's newer revision.
    body.expectedRevision = integer(flags.revision ?? payload.expectedRevision, "revision") ?? (operation === "branch" && (flags.base ?? payload.base) ? undefined : run!.revision);
    body.nodeId = flags.node ?? node ?? payload.nodeId;
    body.notes = flags.notes ?? payload.notes;
    if (operation === "branch") {
      const selections = { ...(payload.selections as Record<string, PipelineValue> ?? {}) };
      for (const pair of flags.select ?? []) {
        const split = pair.indexOf("="); if (split < 1) throw new Error("--select uses field=value");
        const value = pair.slice(split + 1); selections[pair.slice(0, split)] = value === "true" ? true : value === "false" ? false : value;
      }
      body.selections = selections; body.rationale = flags.notes ?? payload.rationale;
      body.base = flags.base ?? payload.base;
      body.candidate = flags.candidate ?? payload.candidate;
    }
    if (operation === "assign") {
      const name = agent ?? payload.agentId;
      const world = await get<WorldState>("/api/world");
      body.agentId = world.agents.find(a => a.teamId === status!.team.teamId && (a.id === name || a.name.toLowerCase() === String(name).toLowerCase()))?.id ?? name;
    }
    if (operation === "done" || operation === "report") {
      const summary = String(body.notes ?? "");
      body.evidence = [...(payload.evidence as unknown[] ?? []), ...(flags.report ?? []).map(path => ({ kind: "report", summary, path: resolve(path) })),
        ...(flags.screenshot ?? []).map(path => ({ kind: "artifact", summary, path: resolve(path) })), ...(flags.url ?? []).map(url => ({ kind: "artifact", summary, url })),
        ...(flags.check ? [{ kind: "check", summary, command: flags.check, exitCode: flags["exit-code"] === undefined ? undefined : Number(flags["exit-code"]) }] : [])];
    }
  }
  const result = await call<PipelineRun>(`/api/agent/pipeline/${operation}`, body);
  console.log(JSON.stringify(result, null, 2));
}
export async function deliveryBinding(session: SessionInput, runId: string | undefined, delivery: "handoff" | "review", options: { candidate?: string; round?: string; node?: string } = {}): Promise<PipelineGateInput | undefined> {
  if (!runId) return undefined;
  const status = await call<PipelineStatus>("/api/agent/pipeline/status", { session, runId });
  const run = status.run!;
  return { runId, delivery, round: integer(options.round, "round") ?? run.round, candidate: options.candidate ?? run.candidate.head, ...(options.node ? { nodeId: options.node } : {}) };
}
