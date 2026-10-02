import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, graphWarnings, nodeFromDefinition, ports, positionsFor, removeNode, runSummary, safeEvidenceUrl, stepState } from "../src/ui/pipelines/model.ts";
import { pipelineApi, PipelineRequestError } from "../src/ui/pipelines/api.ts";
import { graphFixture, paletteFixture, runFixture } from "./pipeline-ui.fixture.ts";

test("pipeline warnings find cycles and dangling endpoints without rejecting parallel all-of joins", () => {
  assert.deepEqual(graphWarnings(graphFixture), []);
  assert.ok(graphWarnings(connect(graphFixture, "approval", "kind")).some((warning) => warning.includes("Cycle")));
  assert.ok(graphWarnings(connect(graphFixture, "missing", "review")).some((warning) => warning.includes("Dangling")));
  assert.ok(graphWarnings(connect(graphFixture, "kind", "review", "removed")).some((warning) => warning.includes("valid branch")));
  const parallel = connect(graphFixture, "review", "check");
  assert.deepEqual(graphWarnings(parallel), []);
  assert.equal(connect(graphFixture, "kind", "review", "true"), graphFixture, "connecting an existing branch does not duplicate it");
});

test("deleting a node deletes incident connections and repo positions, but never silently picks another entry", () => {
  const removed = removeNode(graphFixture, "kind");
  assert.equal(removed.entry, "");
  assert.equal(removed.nodes.length, graphFixture.nodes.length - 1);
  assert.ok(removed.edges.every((edge) => edge.from !== "kind" && edge.to !== "kind"));
  assert.equal(removed.positions?.kind, undefined);
  assert.ok(graphWarnings(removed).some((warning) => warning.includes("entry")));
  assert.equal(graphFixture.entry, "kind", "input snapshot is untouched");
});

test("layout overrides positions without mutating policy or retaining deleted node ids", () => {
  const before = JSON.stringify(graphFixture);
  const positions = positionsFor(graphFixture, { review: { x: 700, y: 55 }, deleted: { x: 1, y: 1 } });
  assert.deepEqual(positions.review, { x: 700, y: 55 });
  assert.deepEqual(positions.check, graphFixture.positions!.check);
  assert.equal(positions.deleted, undefined);
  assert.equal(JSON.stringify(graphFixture), before);
});

test("branch handles use declared enum values or the boolean protocol, never inferred prose", () => {
  assert.deepEqual(ports(graphFixture, graphFixture.nodes[0]!), ["true", "false"]);
  const graph = { ...graphFixture, fields: [{ id: "science", label: "Kind?", type: "enum" as const, options: ["framework", "docs only"] }] };
  assert.deepEqual(ports(graph, graph.nodes[0]!), ["framework", "docs only"]);
  assert.deepEqual(ports(graph, graph.nodes[1]!), []);
});

test("discovered sources retain provenance and built-ins map to authoritative terminal kinds", () => {
  for (const definition of paletteFixture.entries) {
    const node = nodeFromDefinition(definition, "n-step");
    assert.equal(node.source, definition.id);
    if (definition.id === "builtin:founder-approval") assert.deepEqual(node.evidence, ["approval"]);
    if (definition.id === "builtin:deliver") assert.equal(node.delivery, "dev");
    if (definition.id === "builtin:handoff") assert.equal(node.delivery, "handoff");
  }
  assert.match(connect(graphFixture, "check", "review").edges.at(-1)!.id, /^[a-zA-Z][\w.-]{0,79}$/);
});

test("run display never treats a report or inactive branch as completed evidence", () => {
  assert.equal(stepState(undefined), "waiting");
  for (const state of ["blocked", "ready", "reported"] as const) assert.equal(stepState({ ...runFixture.steps[0]!, state }), "waiting");
  assert.equal(stepState({ ...runFixture.steps[0]!, state: "inactive" }), "skipped", "an inactive branch is not pending work");
  assert.equal(stepState({ ...runFixture.steps[0]!, state: "stale" }), "stale");
  assert.equal(stepState({ ...runFixture.steps[0]!, state: "done" }), "done");
  assert.equal(runSummary(runFixture), "1/4 done · 1 stale");
});

test("evidence links allow HTTP and served attachments, never executable protocols or file paths", () => {
  assert.equal(safeEvidenceUrl("/files/report.txt"), "/files/report.txt");
  assert.equal(safeEvidenceUrl("https://example.com/report"), "https://example.com/report");
  for (const value of ["javascript:alert(1)", "data:text/html,bad", "file:///tmp/report", "//evil.example/report", "/\\evil.example/report", "/\nevil", "report.md"]) assert.equal(safeEvidenceUrl(value), null, value);
});

test("HTTP writes carry the independent revision and expose conflicts without retrying or dropping the draft", async () => {
  const original = globalThis.fetch;
  const requests: Array<{ path: string; body: unknown }> = [];
  try {
    globalThis.fetch = async (path, init) => {
      requests.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ error: "layout changed; reload" }), { status: 409 });
    };
    await assert.rejects(pipelineApi.layout("team/one", { expectedRevision: 4, positions: { kind: { x: 5, y: 8 } } }), (error: unknown) => error instanceof PipelineRequestError && error.status === 409);
    assert.deepEqual(requests, [{ path: "/api/world/teams/team%2Fone/pipeline/layout", body: { expectedRevision: 4, positions: { kind: { x: 5, y: 8 } } } }]);
    requests.length = 0;
    await assert.rejects(pipelineApi.save("team", { expectedRevision: 9, graph: null }), /reload/);
    assert.deepEqual(requests[0]!.body, { expectedRevision: 9, graph: null });
  } finally { globalThis.fetch = original; }
});
