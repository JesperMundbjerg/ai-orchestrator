// Pure pipeline validation and activation. Nothing here executes repository instructions.
import type { PipelineGraph, PipelineLayout, PipelineMatch, PipelineValue } from "../../shared/pipeline.ts";
import { InboxError } from "../inbox.ts";
import { requestFingerprint } from "../db.ts";

const bad = (message: string): never => { throw new InboxError(422, `pipeline: ${message}`, "pipeline_invalid"); };
const obj = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad("expected an object");
  return v as Record<string, unknown>;
};
const id = (v: unknown): string => typeof v === "string" && /^[a-zA-Z][\w.-]{0,79}$/.test(v) ? v : bad("ids must start with a letter and contain at most 80 letters, digits, dashes, dots or underscores");
const text = (v: unknown): string => typeof v === "string" && v.trim() && v.length <= 4000 ? v : bad("expected non-empty text (at most 4000 characters)");
const arr = (v: unknown): unknown[] => Array.isArray(v) && v.length <= 250 ? v : bad("expected a list (at most 250 entries)");
export function validateLayout(input: unknown): PipelineLayout {
  const out: PipelineLayout = {};
  for (const [key, value] of Object.entries(obj(input))) {
    id(key); const p = obj(value);
    if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) bad("positions must be finite, bounded coordinates");
    out[key] = { x: p.x as number, y: p.y as number };
  }
  if (Object.keys(out).length > 250) bad("too many positions");
  return out;
}
export function validateGraph(input: unknown): PipelineGraph {
  const g = obj(input);
  if (g.version !== 1) bad("version must be 1");
  const fields = arr(g.fields).map(v => {
    const f = obj(v); const type = f.type;
    if (type !== "enum" && type !== "boolean") bad("field type must be enum or boolean");
    const options = type === "enum" ? arr(f.options).map(text) : undefined;
    if (options && (options.length < 2 || new Set(options).size !== options.length)) bad("enum fields need at least two distinct options");
    return { id: id(f.id), label: text(f.label), type: type as "enum" | "boolean", ...(options ? { options } : {}) };
  });
  const fieldMap = new Map(fields.map(f => [f.id, f]));
  if (fieldMap.size !== fields.length) bad("duplicate field");
  const match = (v: unknown): PipelineMatch => {
    const m = obj(v); const field = id(m.field); const f = fieldMap.get(field);
    if (!f || (f.type === "boolean" ? typeof m.equals !== "boolean" : !f.options!.includes(m.equals as string))) bad(`invalid match for ${field}`);
    return { field, equals: m.equals as PipelineValue };
  };
  const nodes = arr(g.nodes).map(v => {
    const n = obj(v); const kind = n.kind;
    if (!["step", "condition", "approval", "delivery"].includes(kind as string)) bad("unknown node kind");
    const evidence = n.evidence === undefined ? [] : arr(n.evidence).map(e => {
      if (!["report", "check", "artifact", "review", "approval"].includes(e as string)) bad("unknown evidence kind");
      return e as "report" | "check" | "artifact" | "review" | "approval";
    });
    if (new Set(evidence).size !== evidence.length) bad("duplicate evidence requirement");
    if (kind === "condition" && !fieldMap.has(n.field as string)) bad("condition needs a declared field");
    if (kind === "delivery" ? !["handoff", "review", "dev"].includes(n.delivery as string) : n.delivery !== undefined) bad("only delivery nodes may name a delivery boundary");
    if ((kind === "step" || kind === "approval") && (typeof n.source !== "string" || !n.source.trim())) bad("step/approval needs a palette source");
    if (kind === "approval" && !evidence.includes("approval")) evidence.push("approval");
    if (kind === "step" && !evidence.length) bad("steps need at least one evidence requirement");
    return { id: id(n.id), label: text(n.label), kind: kind as "step" | "condition" | "approval" | "delivery", evidence,
      ...(n.source !== undefined ? { source: text(n.source) } : {}), ...(n.field !== undefined ? { field: id(n.field) } : {}),
      ...(kind === "delivery" ? { delivery: n.delivery as "handoff" | "review" | "dev" } : {}), ...(n.instructions !== undefined ? { instructions: text(n.instructions) } : {}) };
  });
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  if (!nodes.length || nodeMap.size !== nodes.length) bad("missing or duplicate nodes");
  const edges = arr(g.edges).map(v => {
    const e = obj(v); const from = id(e.from); const to = id(e.to); const parent = nodeMap.get(from);
    if (!parent || !nodeMap.has(to) || from === to) bad("edge has missing endpoints or points to itself");
    if (parent!.kind === "delivery") bad("delivery must be a terminal node");
    if (parent!.kind === "condition") {
      const f = fieldMap.get(parent!.field!)!; const ports = f.type === "boolean" ? ["true", "false"] : f.options!;
      if (!ports.includes(e.port as string)) bad("condition edges need a valid port");
    } else if (e.port !== undefined) bad("ports belong only to conditions");
    return { id: id(e.id), from, to, ...(e.port !== undefined ? { port: String(e.port) } : {}), ...(e.when !== undefined ? { when: match(e.when) } : {}) };
  });
  if (new Set(edges.map(e => e.id)).size !== edges.length) bad("duplicate edge id");
  const entry = id(g.entry);
  if (!nodeMap.has(entry) || edges.some(e => e.to === entry)) bad("entry must be a root node");
  for (const n of nodes.filter(n => n.kind === "condition")) {
    const f = fieldMap.get(n.field!)!;
    for (const port of f.type === "boolean" ? ["true", "false"] : f.options!) if (!edges.some(e => e.from === n.id && e.port === port && !e.when)) bad(`condition ${n.id} has no unconditional ${port} branch`);
  }
  const graph: PipelineGraph = { version: 1, id: id(g.id), label: text(g.label), fields, nodes, edges, entry,
    ...(g.positions !== undefined ? { positions: validateLayout(g.positions) } : {}) };
  if (graph.positions && Object.keys(graph.positions).some(k => !nodeMap.has(k))) bad("layout references a missing node");
  if (g.pathRules !== undefined) graph.pathRules = arr(g.pathRules).map(v => {
    const r = obj(v); const prefixes = arr(r.prefixes).map(text);
    if (!prefixes.length || prefixes.some(p => p.startsWith("/") || p.split("/").includes("..") || p.includes("\\") || p.includes("\0"))) bad("path prefixes must be repo-relative");
    if (r.only !== undefined && typeof r.only !== "boolean") bad("only must be boolean");
    if (!r.only && r.require === undefined) bad("path rule needs only or require");
    return { prefixes, message: text(r.message), ...(r.when !== undefined ? { when: match(r.when) } : {}), ...(r.require !== undefined ? { require: match(r.require) } : {}), ...(r.only !== undefined ? { only: r.only as boolean } : {}) };
  });
  topological(graph);
  const reachable = new Set([entry]);
  for (const n of topological(graph)) if (reachable.has(n)) for (const e of edges.filter(e => e.from === n)) reachable.add(e.to);
  if (reachable.size !== nodes.length) bad("all nodes must be reachable from entry");
  const finishes = new Set(nodes.filter(n => n.kind === "delivery").map(n => n.id));
  for (const n of topological(graph).reverse()) if (edges.some(e => e.from === n && finishes.has(e.to))) finishes.add(n);
  if (finishes.size !== nodes.length) bad("all nodes must lead to a delivery");
  return graph;
}
export function topological(g: PipelineGraph): string[] {
  const result: string[] = []; const remaining = new Set(g.nodes.map(n => n.id));
  while (remaining.size) {
    const ready = [...remaining].filter(n => !g.edges.some(e => e.to === n && remaining.has(e.from)));
    if (!ready.length) bad("cycles are not allowed");
    ready.forEach(n => { remaining.delete(n); result.push(n); });
  }
  return result;
}
export function policyHash(g: PipelineGraph): string { const { positions: _positions, ...policy } = g; return requestFingerprint(policy); }
export function selected(g: PipelineGraph, values: Record<string, PipelineValue>): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(values)) if (!g.fields.some(f => f.id === key)) problems.push(`unknown selection ${key}`);
  const required = new Set<string>(); const active = new Set([g.entry]);
  for (const key of topological(g)) {
    if (!active.has(key)) continue;
    const node = g.nodes.find(n => n.id === key)!;
    if (node.kind === "condition") required.add(node.field!);
    for (const edge of g.edges.filter(e => e.from === key)) {
      // An unresolved condition stops here; inactive ports do not read their guards.
      if (node.kind === "condition" && String(values[node.field!]) !== edge.port) continue;
      if (edge.when) {
        required.add(edge.when.field);
        if (values[edge.when.field] !== edge.when.equals) continue;
      }
      active.add(edge.to);
    }
  }
  // Path rules are graph-wide readers, not tied to an inactive node.
  for (const rule of g.pathRules ?? []) {
    if (rule.when) { required.add(rule.when.field); if (values[rule.when.field] !== rule.when.equals) continue; }
    if (rule.require) required.add(rule.require.field);
  }
  for (const f of g.fields) if ((required.has(f.id) || Object.hasOwn(values, f.id)) && (f.type === "boolean" ? typeof values[f.id] !== "boolean" : !f.options!.includes(values[f.id] as string))) problems.push(`select ${f.label}`);
  return problems;
}
export function activation(g: PipelineGraph, values: Record<string, PipelineValue>): { active: Set<string>; edges: Set<string> } {
  const active = new Set([g.entry]); const edges = new Set<string>();
  for (const id of topological(g)) {
    if (!active.has(id)) continue;
    const node = g.nodes.find(n => n.id === id)!;
    for (const e of g.edges.filter(e => e.from === id)) {
      if (node.kind === "condition" && String(values[node.field!]) !== e.port) continue;
      if (e.when && values[e.when.field] !== e.when.equals) continue;
      edges.add(e.id); active.add(e.to);
    }
  }
  return { active, edges };
}
export function pathProblems(g: PipelineGraph, values: Record<string, PipelineValue>, paths: string[]): string[] {
  const match = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  return (g.pathRules ?? []).filter(r => !r.when || values[r.when.field] === r.when.equals).filter(r =>
    (r.only && paths.some(p => !r.prefixes.some(prefix => match(p, prefix)))) ||
    (r.require && paths.some(p => r.prefixes.some(prefix => match(p, prefix))) && values[r.require.field] !== r.require.equals)).map(r => r.message);
}
