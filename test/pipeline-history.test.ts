import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type AgentSource } from "../src/server/world.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { migratePipelines } from "../src/server/pipelines/migration.ts";
import { stepState } from "../src/ui/pipelines/model.ts";
import type { PipelineGraph, PipelineRun, PipelineStep } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph: PipelineGraph = { version: 1, id: "wave", label: "Bounded delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["report"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "handoff" }],
  edges: [{ id: "finish", from: "checks", to: "deliver" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const scratch = (t: TestContext) => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-history-"))); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const count = (db: ReturnType<typeof openDatabase>, table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);

/** A completed run with a stored evidence file, on a team the office then lets go of. */
function completedRun(t: TestContext) {
  const dir = scratch(t); const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as unknown as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const start = { clientId: "wave-1" };
  let run = p.start(lead, start);
  const report = join(dir, "report.md"); writeFileSync(report, "Checked the whole scope");
  run = p.done(lead, { runId: run.id, clientId: "checked", expectedRevision: run.revision, nodeId: "checks", notes: "Reviewed", evidence: [{ kind: "report", summary: "Scoped review", path: report }] });
  assert.equal(p.gate(lead, { runId: run.id, delivery: "handoff", round: run.round, candidate: run.candidate.head }).allowed, true);
  return { db, p, state, lead, run, start };
}

test("a deleted team's run, evidence file and replay receipt stay consistent and never authorize delivery", t => {
  const { db, p, state, lead, run, start } = completedRun(t);
  const file = run.steps[0]!.evidence[0]!;
  // The team goes the way the database sees it, with foreign keys on, and its lead is unseated.
  db.prepare("DELETE FROM teams WHERE id = 'authors'").run();
  state.teams = []; lead.teamId = null; lead.role = "member";

  assert.equal(count(db, "pipeline_runs"), 1, "deleting the team keeps its run");
  assert.equal(count(db, "pipeline_files"), 1, "and its evidence file record");
  const kept = p.get(run.id);
  assert.equal(kept.state, "open");
  assert.equal(kept.archived?.reason, "missing");
  assert.deepEqual(kept.steps.map(s => s.state), run.steps.map(s => s.state), "kept exactly as last recorded");
  assert.equal(p.evidenceFile(file.id), file.storedPath, "the attachment still resolves");

  // Replay returns the same run that get() reads, not a run that no longer exists.
  assert.equal(p.start(lead, start).id, run.id);
  assert.equal(p.get(p.start(lead, start).id).archived?.reason, "missing");

  const refused = p.gate(lead, { runId: run.id, delivery: "handoff", round: run.round, candidate: run.candidate.head });
  assert.equal(refused.allowed, false);
  assert.match(refused.reasons.join(), /archived/);
  assert.throws(() => p.abandon(lead, { runId: run.id, clientId: "late", notes: "too late" }), { status: 409, code: "pipeline_run_archived" });
  assert.throws(() => p.branch(lead, { runId: run.id, clientId: "late-branch", expectedRevision: kept.revision, selections: {}, rationale: "late" }), { status: 409, code: "pipeline_run_archived" });
  assert.throws(() => p.presentation(lead, run.id), { status: 409, code: "pipeline_run_archived" });
});

function office(t: TestContext) {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  const inbox = new Inbox(db, join(scratch(t), "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const source: AgentSource = { available: () => false, live: () => [], prompt: async () => {}, notify: async () => {}, createWorktree: async () => { throw new Error("no herdr"); },
    startAgent: async () => {}, closePane: async () => {}, removeWorktree: async () => { throw new Error("no herdr"); } };
  const world = new World(db, source, () => inbox.state());
  const team = (id: string, name: string, path: string | null = null) => db.prepare("INSERT INTO teams (id, name, standing, path, created_at) VALUES (?, ?, ?, ?, 'now')").run(id, name, path ? 0 : 1, path);
  /** Runs as the ledger stores them, in every state a team can leave behind. */
  const runs = (teamId: string) => (["open", "delivered", "abandoned"] as const).map(state => {
    const at = new Date().toISOString(); const id = `${teamId}-${state}`;
    const run = { id, teamId, leadId: "captain", graph, policyHash: "p", definitionHashes: {}, revision: 3, round: 1, selections: {}, rationale: "", state, workId: null, workRound: null, createdAt: at, updatedAt: at,
      candidate: { checkout: "/gone", repoRoot: "/gone", base: "b", head: "h", fingerprint: "f", changedPaths: [] },
      steps: [{ nodeId: "checks", state: state === "open" ? "ready" : "done", assignedTo: null, completedBy: null, evidence: [], notes: "" }, { nodeId: "deliver", state: state === "delivered" ? "done" : "ready", assignedTo: null, completedBy: null, evidence: [], notes: "" }],
      ...(state === "abandoned" ? { abandonment: { notes: "superseded", byAgentId: "captain", at } } : {}) } as unknown as PipelineRun;
    db.prepare("INSERT INTO pipeline_runs (id, team_id, ledger_team_id, snapshot, created_at) VALUES (?, ?, ?, ?, ?)").run(id, teamId, teamId, JSON.stringify(run), at);
    db.prepare("INSERT INTO pipeline_files (id, run_id, file, sha256) VALUES (?, ?, '/evidence', 'sha')").run(`${id}-file`, id);
    return id;
  });
  return { db, world, team, runs };
}

test("disbanding a team archives its open, delivered and abandoned runs instead of deleting them", async t => {
  const { db, world, team, runs } = office(t);
  team("t1", "Atoms"); const ids = runs("t1");
  await world.deleteTeam("t1");
  assert.equal(world.state().teams.length, 0);
  assert.equal(count(db, "pipeline_files"), 3);
  for (const id of ids) {
    const run = world.pipelines.get(id);
    assert.deepEqual(run.archived && [run.archived.reason, run.archived.teamName], ["deleted", "Atoms"]);
  }
  assert.deepEqual(ids.map(id => world.pipelines.get(id).state), ["open", "delivered", "abandoned"], "each keeps its own outcome");
});

test("a team merged into another keeps its runs under its own name, listed in the target's Runs, never the target's to deliver", t => {
  const { db, world, team, runs } = office(t);
  team("src", "Atoms"); team("dst", "Mission Control"); const ids = runs("src");
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'dst', 'lead', 'now')").run();
  world.mergeTeam("src", "dst");
  const listed = world.pipelines.list("dst");
  assert.deepEqual(listed.map(r => r.id).sort(), [...ids].sort());
  for (const run of listed) {
    assert.equal(run.teamId, "src", "provenance is the original team");
    assert.deepEqual(run.archived?.mergedInto, { teamId: "dst", teamName: "Mission Control" });
  }
  const captain = world.state().agents.find(a => a.id === "captain")!;
  const open = listed.find(r => r.state === "open")!;
  assert.equal(world.pipelines.gate(captain, { runId: open.id, delivery: "handoff", round: 1, candidate: "h" }).allowed, false);
  assert.equal(world.pipelines.status(captain).run, null, "an archived open run is not the target's open wave");
  assert.equal(world.pipelines.status(captain, open.id).run?.id, open.id, "but it can be read there");
});

test("merging twice moves the history along, and seeing a checkout missing deletes no pipeline record", t => {
  const { db, world, team, runs } = office(t);
  team("a", "A"); team("b", "B"); team("c", "C"); const fromA = runs("a");
  world.mergeTeam("a", "b"); world.mergeTeam("b", "c");
  assert.deepEqual(world.pipelines.list("c").map(r => r.id).sort(), [...fromA].sort());
  assert.equal(world.pipelines.get(fromA[0]!).archived?.teamName, "A", "the first archive is kept");

  team("p", "Project", "/nonexistent/review-inbox-history-checkout"); const fromP = runs("p");
  const before = ["pipeline_runs", "pipeline_files"].map(table => count(db, table));
  assert.ok(!world.teams().some(t => t.id === "p"), "the project whose worktree has gone is over");
  assert.deepEqual(["pipeline_runs", "pipeline_files"].map(table => count(db, table)), before, "a read deletes no run or file");
  for (const id of fromP) assert.equal(world.pipelines.get(id).archived?.reason, "missing");
});

test("a version 9 database keeps its runs, files and bindings and stops cascading team deletion into them", t => {
  const dir = scratch(t); const file = join(dir, "office.sqlite");
  const old = openDatabase(file);
  old.exec("DROP TABLE pipeline_files; DROP TABLE pipeline_work_bindings; DROP TABLE pipeline_item_bindings; DROP TABLE pipeline_runs;");
  migratePipelines(old);
  old.exec(`PRAGMA user_version = 9;
    INSERT INTO teams (id, name, standing, created_at) VALUES ('t', 'Atoms', 1, 'now');
    INSERT INTO world_agents (id, identity, name, first_seen_at) VALUES ('a', 'a', 'a', 'now');
    INSERT INTO pipeline_runs (id, team_id, snapshot, created_at) VALUES ('r', 't', '{"id":"r"}', 'now');
    INSERT INTO pipeline_files (id, run_id, file, sha256) VALUES ('f', 'r', '/evidence', 'sha');
    INSERT INTO work (id, title, summary, from_agent_id, to_team_id, state, created_at, updated_at) VALUES ('w', 'x', 'x', 'a', 't', 'accepted', 'now', 'now');
    INSERT INTO pipeline_work_bindings (work_id, round, run_id, fingerprint) VALUES ('w', 1, 'r', 'fp');`);
  old.close();

  const db = openDatabase(file);
  t.after(() => db.close());
  // Migration 10 ran; later migrations (11, waivers) may follow it.
  assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 10);
  assert.deepEqual({ ...db.prepare("SELECT team_id, ledger_team_id, snapshot FROM pipeline_runs").get() }, { team_id: "t", ledger_team_id: "t", snapshot: '{"id":"r"}' });
  db.exec("DELETE FROM teams WHERE id = 't'");
  assert.deepEqual(["pipeline_runs", "pipeline_files", "pipeline_work_bindings"].map(table => count(db, table)), [1, 1, 1]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(existsSync(file));
});

test("an abandoned or archived run's unfinished steps say so instead of waiting", () => {
  const ready: PipelineStep = { nodeId: "deliver", state: "ready", assignedTo: null, completedBy: null, evidence: [], notes: "" };
  assert.equal(stepState(ready, { state: "open" }), "waiting");
  assert.equal(stepState(ready, { state: "abandoned" }), "abandoned");
  assert.equal(stepState({ ...ready, state: "done" }, { state: "abandoned" }), "done", "what was done stays done");
  assert.equal(stepState({ ...ready, state: "inactive" }, { state: "abandoned" }), "skipped");
  assert.equal(stepState(ready, { state: "open", archived: { reason: "deleted", teamName: "Atoms", at: "now" } }), "archived");
});
