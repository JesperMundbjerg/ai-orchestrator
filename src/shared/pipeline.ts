// Vendor-neutral pipeline contract. The UI talks only to the office; repo paths are
// provenance labels, not instructions to branch on a harness or execute project code.
import type { SessionInput } from "./types.ts";

// Kept here so adapter and editor share one optional, vendor-neutral graph contract.
declare module "./types.ts" {
  interface ProjectAdapter { pipeline?: PipelineGraph | null }
}

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
  /** Default candidate; conditions are intrinsically run-bound. Planning reports may opt in. */
  binding?: "run" | "candidate";
  /** Delivery boundary; only delivery nodes may set this. */
  delivery?: "handoff" | "review" | "dev";
  /** Human guidance only: the service NEVER runs this command. */
  instructions?: string;
}
/** Names, prose and generic report/work sources do not identify planning unambiguously. */
export function nodeBinding(node: PipelineNode): "run" | "candidate" {
  return node.binding ?? (node.kind === "condition" ? "run" : "candidate");
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
  /** Each field must be read by a condition or guard in newly saved graphs. */
  fields: PipelineField[];
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Every node must be reachable from this start, and reach a delivery. */
  entry: string;
  pathRules?: PipelinePathRule[];
  /** Optional repo-default positions. Team layout remains a separate revision. */
  positions?: PipelineLayout;
}
/** Every modeled reader counts: branch conditions, edge guards and path-rule guards/requirements. */
export function referencedFieldIds(graph: Pick<PipelineGraph, "nodes" | "edges" | "pathRules">): Set<string> {
  const referenced = new Set(graph.nodes.filter(n => n.kind === "condition" && n.field).map(n => n.field!));
  for (const edge of graph.edges) if (edge.when) referenced.add(edge.when.field);
  for (const rule of graph.pathRules ?? []) {
    if (rule.when) referenced.add(rule.when.field);
    if (rule.require) referenced.add(rule.require.field);
  }
  return referenced;
}

/** Pure shared policy check; only fields nothing reads are orphaned. */
export function orphanFieldProblems(graph: Pick<PipelineGraph, "fields" | "nodes" | "edges" | "pathRules">): Array<{ path: string; message: string }> {
  const referenced = referencedFieldIds(graph);
  return graph.fields.flatMap((field, index) => referenced.has(field.id) ? [] : [{
    path: `fields.${index}.id`, message: `field ${field.id} (${field.label}) is not referenced by any condition or guard; remove it or reference it in the graph`,
  }]);
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
  /** Intended changed paths, final blob ids/modes and deletions; independent of commit metadata. */
  fingerprint: string;
  /** Missing on legacy whole-tree snapshots; those are kept valid until an explicit re-base. */
  fingerprintVersion?: 2;
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
  /**
   * A check run on the run's base, not the candidate. It records how the base behaves, so a
   * candidate check that fails the same way (same command, same exit code) can count as
   * "fails as on base". It never satisfies a required check by itself.
   */
  onBase?: boolean;
}
export interface PipelineEvidence extends PipelineEvidenceInput {
  id: string;
  byAgentId: string;
  /** Candidate bytes hash, or a run/scope identity token for run-bound evidence. */
  fingerprint: string;
  binding?: "run" | "candidate";
  round: number;
  createdAt: string;
  sha256?: string;
  /** Browser-safe URL for the copied, hash-bound evidence; never link storedPath. */
  fileUrl?: string;
  /** Stored attachment path outside worktrees; the original path is not read again. */
  storedPath?: string;
  /** For an onBase check: the base commit it was recorded against. */
  ranOn?: string;
}
export interface PipelineStep {
  nodeId: string;
  state: "inactive" | "blocked" | "ready" | "reported" | "done" | "stale";
  assignedTo: string | null;
  completedBy: string | null;
  evidence: PipelineEvidence[];
  notes: string;
  /** Why current evidence does not count, from the same evaluator the delivery gate uses. */
  problems?: string[];
  /** Counted checks that fail exactly as recorded on the base; shown as "fails as on base", never as a pass. */
  baselineFailures?: string[];
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
  /** Monotonic selection-scope revision prevents old plans reviving after toggling back. */
  scopeRevision?: number;
  candidate: PipelineCandidate;
  selections: Record<string, PipelineValue>;
  rationale: string;
  steps: PipelineStep[];
  state: "open" | "delivered" | "abandoned";
  /** A dev run's delivery, observed rather than claimed: its exact candidate was on this published
   * branch ref (`refs/remotes/origin/dev`, or the local branch in a repository with no remotes) at `tip`. */
  landed?: { ref: string; tip: string; at: string };
  /** Terminal closure, without deleting the candidate, graph or evidence. */
  abandonment?: { notes: string; byAgentId: string; at: string };
  /** Append-only re-base history, retained with evidence even after closure. */
  rebases?: { oldBase: string; newBase: string; notes: string; byAgentId: string; at: string }[];
  /** What this run put in front of the founder, and work it handed over, at which round and
   * selection scope. An approval or review verdict authorizes only that run, round, scope and
   * intended bytes. Runs recorded before this field rely on the binding's run and bytes alone. */
  provenance?: PipelineProvenance[];
  /** Its team is gone: finished/disbanded, merged into another, or its checkout went missing.
   * The run is kept as recorded and readable, but never edited, presented or delivered. */
  archived?: PipelineArchive;
  workId: string | null;
  workRound: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface PipelineArchive {
  reason: "deleted" | "merged" | "missing";
  /** The team's name when it went, since its record is gone. */
  teamName: string;
  mergedInto?: { teamId: string; teamName: string };
  at: string;
}
export interface PipelineProvenance {
  kind: "approval" | "review";
  /** Item id for an approval, work id for a review. */
  id: string;
  /** Item revision for an approval, work round for a review. */
  revision: number;
  round: number;
  scopeRevision: number;
  fingerprint: string;
}
/** Why a run is archived, for the briefing, gate refusals and Runs alike. */
export function archivedText(archive: PipelineArchive): string {
  return archive.reason === "merged" ? `${archive.teamName} was merged into ${archive.mergedInto?.teamName ?? "another team"}`
    : archive.reason === "deleted" ? `${archive.teamName} was finished or disbanded` : `${archive.teamName} is gone (its checkout went missing)`;
}
export interface PipelineGateInput {
  runId: string;
  delivery: "handoff" | "review" | "dev";
  /** Repo-local hooks use these for protected Git delivery (release is not a v1 boundary). */
  operation?: "push" | "pr" | "merge" | "land" | "publish";
  repo?: string;
  ref?: string;
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
  /** Required steps that count only because a check fails as on base; present even when allowed. */
  baselineFailures?: string[];
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
  /** Required for ordinary branch edits; optional for replay-safe re-base commands. */
  expectedRevision?: number;
  /** Already published integration commit, ancestral to the checked-out candidate. */
  base?: string;
  selections: Record<string, PipelineValue>;
  rationale: string;
  /** Explicitly refresh intended bytes after implementation; old completions become stale. */
  candidate?: string;
}
export interface PipelineAbandonInput {
  runId: string; clientId: string; notes: string;
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
/** POST /api/agent/pipeline/:start|branch|abandon|assign|done|report|status|gate */
export type PipelineAgentRequest<T> = T & { session: SessionInput };
export interface PipelineStatusInput { runId?: string }
export interface PipelineStatus { team: PipelineTeamView; run: PipelineRun | null; text: string }
