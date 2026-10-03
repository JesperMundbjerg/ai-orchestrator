import type { PipelineGraph, PipelineLayout, PipelineNode } from "../../shared/pipeline.ts";
import { ports } from "./model.ts";

/** Shared with the rendered cards, so layout accounts for wide branch labels and
 * multiline titles rather than assuming every node fits a fixed small rectangle. */
export function cardSize(graph: PipelineGraph, node: PipelineNode): { width: number; height: number } {
  const branches = ports(graph, node);
  const portWidth = Math.max(100, ...branches.map((port) => Array.from(port).length * 11 + 20));
  const width = Math.max(238, branches.length * (portWidth + 8) + 28);
  const lines = (text: string, fontSize: number) => Math.max(1, Math.ceil(Array.from(text).length * fontSize / (width - 30)));
  const rule = node.evidence?.join(" + ") || (node.kind === "condition" ? "First mate chooses" : "Lead-owned step");
  const height = Math.max(116, 26 + 12 + 5 + lines(node.label, 14) * 20 + 7 + lines(rule, 11) * 16 + (branches.length ? 46 : 0));
  return { width, height };
}

/** Deterministic longest-path layers, top-down, with stable id ordering.
 * Invalid cycles go in a final repair layer; dangling edges are ignored. Neither
 * policy nor repo-default positions are mutated. Only Save layout persists this. */
export function tidyLayout(graph: PipelineGraph): PipelineLayout {
  const nodes = [...graph.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const ranks = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of graph.edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to)) continue;
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = nodes.filter((node) => !incoming.get(node.id)).map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    for (const target of outgoing.get(id)!) {
      ranks.set(target, Math.max(ranks.get(target)!, ranks.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (!incoming.get(target)) queue.push(target);
    }
  }
  const repairRank = Math.max(0, ...ranks.values()) + 1;
  const layers = new Map<number, PipelineNode[]>();
  for (const node of nodes) {
    const rank = incoming.get(node.id) ? repairRank : ranks.get(node.id)!;
    const layer = layers.get(rank) ?? [];
    layer.push(node); layers.set(rank, layer);
  }
  const sizes = new Map(nodes.map((node) => [node.id, cardSize(graph, node)]));
  const gapX = 64, gapY = 80;
  const widths = new Map([...layers].map(([rank, layer]) => [rank, layer.reduce((sum, node) => sum + sizes.get(node.id)!.width, 0) + (layer.length - 1) * gapX]));
  const widest = Math.max(0, ...widths.values());
  const positions: PipelineLayout = {};
  let y = 0;
  for (const [rank, layer] of [...layers].sort(([a], [b]) => a - b)) {
    let x = (widest - widths.get(rank)!) / 2;
    for (const node of layer) {
      positions[node.id] = { x, y };
      x += sizes.get(node.id)!.width + gapX;
    }
    y += Math.max(...layer.map((node) => sizes.get(node.id)!.height)) + gapY;
  }
  return positions;
}
