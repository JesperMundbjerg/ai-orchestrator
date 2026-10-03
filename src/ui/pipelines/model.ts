import type { PipelineDefinition, PipelineEdge, PipelineGraph, PipelineLayout, PipelineNode, PipelineRun, PipelineStep } from "../../shared/pipeline.ts";

export function ports(graph: PipelineGraph, node: PipelineNode): string[] {
  if (node.kind !== "condition") return [];
  const field = graph.fields.find((f) => f.id === node.field);
  return field?.type === "boolean" ? ["true", "false"] : field?.options ?? [];
}

/** Advisory only. The office validates reachability, branch bypass and evidence authoritatively. */
export function graphWarnings(graph: PipelineGraph): string[] {
  const warnings: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (ids.size !== graph.nodes.length) warnings.push("Step ids must be unique.");
  if (!ids.has(graph.entry)) warnings.push("Choose an entry step that exists in the graph.");
  const incoming = new Map([...ids].map((id) => [id, 0]));
  const outgoing = new Map([...ids].map((id) => [id, [] as string[]]));
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      warnings.push(`Dangling connection ${edge.id}: a step is missing.`);
      continue;
    }
    const source = graph.nodes.find((n) => n.id === edge.from)!;
    if (source.kind === "condition" && !ports(graph, source).includes(edge.port ?? "")) warnings.push(`Connection ${edge.id} needs a valid branch on ${source.label}.`);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = [...ids].filter((id) => incoming.get(id) === 0);
  let visited = 0;
  for (let index = 0; index < queue.length; index++) {
    visited++;
    for (const target of outgoing.get(queue[index]!)!) {
      incoming.set(target, incoming.get(target)! - 1);
      if (!incoming.get(target)) queue.push(target);
    }
  }
  if (visited !== ids.size) warnings.push("Cycle detected. Repairs need new evidence, not a connection back to an earlier step.");
  for (const node of graph.nodes) if (node.kind === "condition" && !ports(graph, node).length) warnings.push(`${node.label} needs a declared condition field and branches.`);
  return warnings;
}

export function connect(graph: PipelineGraph, from: string, to: string, port?: string): PipelineGraph {
  if (graph.edges.some((e) => e.from === from && e.to === to && e.port === port)) return graph;
  const edge: PipelineEdge = { id: `e-${crypto.randomUUID()}`, from, to, ...(port ? { port } : {}) };
  return { ...graph, edges: [...graph.edges, edge] };
}

/** Conditions and deterministic guards can all read a field. */
function readsField(graph: PipelineGraph, field: string): boolean {
  return graph.nodes.some((node) => node.field === field)
    || graph.edges.some((edge) => edge.when?.field === field)
    || (graph.pathRules ?? []).some((rule) => rule.when?.field === field || rule.require?.field === field);
}

/** Remove incident edges/positions and only the deleted condition's unused field.
 * Other declared fields are untouched: the office owns policy validation. */
export function removeNode(graph: PipelineGraph, id: string): PipelineGraph {
  const deleted = graph.nodes.find((node) => node.id === id);
  const next = { ...graph, nodes: graph.nodes.filter((n) => n.id !== id), edges: graph.edges.filter((e) => e.from !== id && e.to !== id), entry: graph.entry === id ? "" : graph.entry,
    ...(graph.positions ? { positions: Object.fromEntries(Object.entries(graph.positions).filter(([key]) => key !== id)) } : {}) };
  if (deleted?.kind === "condition" && deleted.field && !readsField(next, deleted.field)) {
    next.fields = next.fields.filter((field) => field.id !== deleted.field);
  }
  return next;
}

export function positionsFor(graph: PipelineGraph, layout: PipelineLayout): PipelineLayout {
  return Object.fromEntries(graph.nodes.map((n, i) => [n.id, layout[n.id] ?? graph.positions?.[n.id] ?? { x: (i % 3) * 280, y: Math.floor(i / 3) * 180 }]));
}

/** A closed run's unfinished steps are not waiting for anyone: they say why they never will. */
export function stepState(step?: PipelineStep, run?: Pick<PipelineRun, "state" | "archived">): "waiting" | "done" | "stale" | "skipped" | "abandoned" | "archived" {
  if (step?.state === "inactive") return "skipped";
  if (step?.state === "done") return "done";
  if (run?.state === "abandoned") return "abandoned";
  if (run?.archived && run.state !== "delivered") return "archived";
  return step?.state === "stale" ? "stale" : "waiting";
}

/** Links are evidence, never executable protocols or arbitrary local paths. */
export function safeEvidenceUrl(value?: string): string | null {
  if (!value) return null;
  if (/^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)) return value;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}

export function runSummary(run: PipelineRun): string {
  const active = run.steps.filter((step) => step.state !== "inactive");
  const done = active.filter((step) => step.state === "done").length;
  const stale = active.filter((step) => step.state === "stale").length;
  return `${done}/${active.length} done${stale ? ` · ${stale} stale` : ""}`;
}

export const builtins: PipelineDefinition[] = [
  { id: "builtin:check", label: "Run a check", description: "Command, exit status and log", kind: "builtin", path: null, hash: null },
  { id: "builtin:condition", label: "Condition", description: "First mate selects a labelled branch", kind: "builtin", path: null, hash: null },
  { id: "builtin:founder-approval", label: "Founder approves", description: "Acceptance at the matching revision", kind: "builtin", path: null, hash: null },
  { id: "builtin:handoff", label: "Hand off to a team", description: "First mate hands work to its receiver", kind: "builtin", path: null, hash: null },
  { id: "builtin:deliver", label: "Deliver to dev", description: "Land pinned candidate and publish dev", kind: "builtin", path: null, hash: null },
];

export function nodeFromDefinition(definition: PipelineDefinition, id: string): PipelineNode {
  const base = { id, label: definition.label, source: definition.id };
  switch (definition.id) {
    case "builtin:condition": return { ...base, kind: "condition", field: `branch-${id}` };
    case "builtin:founder-approval": return { ...base, kind: "approval", evidence: ["approval"] };
    case "builtin:handoff": return { ...base, kind: "delivery", delivery: "handoff" };
    case "builtin:deliver": return { ...base, kind: "delivery", delivery: "dev" };
    case "builtin:review": return { ...base, kind: "delivery", delivery: "review" };
    default: return { ...base, kind: "step", evidence: [definition.id === "builtin:check" ? "check" : "report"] };
  }
}
