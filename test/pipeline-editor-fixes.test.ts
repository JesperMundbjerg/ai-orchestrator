import assert from "node:assert/strict";
import { test } from "node:test";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import { removeNode } from "../src/ui/pipelines/model.ts";
import { cardSize, tidyLayout } from "../src/ui/pipelines/layout.ts";
import { graphFixture } from "./pipeline-ui.fixture.ts";

function assertSeparated(graph: PipelineGraph) {
  const before = JSON.stringify(graph);
  const positions = tidyLayout(graph);
  assert.equal(JSON.stringify(graph), before, "layout never mutates policy or repo positions");
  assert.deepEqual(Object.keys(positions).sort(), graph.nodes.map((n) => n.id).sort());
  for (const a of graph.nodes) for (const b of graph.nodes) {
    if (a.id >= b.id) continue;
    const p = positions[a.id]!, q = positions[b.id]!;
    const sa = cardSize(graph, a), sb = cardSize(graph, b);
    assert.ok(p.x + sa.width < q.x || q.x + sb.width < p.x || p.y + sa.height < q.y || q.y + sb.height < p.y, `${a.id} / ${b.id} overlap`);
  }
  return positions;
}

test("deleting a condition drops its field unless another node still selects it", () => {
  const before = JSON.stringify(graphFixture);
  assert.deepEqual(removeNode(graphFixture, "kind").fields, []);
  const shared = { ...graphFixture, nodes: [...graphFixture.nodes, { ...graphFixture.nodes[0]!, id: "other-condition" }] };
  assert.deepEqual(removeNode(shared, "kind").fields, graphFixture.fields);
  assert.deepEqual(removeNode(removeNode(shared, "kind"), "other-condition").fields, []);
  assert.equal(JSON.stringify(graphFixture), before);
});

test("deleting a condition preserves fields read by edge/activation and path guards", () => {
  for (const guard of [
    { edges: [...graphFixture.edges, { id: "guard", from: "review", to: "check", when: { field: "science", equals: true } }] },
    { pathRules: [{ prefixes: ["docs/"], when: { field: "science", equals: true }, message: "Conditional path guard" }] },
    { pathRules: [{ prefixes: ["docs/"], require: { field: "science", equals: true }, message: "Required path guard" }] },
  ]) {
    const graph: PipelineGraph = { ...graphFixture, ...guard };
    const removed = removeNode(graph, "kind");
    assert.deepEqual(removed.fields, graphFixture.fields);
    assert.deepEqual(removed.pathRules, graph.pathRules);
  }
  const graph: PipelineGraph = { ...graphFixture, fields: [...graphFixture.fields, { id: "other", label: "Other declaration", type: "boolean" }] };
  assert.deepEqual(removeNode(graph, "kind").fields, [graph.fields[1]!], "unrelated declarations remain for office validation");
  assert.deepEqual(removeNode(graph, "review").fields, graph.fields);
});

test("tidy layout uses top-down longest-path layers, stable ordering and no overlapping cards", () => {
  const positions = assertSeparated(graphFixture);
  for (const edge of graphFixture.edges) assert.ok(positions[edge.from]!.y < positions[edge.to]!.y);
  assert.deepEqual(tidyLayout({ ...graphFixture, nodes: [...graphFixture.nodes].reverse(), edges: [...graphFixture.edges].reverse() }), positions);
});

test("wide multi-port labels and long titles fit card geometry in a 92-node draft", () => {
  const options = Array.from({ length: 8 }, (_, i) => `readable-named-branch-${i}`);
  const graph: PipelineGraph = { ...graphFixture,
    fields: [{ id: "choice", label: "Choice", type: "enum", options }],
    nodes: Array.from({ length: 92 }, (_, i) => ({ id: `node-${String(i).padStart(2, "0")}`, label: i % 5 ? `Step ${i}` : "A very long descriptive title ".repeat(12), kind: i % 7 ? "step" : "condition", ...(i % 7 ? {} : { field: "choice" }) })),
    edges: Array.from({ length: 91 }, (_, i) => ({ id: `edge-${i}`, from: `node-${String(Math.floor(i / 2)).padStart(2, "0")}`, to: `node-${String(i + 1).padStart(2, "0")}` })),
  };
  const positions = assertSeparated(graph);
  for (const edge of graph.edges) assert.ok(positions[edge.from]!.y < positions[edge.to]!.y);
  const size = cardSize(graph, graph.nodes[0]!);
  assert.ok(size.width > options.length * Math.max(...options.map((port) => port.length * 11)));
  assert.ok(size.height > 116, "multiline title reserves additional space");
});

test("tidy still gives disconnected and cyclic repair drafts finite non-overlapping positions", () => {
  assert.deepEqual(tidyLayout({ ...graphFixture, nodes: [], edges: [] }), {});
  assertSeparated({ ...graphFixture, edges: [] });
  assertSeparated({ ...graphFixture, edges: [...graphFixture.edges, { id: "cycle", from: "deliver", to: "kind" }, { id: "dangling", from: "missing", to: "review" }] });
});
