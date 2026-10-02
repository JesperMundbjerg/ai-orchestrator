// Vendor-neutral pipeline contract. The UI talks only to the office; repo paths are
// provenance labels, not instructions to branch on a harness or execute project code.
import type { SessionInput } from "./types.ts";

export type PipelineValue = string | boolean;
export interface PipelineField {
  id: string;
  label: string;
  type: "enum" | "boolean";
  /** Required for enum fields, absent for boolean fields. */
  options?: string[];
}
export interface PipelineMatch { field: string; equals: PipelineValue }
export interface PipelinePosition { x: number; y: number }
export type PipelineLayout = Record<string, PipelinePosition>;
export type PipelineEvidenceKind = "report" | "check" | "artifact" | "review" | "approval";
export interface PipelineNode {
  id: string;
  label: string;
  kind: "step" | "condition" | "approval" | "delivery";
  /** Palette id, e.g. agent:.claude/agents/architecture-reviewer.md or builtin:check. */
  source?: string;
  /** Condition nodes select this declared field; outgoing ports are its values. */
  field?: string;
  /** All named evidence kinds are required, not an any-of choice. */
  evidence?: PipelineEvidenceKind[];
  /** Delivery boundary; only delivery nodes may set this. */
  delivery?: "handoff" | "review" | "dev";
  /** Human guidance only: the service NEVER runs this command. */
  instructions?: string;
}
export interface PipelineEdge {
  id: string;
  from: string;
  to: string;
  /** A condition's named output: enum option, or "true" / "false". */
  port?: string;
  /** Additional deterministic guard. No arbitrary scripts or model inference. */
  when?: PipelineMatch;
}
export interface PipelinePathRule {
  when?: PipelineMatch;
  /** Repository-relative prefixes; "file.ext" matches that exact file too. */
  prefixes: string[];
  /** If any changed path matches, this field must have this value. */
  require?: PipelineMatch;
  /** If true, ALL changed paths must match these prefixes when the rule applies. */
  only?: boolean;
  message: string;
}
export interface PipelineGraph {
  version: 1;
  id: string;
  label: string;
  fields: PipelineField[];
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Every node must be reachable from this start, and reach a delivery. */
  entry: string;
  pathRules?: PipelinePathRule[];
  /** Optional repo-default positions. Team layout remains a separate revision. */
  positions?: PipelineLayout;
}
export interface PipelineDefinition {
  id: string;
  label: string;
  description: string;
  kind: "agent" | "skill" | "command" | "builtin";
  path: string | null;
  /** Content hash; null for built-ins. */
  hash: string | null;
}
/** GET /api/world/teams/:teamId/pipeline/palette */
export interface PipelinePalette {
  teamId: string;
  repoRoot: string | null;
  entries: PipelineDefinition[];
  problems: string[];
}
/** GET /api/world/teams/:teamId/pipeline. Also returned by both editor PUTs. */
export interface PipelineTeamView {
  teamId: string;
  repoRoot: string | null;
  source: "repo" | "team" | "none";
  graph: PipelineGraph | null;
  /** Optimistic lock for override / binding edits; NOT the layout revision. */
  revision: number;
  layoutRevision: number;
  /** Effective behavioral hash; dragging does not change it or invalidate a run. */
  policyHash: string | null;
  layout: PipelineLayout;
  problems: string[];
  /** Once adopted, removal/broken config fails closed until explicitly reset by the founder. */
  protected: boolean;
  runs: PipelineRun[];
}
/** PUT /api/world/teams/:teamId/pipeline. Null resets to repo inheritance. */
export interface PipelineOverrideInput {
  expectedRevision: number;
  graph: PipelineGraph | null;
  /** Optional explicit binding for an ambiguous standing team; canonicalized by the service. */
  repoRoot?: string;
}
/** PUT /api/world/teams/:teamId/pipeline/layout. Positions never freeze inheritance. */
export interface PipelineLayoutInput { expectedRevision: number; positions: PipelineLayout }

export interface PipelineCandidate {
  checkout: string;
  repoRoot: string;
  base: string;
  head: string;
  tree: string;
  /** Intended bytes (including dirty/untracked work), independent of commit metadata. */
  fingerprint: string;
  changedPaths: string[];
}
export interface PipelineEvidenceInput {
  kind: PipelineEvidenceKind;
  summary: string;
  /** Explicit regular file, copied/hash-bound by the service; never a dot/private file. */
  path?: string;
  url?: string;
  /** Existing receiving-team verdict, bound to its exact round. */
  review?: { workId: string; round: number };
  /** Existing founder accept at exactly this item revision and run candidate. */
  approval?: { itemId: string; revision: number };
  /** Check evidence must include the command and exit status. */
  command?: string;
  exitCode?: number;
}
export interface PipelineEvidence extends PipelineEvidenceInput {
  id: string;
  byAgentId: string;
  fingerprint: string;
  round: number;
  createdAt: string;
  sha256?: string;
  /** Stored attachment path outside worktrees; the original path is not read again. */
  storedPath?: string;
}
export interface PipelineStep {
  nodeId: string;
  state: "inactive" | "blocked" | "ready" | "reported" | "done" | "stale";
  assignedTo: string | null;
  completedBy: string | null;
  evidence: PipelineEvidence[];
  notes: string;
}
export interface PipelineRun {
  id: string;
  teamId: string;
  /** The current first mate, resolved afresh (a takeover inherits the run). */
  leadId: string | null;
  graph: PipelineGraph;
  policyHash: string;
  definitionHashes: Record<string, string | null>;
  revision: number;
  round: number;
  candidate: PipelineCandidate;
  selections: Record<string, PipelineValue>;
  rationale: string;
  steps: PipelineStep[];
  state: "open" | "delivered";
  workId: string | null;
  workRound: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface PipelineGateInput {
  runId: string;
  delivery: "handoff" | "review" | "dev";
  /** Exact run round and immutable commit expected by the caller. */
  round: number;
  candidate: string;
  workId?: string;
  workRound?: number;
  /** An internal cross-team prerequisite handoff, not a final delivery. */
  nodeId?: string;
}
export interface PipelineGateResult {
  allowed: boolean;
  runId: string;
  round: number;
  candidate: string;
  reasons: string[];
}
export interface PipelineStartInput {
  clientId: string;
  checkout?: string;
  base?: string;
  candidate?: string;
  /** A new review run may be bound to the receiving team's work round. */
  workId?: string;
  workRound?: number;
}
export interface PipelineBranchInput {
  runId: string;
  clientId: string;
  expectedRevision: number;
  selections: Record<string, PipelineValue>;
  rationale: string;
  /** Explicitly refresh intended bytes after implementation; old completions become stale. */
  candidate?: string;
}
export interface PipelineAssignInput {
  runId: string; clientId: string; expectedRevision: number; nodeId: string; agentId: string;
}
export interface PipelineReportInput {
  runId: string; clientId: string; expectedRevision: number; nodeId: string;
  evidence: PipelineEvidenceInput[]; notes: string;
}
export interface PipelineDoneInput extends PipelineReportInput {
  /** Existing crew reports to endorse; supplied evidence is added atomically. */
  evidenceIds?: string[];
}
/** POST /api/agent/pipeline/:start|branch|assign|done|report|status|gate */
export type PipelineAgentRequest<T> = T & { session: SessionInput };
export interface PipelineStatusInput { runId?: string }
export interface PipelineStatus { team: PipelineTeamView; run: PipelineRun | null; text: string }
