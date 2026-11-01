import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { openDatabase } from "../src/server/db.ts";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph = JSON.parse(readFileSync(new URL("./fixtures/pipelines/fysiklab-default.json", import.meta.url), "utf8")).pipeline as PipelineGraph;

/** A team with several runs, and a world that counts how often the office is asked to work it out. */
function office(t: { after(fn: () => void): void }, runs: number) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-world-")); const root = join(dir, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, stdio: "ignore" });
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
  let computed = 0;
  const p = new Pipelines(db, () => { computed++; return state; }, { evidenceDir: join(dir, "evidence") });
  for (let i = 0; i < runs; i++) p.start(lead, { clientId: `run-${i}` });
  return { p, lead, computed: () => computed, reset: () => void (computed = 0) };
}

test("a status read works the office out once, however many runs the team has", (t) => {
  const { p, lead, computed, reset } = office(t, 6);
  reset();
  const status = p.status(lead);
  assert.ok(status.team.runs.length >= 6, "the read covers the team's runs");
  assert.equal(computed(), 1, "one status read, one world");
});

test("the next read sees the office as it is then, not the last request's", (t) => {
  const { p, lead, computed, reset } = office(t, 2);
  p.status(lead); reset();
  p.status(lead);
  assert.equal(computed(), 1);
  p.status(lead);
  assert.equal(computed(), 2, "nothing is kept between requests");
});
