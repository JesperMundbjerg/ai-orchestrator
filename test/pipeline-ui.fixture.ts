// Scratch-only fixtures: imported by node/browser tests, never by the editor.
import type { PipelineGraph, PipelinePalette, PipelineRun, PipelineTeamView } from "../src/shared/pipeline.ts";
import { builtins } from "../src/ui/pipelines/model.ts";

export const graphFixture: PipelineGraph = {
  version: 1, id: "scratch-delivery", label: "Review, verify and deliver", entry: "kind",
  fields: [{ id: "science", label: "Scientific change?", type: "boolean" }],
  nodes: [
    { id: "kind", kind: "condition", label: "Scientific change?", field: "science", source: "builtin:condition" },
    { id: "review", kind: "step", label: "Physics accuracy review", source: "agent:.claude/agents/physics.md", evidence: ["report"], instructions: "Review the intended diff and record the first mate's disposition." },
    { id: "check", kind: "step", label: "Focused checks", source: "builtin:check", evidence: ["check"] },
    { id: "approval", kind: "approval", label: "Founder approves", source: "builtin:founder-approval", evidence: ["approval"] },
    { id: "deliver", kind: "delivery", label: "Deliver to dev", source: "builtin:deliver", delivery: "dev" },
  ],
  edges: [
    { id: "e-review", from: "kind", to: "review", port: "true" },
    { id: "e-check", from: "kind", to: "check", port: "false" },
    { id: "e-reviewed", from: "review", to: "approval" },
    { id: "e-checked", from: "check", to: "approval" },
    { id: "e-approved", from: "approval", to: "deliver" },
  ],
  positions: { kind: { x: 280, y: 0 }, review: { x: 0, y: 180 }, check: { x: 540, y: 180 }, approval: { x: 280, y: 370 }, deliver: { x: 280, y: 550 } },
};
export const paletteFixture: PipelinePalette = { teamId: "scratch", repoRoot: "/scratch/repo", problems: [], entries: [
  ...builtins,
  { id: "agent:.claude/agents/physics.md", label: "Physics accuracy review", description: "Scoped scientific accuracy report", kind: "agent", path: ".claude/agents/physics.md", hash: "scratch-hash" },
  { id: "skill:.agents/skills/visual-check/SKILL.md", label: "Visual check", description: "Review final owned preview", kind: "skill", path: ".agents/skills/visual-check/SKILL.md", hash: "scratch-hash" },
  { id: "command:.claude/commands/fix-comments.md", label: "Fix comments", description: "Resolve the assigned slice", kind: "command", path: ".claude/commands/fix-comments.md", hash: "scratch-hash" },
] };
export const runFixture: PipelineRun = {
  id: "scratch-wave", teamId: "scratch", leadId: "first-mate", graph: graphFixture, policyHash: "scratch-policy", definitionHashes: {}, revision: 4, round: 1,
  candidate: { checkout: "/scratch/repo", repoRoot: "/scratch/repo", base: "a".repeat(40), head: "b".repeat(40), tree: "c".repeat(40), fingerprint: "scratch-tree", changedPaths: ["src/lesson.ts"] },
  selections: { science: true }, rationale: "Scientific implementation changed; one scoped review for this wave.", state: "open", workId: null, workRound: null, createdAt: "2026-10-02T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z",
  steps: graphFixture.nodes.map((node) => ({ nodeId: node.id, state: node.id === "kind" ? "done" : node.id === "review" ? "stale" : node.id === "check" ? "inactive" : "blocked", assignedTo: node.id === "review" ? "reviewer" : null, completedBy: null, notes: "", evidence: node.id === "review" ? [{ id: "evidence-report", kind: "report", summary: "Accuracy report for the earlier candidate", url: "/files/scratch-report.txt", byAgentId: "reviewer", fingerprint: "earlier-tree", round: 1, createdAt: "2026-10-02T12:00:00Z" }] : [] })),
};
export const teamFixture: PipelineTeamView = { teamId: "scratch", repoRoot: "/scratch/repo", source: "repo", graph: graphFixture, revision: 0, layoutRevision: 0, policyHash: "scratch-policy", layout: graphFixture.positions!, problems: [], protected: true, runs: [runFixture] };
