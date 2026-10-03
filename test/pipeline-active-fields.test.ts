import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selected, activation } from "../src/server/pipelines/model.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { openDatabase } from "../src/server/db.ts";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Read-only copy of the FysikLab policy; no project commands or harnesses run.
const graph = JSON.parse(readFileSync(new URL("./fixtures/pipelines/fysiklab-default.json", import.meta.url), "utf8")).pipeline as PipelineGraph;
const existing = { kind: "existing-lesson", glb: false, camera: false, structural: false, scientific: false, voice: false,
  dispatched: false, danish: false, sharedComments: false, legal: false, metadata: false, frameAudit: false,
  finishedAudit: false, format: "lesson", visible: false, showRequested: false, approvalRequired: false };

test("FysikLab existing-lesson requires only active readers; inactive supplied choices cannot activate new content", () => {
  assert.deepEqual(selected(graph, existing), []);
  const before = activation(graph, existing).active;
  const extra = { ...existing, target: "new-chapter", writtenSpec: true, chapterCritics: "all", stepCritics: "all", labCritics: "all", coreSim: false };
  assert.deepEqual(selected(graph, extra), []);
  assert.deepEqual(activation(graph, extra).active, before);
  assert.equal(before.has("chapter"), false);
  assert.ok(selected(graph, { ...existing, kind: "new-lesson" }).includes("select New content target"));
  assert.ok(selected(graph, { ...existing, kind: "new-lesson", target: "new-chapter" }).includes("select Explicitly named chapter design critics"));
  assert.ok(selected(graph, { ...existing, kind: "new-lesson", target: "new-step" }).includes("select Written step spec already banked?"));
  assert.ok(selected(graph, { ...existing, scientific: undefined } as unknown as Record<string, string | boolean>).includes("select Scientific scope not already covered?"));
});

test("unresolved active conditions and guards require their inputs, not inactive downstream fields", () => {
  assert.deepEqual(selected(graph, {}), ["select Primary work kind", "select Additional architecture scope not already covered?", "select Final user-visible change?"]);
  const missingGlb = { ...existing }; delete (missingGlb as Partial<typeof existing>).glb;
  assert.ok(selected(graph, missingGlb).includes("select Runtime GLB integration?"));
  assert.ok(selected(graph, { ...existing, target: "invalid" }).includes("select New content target"), "supplied inactive values still have declared types/options");
});

test("an existing open FysikLab snapshot accepts corrected active-only selections without restarting", t => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-active-")); const root = join(dir, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "ignore" });
  // A new run snapshots real source versions; fixture resources contain no executable code.
  for (const source of new Set(graph.nodes.map(node => node.source).filter((source): source is string => Boolean(source) && !source!.startsWith("builtin:")))) {
    const file = join(root, source.slice(source.indexOf(":") + 1));
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "# Synthetic workflow resource\n");
  }
  git("init", "-q", "-b", "dev"); writeFileSync(join(root, "sample.txt"), "synthetic candidate\n"); git("add", "."); git("commit", "-qm", "base");
  const db = openDatabase(join(dir, "office.sqlite"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const lead = { id: "lead", name: "Lead", teamId: "team", role: "lead", cwd: root } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "team", name: "Synthetic", standing: true, path: null, worktrees: [root] }] } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('team', 'Synthetic', 1, 'now')").run();
  db.prepare("INSERT INTO team_pipelines (team_id, repo_root, graph) VALUES ('team', ?, ?)").run(root, JSON.stringify(graph));
  let p = new Pipelines(db, () => state, { evidenceDir: join(dir, "evidence") });
  const started = p.start(lead, { clientId: "existing-open-run" });
  p = new Pipelines(db, () => state, { evidenceDir: join(dir, "evidence") });
  const run = p.branch(lead, { runId: started.id, clientId: "active-only", expectedRevision: started.revision, selections: existing, rationale: "Existing lesson scope; new content branches do not apply" });
  assert.equal(run.id, started.id); assert.equal(run.round, started.round); assert.deepEqual(run.selections, existing);
  const gate = p.gate(lead, { runId: run.id, candidate: run.candidate.head, round: run.round, delivery: "dev" });
  assert.equal(gate.allowed, false, "unfinished evidence still blocks delivery");
  assert.ok(gate.reasons.every(reason => !reason.startsWith("select ")), gate.reasons.join("; "));
});
