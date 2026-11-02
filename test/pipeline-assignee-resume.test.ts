import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { InboxError } from "../src/server/inbox.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { INBOX_BIN } from "../src/shared/pipeline-cli.ts";
import type { PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph: PipelineGraph = { version: 1, id: "wave", label: "Bounded delivery", entry: "plan", fields: [],
  nodes: [{ id: "plan", label: "Plan the wave", kind: "step", source: "builtin:work", evidence: ["report"], binding: "run" }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "handoff" }],
  edges: [{ id: "finish", from: "plan", to: "deliver" }], positions: { plan: { x: 0, y: 0 }, deliver: { x: 200, y: 0 } } };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, stdio: "ignore" });

/** A team whose crew member Gal was resumed as a new agent (Einstein) in the same checkout: same name, new id. */
function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-assignee-"))); const root = join(dir, "repo");
  mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const db = openDatabase(join(dir, "office.sqlite"));
  const agent = (id: string, name: string, role: "lead" | "member", status: WorldAgent["status"], identity = `claude:${root}@${name.toLowerCase()}`) =>
    ({ id, name, identity, harness: "claude", cwd: root, teamId: "crew", role, paneId: status === "offline" ? null : `p-${id}`, status, helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as WorldAgent;
  const lead = agent("lead00000001", "Clara", "lead", "idle");
  const old = agent("08513cf0bb7b", "Gal", "member", "offline", `claude:${root}@dispatch-einstein`);
  const resumed = agent("6f8ca53444b6", "Einstein", "member", "idle", `claude:${root}@einstein`);
  const state = { agents: [lead, old, resumed], teams: [{ id: "crew", name: "crew", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }],
    repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('crew', 'crew', 1, 'now')").run();
  for (const a of state.agents) db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, ?, ?, 'now')").run(a.id, a.identity, a.name, a.teamId, a.role);
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let n = 0;
  const assign = (run: PipelineRun, agentId: string) => p.assign(lead, { runId: run.id, clientId: `assign-${n++}`, expectedRevision: run.revision, nodeId: "plan", agentId });
  const report = (run: PipelineRun, by: WorldAgent) => p.report(by, { runId: run.id, clientId: `report-${n++}`, expectedRevision: run.revision, nodeId: "plan", notes: "Planned", evidence: [{ kind: "report", summary: "Plan", url: "https://example.invalid/plan" }] });
  const refusal = (fn: () => unknown): InboxError => { try { fn(); } catch (err) { assert.ok(err instanceof InboxError); return err; } assert.fail("expected a refusal"); };
  return { state, lead, old, resumed, p, assign, report, refusal, start: () => p.start(lead, { clientId: `start-${n++}` }) };
}

test("a resumed crew member under a new id is refused with who holds the step and the exact reassign command; running it unblocks", t => {
  const o = office(t);
  let run = o.assign(o.start(), o.old.id);
  const err = o.refusal(() => o.report(run, o.resumed));
  assert.equal(err.status, 403); assert.equal(err.code, "pipeline_not_assignee");
  assert.match(err.message, /^report only your assigned step/);
  assert.ok(err.message.includes("Gal (08513cf0bb7b), who is offline"), err.message);
  assert.ok(err.message.includes("Einstein (6f8ca53444b6)"), err.message);
  assert.ok(err.message.includes("Clara (lead00000001)"), err.message);
  const command = `${INBOX_BIN} pipeline assign ${run.id} plan 6f8ca53444b6`;
  assert.ok(err.message.includes(command), err.message);
  // The step was not moved by the refusal: the office did not guess who the new agent is.
  assert.equal(o.p.get(run.id).steps.find(s => s.nodeId === "plan")!.assignedTo, o.old.id);
  // Doing what the refusal says, with the ids it names, unblocks the report.
  const [, runId, nodeId, agentId] = command.slice(INBOX_BIN.length).trim().split(" ").slice(1);
  run = o.p.assign(o.lead, { runId: runId!, clientId: "named-reassign", expectedRevision: run.revision, nodeId: nodeId!, agentId: agentId! });
  assert.equal(o.report(run, o.resumed).steps.find(s => s.nodeId === "plan")!.state, "reported");
});

test("an online assignee is not called offline; a gone assignee is named from its record; an unassigned step says so", t => {
  const o = office(t);
  o.old.status = "idle";
  let run = o.assign(o.start(), o.old.id);
  let err = o.refusal(() => o.report(run, o.resumed));
  assert.ok(err.message.includes("Gal (08513cf0bb7b), not to you"), err.message);
  o.state.agents.splice(o.state.agents.indexOf(o.old), 1);
  err = o.refusal(() => o.report(run, o.resumed));
  assert.ok(err.message.includes("Gal (08513cf0bb7b), who is offline"), err.message);
  run = o.start();
  err = o.refusal(() => o.report(o.p.get(run.id), o.resumed));
  assert.equal(err.code, "pipeline_not_assignee");
  assert.ok(err.message.includes("Plan the wave (plan) is not assigned to anyone"), err.message);
});

test("the same name and checkout is not proof of the same session: the assignment stays with the old id", t => {
  const o = office(t);
  // The resumed agent even takes the old display name; identity still differs, so the step is not carried over.
  o.resumed.name = "Gal";
  const run = o.assign(o.start(), o.old.id);
  const err = o.refusal(() => o.report(run, o.resumed));
  assert.equal(err.status, 403);
  assert.equal(o.p.get(run.id).steps.find(s => s.nodeId === "plan")!.assignedTo, o.old.id);
  // The holder still reports its own step.
  o.old.status = "idle";
  assert.equal(o.report(run, o.old).steps.find(s => s.nodeId === "plan")!.state, "reported");
});
