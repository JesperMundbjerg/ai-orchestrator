import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, requestFingerprint } from "../src/server/db.ts";
import { Messages } from "../src/server/messages.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import type { World } from "../src/server/world.ts";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { validateGraph, activation, pathProblems, selected } from "../src/server/pipelines/model.ts";
import { orphanFieldProblems } from "../src/shared/pipeline.ts";
import { capture } from "../src/server/pipelines/candidate.ts";
import { discover } from "../src/server/pipelines/discovery.ts";
import { parseAdapter } from "../src/server/adapter.ts";
import type { PipelineGateInput, PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph = (delivery: "handoff" | "review" | "dev" = "handoff"): PipelineGraph => ({ version: 1, id: "wave", label: "Bounded delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery }],
  edges: [{ id: "finish", from: "checks", to: "deliver" }], positions: { checks: { x: 0, y: 0 }, deliver: { x: 200, y: 0 } } });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
async function httpFixture(t: TestContext, f: ReturnType<typeof fixture>) {
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const inbox = new Inbox(f.db, join(f.dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: f.p, messages: f.m, state: () => f.state, onChange: () => {}, react: async () => {}, resolve: (s: { sessionId?: string }) => {
    const agent = f.state.agents.find(a => a.id === s.sessionId); if (!agent) throw new Error("unknown fixture agent"); return agent;
  } } as unknown as World;
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${port}`;
  const session = (id = f.lead.id) => ({ harness: "manual", sessionId: id, cwd: f.root });
  const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", ...headers }, ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const cli = async (args: string[]) => {
    const child = spawn(join(process.cwd(), "bin", "inbox"), args, { env: { ...process.env, HOME: f.dir, INBOX_DATA_DIR: join(f.dir, "unused"), INBOX_URL: url, INBOX_PRESENCE_DISCOVERY: "0", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_BROWSER_CLEANUP: "0" } });
    let stdout = "", stderr = ""; child.stdout.on("data", s => { stdout += s; }); child.stderr.on("data", s => { stderr += s; });
    const [status] = await once(child, "close"); return { status, stdout, stderr };
  };
  return { inbox, request, session, cli };
}
function fixture(t: TestContext, g = graph()) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-pipelines-"))); const root = join(dir, "repo"); const file = join(dir, "office.sqlite");
  mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: g }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  let db = openDatabase(file);
  const team = (id: string) => ({ id, name: id, purpose: "", standing: true, path: null, branch: null, worktrees: id === "authors" ? [root] : [], handsTo: id === "authors" ? "reviewers" : null, createdAt: "now" });
  const agent = (id: string, teamId: string, role: "lead" | "member") => ({ id, name: id, identity: id, harness: "manual", cwd: teamId === "authors" ? root : dir, teamId, role, paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as WorldAgent;
  const lead = agent("captain", "authors", "lead"), crew = agent("crew", "authors", "member"), reviewer = agent("reviewer", "reviewers", "lead");
  const state = { agents: [lead, crew, reviewer], teams: [team("authors"), team("reviewers")], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  for (const team of state.teams) db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES (?, ?, 1, 'now')").run(team.id, team.name);
  db.prepare("UPDATE teams SET hands_to = 'reviewers' WHERE id = 'authors'").run();
  for (const a of state.agents) db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, ?, ?, 'now')").run(a.id, a.identity, a.name, a.teamId, a.role);
  let p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  let m = new Messages(db, null, () => state, () => new Date(), () => {}); m.pipelines = p;
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const done = (run: PipelineRun, nodeId = "checks") => p.done(lead, { runId: run.id, clientId: `${nodeId}-${run.revision}-${Math.random()}`, expectedRevision: run.revision, nodeId, notes: "Verified intended scope", evidence: [{ kind: "check", summary: "All checks passed", command: "npm test", exitCode: 0 }] });
  const start = () => p.start(lead, { clientId: `wave-${Math.random()}` });
  const gate = (run: PipelineRun, delivery: PipelineGateInput["delivery"] = g.nodes.at(-1)!.delivery!): PipelineGateInput => ({ runId: run.id, delivery, round: run.round, candidate: run.candidate.head });
  const counts = () => ["work", "messages", "message_deliveries", "pipeline_requests"].map(table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n));
  return { dir, root, state, lead, crew, reviewer, start, done, gate, counts, get db() { return db; }, get p() { return p; }, get m() { return m; }, reopen() { db.close(); db = openDatabase(file); p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") }); m = new Messages(db, null, () => state, () => new Date(), () => {}); m.pipelines = p; } };
}

function mergedWave(t: TestContext, g = graph("dev"), integrationBranch = "dev") {
  const f = fixture(t, g);
  if (integrationBranch !== "dev") {
    git(f.root, "branch", "-m", integrationBranch);
    writeFileSync(join(f.root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch, pipeline: g }));
    git(f.root, "add", "."); git(f.root, "commit", "-qm", "adapter integration branch");
  }
  const remote = join(f.dir, "remote.git"); git(f.dir, "init", "--bare", "-q", remote); git(f.root, "remote", "add", "origin", remote);
  git(f.root, "push", "-q", "origin", integrationBranch);
  const base = git(f.root, "rev-parse", "HEAD"); git(f.root, "checkout", "-qb", "wave");
  writeFileSync(join(f.root, "src.ts"), "export const value = 2;\n"); git(f.root, "add", "."); git(f.root, "commit", "-qm", "own bytes");
  const run = f.done(f.p.start(f.lead, { clientId: "scoped-start", base }));
  git(f.root, "checkout", "-q", integrationBranch); writeFileSync(join(f.root, "upstream.ts"), "export const upstream = true;\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "other owner's published bytes"); git(f.root, "push", "-q", "origin", integrationBranch);
  const upstream = git(f.root, "rev-parse", "HEAD"); git(f.root, "checkout", "-q", "wave");
  const merge = () => git(f.root, "merge", "-q", "--no-edit", integrationBranch);
  const input = { runId: run.id, clientId: "rebase", base: upstream, selections: {}, rationale: "Merged published upstream, keep only own scope" };
  return Object.assign(f, { run, upstream, merge, input });
}

test("an active run keeps its source contract when upstream changes or removes the skill", t => {
  const g = graph("dev");
  g.nodes[0]!.source = "skill:.claude/skills/verify/SKILL.md";
  const f = fixture(t, g);
  const sourceDir = join(f.root, ".claude", "skills", "verify");
  mkdirSync(sourceDir, { recursive: true });
  const source = join(sourceDir, "SKILL.md");
  writeFileSync(source, "# Verify\nCheck the owned change.\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "initial verification contract");
  const base = git(f.root, "rev-parse", "HEAD");
  const checkout = join(f.dir, "wave");
  git(f.root, "worktree", "add", "-qb", "wave", checkout);
  f.lead.cwd = checkout; f.state.teams[0]!.worktrees.push(checkout);
  writeFileSync(join(checkout, "src.ts"), "export const value = 2;\n");
  git(checkout, "commit", "-qam", "finished work");
  const run = f.done(f.p.start(f.lead, { clientId: "frozen-source", base }));
  const original = run.definitionHashes[g.nodes[0]!.source!];
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);

  writeFileSync(source, "# Verify\nNew instructions for future work.\n");
  git(f.root, "commit", "-qam", "update future verification instructions");
  const result = f.p.gate(f.lead, f.gate(run));
  assert.equal(result.allowed, true, result.reasons.join("; "));
  assert.equal(f.p.get(run.id).definitionHashes[g.nodes[0]!.source!], original);
  const next = f.p.start(f.lead, { clientId: "new-source", base });
  assert.notEqual(next.definitionHashes[g.nodes[0]!.source!], original);

  rmSync(source); git(f.root, "commit", "-qam", "retire skill for future work");
  f.reopen();
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true, "restart and source retirement do not reopen completed work");
  assert.throws(() => f.p.start(f.lead, { clientId: "missing-source", base }), /source .* unavailable/);
  writeFileSync(join(checkout, "src.ts"), "export const value = 3;\n");
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false, "changed implementation still needs current evidence");
});

test("re-base preserves unchanged own bytes after upstream merge, history and exact replay", t => {
  const f = mergedWave(t); f.merge();
  assert.deepEqual(capture(f.root, f.run.candidate.base).changedPaths, ["src.ts", "upstream.ts"]);
  const run = f.p.branch(f.lead, f.input);
  assert.equal(run.candidate.base, f.upstream); assert.deepEqual(run.candidate.changedPaths, ["src.ts"]);
  assert.equal(run.candidate.fingerprint, f.run.candidate.fingerprint); assert.equal(run.round, f.run.round);
  assert.equal(run.steps[0]!.state, "done"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  assert.deepEqual(run.rebases![0], { oldBase: f.run.candidate.base, newBase: f.upstream, notes: f.input.rationale, byAgentId: f.lead.id, at: run.rebases![0]!.at });
  assert.match(f.p.brief("authors"), /Re-base .*Merged published upstream.*captain/);
  const audit = f.db.prepare("SELECT detail FROM events WHERE kind = 'pipeline.branch'").all(); assert.equal(audit.length, 1);
  f.reopen(); assert.deepEqual(f.p.branch(f.lead, f.input), run);
  assert.throws(() => f.p.branch(f.lead, { ...f.input, rationale: "different reason" }), { code: "replay_conflict" });
  f.lead.role = "member"; f.crew.role = "lead";
  assert.throws(() => f.p.branch(f.lead, f.input), { status: 403 });
});

for (const change of ["none", "owned", "absorbed", "added", "deleted"] as const) test(`published paths leaving the diff preserve evidence only with unchanged reviewed bytes (${change})`, t => {
  const f = fixture(t, graph("dev"));
  const remote = join(f.dir, "remote.git");
  git(f.dir, "init", "--bare", "-q", remote); git(f.root, "remote", "add", "origin", remote);
  git(f.root, "push", "-q", "origin", "dev");
  const base = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "-qb", "wave");
  writeFileSync(join(f.root, "src.ts"), "export const value = 2;\n");
  writeFileSync(join(f.root, "shared.ts"), "export const helper = 2;\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "owned work and shared prerequisite");
  const before = f.done(f.p.start(f.lead, { clientId: "before-publication", base }));
  git(f.root, "checkout", "-q", "dev");
  writeFileSync(join(f.root, "shared.ts"), "export const helper = 2;\n");
  writeFileSync(join(f.root, "upstream.ts"), "export const upstream = true;\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "publish shared prerequisite independently");
  git(f.root, "push", "-q", "origin", "dev");
  const published = git(f.root, "rev-parse", "HEAD");
  git(f.root, "checkout", "-q", "wave"); git(f.root, "merge", "-q", "--no-edit", "dev");
  if (change === "owned") writeFileSync(join(f.root, "src.ts"), "export const value = 3;\n");
  if (change === "absorbed") writeFileSync(join(f.root, "shared.ts"), "export const helper = 3;\n");
  if (change === "added") writeFileSync(join(f.root, "new.ts"), "export const added = true;\n");
  if (change === "deleted") rmSync(join(f.root, "src.ts"));
  if (change !== "none") { git(f.root, "add", "."); git(f.root, "commit", "-qm", "material follow-up"); }
  const run = f.p.branch(f.lead, { runId: before.id, clientId: "published-rebase", base: published, selections: {}, rationale: "Shared prerequisite is already upstream" });
  assert.equal(run.round, before.round + (change === "none" ? 0 : 1));
  assert.equal(run.steps[0]!.state, change === "none" ? "done" : "stale");
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, change === "none");
  if (change !== "none") return;
  assert.deepEqual(run.candidate.changedPaths, ["src.ts"]);
  assert.deepEqual(run.candidate.fingerprintPaths, ["shared.ts", "src.ts"]);
  assert.equal(run.candidate.fingerprint, before.candidate.fingerprint);
  f.reopen();
  const repinned = f.p.branch(f.lead, { runId: run.id, clientId: "repeat-pin", expectedRevision: run.revision, candidate: "HEAD", selections: {}, rationale: "Same final commit" });
  assert.equal(repinned.round, before.round);
  assert.equal(f.p.gate(f.lead, f.gate(repinned)).allowed, true);
  git(f.root, "push", "-q", "origin", "HEAD:dev");
  assert.equal(f.p.get(run.id).state, "delivered", "publication verifies the retained bytes contract too");
});

test("re-base refuses crew, unpublished local base, non-ancestor and closed runs atomically", t => {
  const f = mergedWave(t); const before = f.p.get(f.run.id);
  assert.throws(() => f.p.branch(f.crew, f.input), { status: 403 });
  assert.throws(() => f.p.branch(f.reviewer, f.input), { status: 403 });
  assert.throws(() => f.p.branch(f.lead, { ...f.input, base: before.candidate.head }), { code: "pipeline_base_unpublished" });
  assert.throws(() => f.p.branch(f.lead, f.input), { code: "pipeline_base_not_ancestor" });
  assert.equal(f.p.get(f.run.id).revision, before.revision); assert.equal(f.p.get(f.run.id).rebases, undefined);
  f.merge(); const run = f.p.branch(f.lead, f.input);
  f.p.abandon(f.lead, { runId: run.id, clientId: "close", notes: "No delivery" });
  assert.throws(() => f.p.branch(f.lead, { ...f.input, clientId: "closed-rebase" }), /already abandoned/);
  const delivered = f.start(); f.db.prepare("UPDATE pipeline_runs SET snapshot = ? WHERE id = ?").run(JSON.stringify({ ...delivered, state: "delivered" }), delivered.id);
  assert.throws(() => f.p.branch(f.lead, { ...f.input, runId: delivered.id, clientId: "delivered-rebase" }), /already delivered/);
});

test("changed own bytes stale evidence on re-base; adapter integration branch is respected", t => {
  const f = mergedWave(t, graph("dev"), "integration"); f.merge();
  writeFileSync(join(f.root, "src.ts"), "export const value = 3;\n");
  const run = f.p.branch(f.lead, f.input);
  assert.equal(run.round, f.run.round + 1); assert.equal(run.steps[0]!.state, "stale");
  assert.notEqual(run.candidate.fingerprint, f.run.candidate.fingerprint); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
});

test("path guards judge only the new scope and still reject changed own out-of-scope paths", t => {
  const g = graph("dev"); g.fields = [{ id: "scope", label: "Scope", type: "boolean" }];
  g.pathRules = [{ when: { field: "scope", equals: true }, prefixes: ["src.ts"], only: true, message: "Own scope only" }];
  const f = mergedWave(t, g); f.merge();
  assert.throws(() => f.p.branch(f.lead, { ...f.input, base: undefined, expectedRevision: f.run.revision, candidate: "HEAD", selections: { scope: true } }), { code: "pipeline_branch_conflict" });
  const run = f.p.branch(f.lead, { ...f.input, selections: { scope: true } });
  assert.deepEqual(run.candidate.changedPaths, ["src.ts"]);
  writeFileSync(join(f.root, "upstream.ts"), "own unapproved change\n");
  assert.throws(() => f.p.branch(f.lead, { ...f.input, clientId: "bad-scope", selections: { scope: true } }), { code: "pipeline_branch_conflict" });
  assert.equal(f.p.get(run.id).revision, run.revision);
});

test("CLI and HTTP re-base validate base, refresh candidate and replay with client-id alone", async t => {
  const f = mergedWave(t); const h = await httpFixture(t, f); f.merge();
  const payload = { session: h.session(), ...f.input };
  assert.equal((await h.request("POST", "/api/agent/pipeline/branch", { ...payload, base: 12 })).status, 400);
  const args = ["pipeline", "branch", f.run.id, "--base", f.upstream, "--notes", f.input.rationale, "--client-id", "cli-base", "--harness", "manual", "--session", f.lead.id];
  const first = await h.cli(args); assert.equal(first.status, 0, first.stderr); const run = JSON.parse(first.stdout);
  assert.equal(run.candidate.head, git(f.root, "rev-parse", "HEAD"));
  const second = await h.cli(args); assert.equal(second.status, 0, second.stderr); assert.deepEqual(JSON.parse(second.stdout), run);
});

for (const changed of [false, true]) test(`legacy whole-tree open runs retain ${changed ? "stale" : "fresh"} evidence after restart without re-base`, t => {
  const f = fixture(t, graph("dev")); writeFileSync(join(f.root, "src.ts"), "legacy intended bytes\n");
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "legacy candidate");
  let run = f.done(f.start());
  run.candidate = capture(f.root, run.candidate.base, "HEAD", 1);
  for (const step of run.steps) for (const evidence of step.evidence) evidence.fingerprint = run.candidate.fingerprint;
  assert.equal(run.candidate.fingerprintVersion, undefined);
  f.db.prepare("UPDATE pipeline_runs SET snapshot = ? WHERE id = ?").run(JSON.stringify(run), run.id);
  if (changed) writeFileSync(join(f.root, "src.ts"), "later unpinned bytes\n");
  const before = f.p.get(run.id); const status = before.steps.map(s => s.state);
  assert.equal(status[0], changed ? "stale" : "done"); const gateBefore = f.p.gate(f.lead, f.gate(run));
  const stored = f.db.prepare("SELECT snapshot FROM pipeline_runs WHERE id = ?").get(run.id)!.snapshot;
  f.reopen(); assert.deepEqual(f.p.get(run.id).steps.map(s => s.state), status);
  assert.deepEqual(f.p.teamView("authors").runs[0]!.steps.map(s => s.state), status);
  assert.deepEqual(f.p.gate(f.lead, f.gate(run)), gateBefore);
  assert.equal(f.db.prepare("SELECT snapshot FROM pipeline_runs WHERE id = ?").get(run.id)!.snapshot, stored, "reads must not silently migrate the pin or evidence");
  run = f.p.branch(f.lead, { runId: run.id, clientId: "legacy-repin", expectedRevision: run.revision, selections: {}, rationale: "Legacy semantics until explicit base", candidate: "HEAD" });
  assert.equal(run.candidate.fingerprintVersion, undefined);
  assert.equal(run.round, changed ? 2 : 1);
});

function planningGraph(): PipelineGraph {
  const g = graph("dev"); g.entry = "plan";
  g.nodes.unshift({ id: "plan", label: "First mate plans bounded wave", kind: "step", source: "builtin:work", evidence: ["report"], binding: "run" });
  g.edges.unshift({ id: "planned", from: "plan", to: "checks" }); return g;
}
const plan = (f: ReturnType<typeof fixture>, run: PipelineRun) => f.p.done(f.lead, { runId: run.id, clientId: `plan-${run.revision}`, expectedRevision: run.revision, nodeId: "plan", notes: "Bounded scope and assignments planned", evidence: [{ kind: "report", summary: "Plan for this wave", url: "https://example.invalid/plan" }] });

test("run-bound planning can be reported and endorsed during changing implementation; final checks still need fresh bytes", t => {
  const f = fixture(t, planningGraph()); let run = f.start();
  writeFileSync(join(f.root, "src.ts"), "implementation in progress\n");
  run = f.p.assign(f.lead, { runId: run.id, clientId: "assign-plan", expectedRevision: run.revision, nodeId: "plan", agentId: f.crew.id });
  run = f.p.report(f.crew, { runId: run.id, clientId: "crew-plan", expectedRevision: run.revision, nodeId: "plan", notes: "Planned scope", evidence: [{ kind: "report", summary: "Bounded plan", url: "https://example.invalid/plan" }] });
  const evidence = run.steps[0]!.evidence[0]!; assert.equal(evidence.binding, "run"); assert.notEqual(evidence.fingerprint, run.candidate.fingerprint);
  writeFileSync(join(f.root, "src.ts"), "implementation changed again\n"); assert.equal(f.p.get(run.id).steps[0]!.state, "reported");
  run = f.p.done(f.lead, { runId: run.id, clientId: "endorse-plan", expectedRevision: run.revision, nodeId: "plan", notes: "Scope accepted", evidence: [], evidenceIds: [evidence.id] });
  assert.equal(run.steps[0]!.state, "done"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
  assert.throws(() => f.done(run), /candidate is stale/);
  // New bytes mean a new round: even a run-bound plan must be renewed.
  git(f.root, "add", "."); git(f.root, "commit", "-qm", "final implementation");
  run = f.p.branch(f.lead, { runId: run.id, clientId: "new-round", expectedRevision: run.revision, selections: {}, rationale: "Final bytes ready", candidate: "HEAD" });
  assert.equal(run.round, 2); assert.equal(run.steps[0]!.state, "stale");
  assert.throws(() => f.p.done(f.lead, { runId: run.id, clientId: "reuse-plan", expectedRevision: run.revision, nodeId: "plan", notes: "Reuse", evidence: [] }), { code: "pipeline_evidence_required" });
  run = plan(f, run); run = f.done(run); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  writeFileSync(join(f.root, "src.ts"), "yet another edit\n");
  assert.equal(f.p.get(run.id).steps[0]!.state, "done"); assert.equal(f.p.get(run.id).steps[1]!.state, "stale");
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
});

test("run-bound evidence survives metadata-only re-pin but a changed selection scope stales it permanently", t => {
  const g = planningGraph(); g.fields = [{ id: "scope", label: "Scope", type: "boolean" }];
  g.pathRules = [{ when: { field: "scope", equals: true }, prefixes: ["src.ts"], only: true, message: "Bounded scope" }];
  const f = fixture(t, g); let run = f.start();
  const branch = (value: boolean, candidate?: string) => f.p.branch(f.lead, { runId: run.id, clientId: `scope-${run.revision}`, expectedRevision: run.revision, selections: { scope: value }, rationale: "Scope choice", candidate });
  run = branch(false); run = plan(f, run);
  git(f.root, "commit", "--allow-empty", "-qm", "metadata only"); run = branch(false, "HEAD");
  assert.equal(run.round, 1); assert.equal(run.steps[0]!.state, "done");
  const old = run.steps[0]!.evidence[0]!; run = branch(true);
  assert.equal(run.steps[0]!.state, "stale"); assert.equal(run.round, 1);
  run = branch(false); assert.equal(run.steps[0]!.state, "stale", "returning to old choices cannot revive an old plan");
  f.reopen(); run = f.p.get(run.id); assert.equal(run.steps[0]!.state, "stale");
  assert.throws(() => f.p.done(f.lead, { runId: run.id, clientId: "old-scope", expectedRevision: run.revision, nodeId: "plan", notes: "Reuse", evidence: [], evidenceIds: [old.id] }), { code: "pipeline_evidence_required" });
  run = plan(f, run); assert.equal(run.steps[0]!.state, "done"); assert.notEqual(run.steps[0]!.evidence[0]!.fingerprint, old.fingerprint);
});

test("binding is explicit for ambiguous planning reports, conditions are run concepts, checks remain candidate-bound", t => {
  const g = planningGraph(); delete g.nodes[0]!.binding;
  const f = fixture(t, g); const run = f.start(); writeFileSync(join(f.root, "src.ts"), "dirty\n");
  assert.throws(() => plan(f, run), /candidate is stale/, "plan labels and builtin:work must not imply run binding");
  const validated = validateGraph(planningGraph()); assert.equal(validated.nodes[0]!.binding, "run");
  assert.throws(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === "checks" ? { ...n, binding: "run" } : n) }), /must remain candidate-bound/);
  assert.throws(() => validateGraph({ ...g, nodes: g.nodes.map(n => n.id === "plan" ? { ...n, binding: "anything" } : n) }), /binding must be/);
});

test("validation rejects cycles, missing delivery, missing condition ports and unchecked steps", () => {
  assert.equal(validateGraph(graph()).nodes.length, 2);
  assert.throws(() => validateGraph({ ...graph(), nodes: [graph().nodes[0]] }), /endpoints/);
  assert.throws(() => validateGraph({ ...graph(), nodes: [{ ...graph().nodes[0], evidence: [] }, graph().nodes[1]] }), /evidence/);
  assert.throws(() => validateGraph({ ...graph(), fields: [{ id: "risk", label: "Risk", type: "boolean" }], nodes: [{ id: "checks", label: "Risk", kind: "condition", field: "risk" }, graph().nodes[1]], edges: [{ id: "yes", from: "checks", to: "deliver", port: "true" }] }), /false branch/);
  assert.throws(() => validateGraph({ ...graph(), nodes: [...graph().nodes, { id: "stray", label: "Unreachable", kind: "step", source: "builtin:check", evidence: ["check"] }] }), /reachable/);
});

test("orphan fields fail shared validation and HTTP saves with a clear path, without changing policy", async t => {
  const f = fixture(t); const h = await httpFixture(t, f); const before = f.p.teamView("authors");
  const orphan = graph(); orphan.fields.push({ id: "deletedBranch", label: "Deleted branch", type: "boolean" });
  const problems = orphanFieldProblems(orphan);
  assert.equal(problems[0]!.path, "fields.0.id");
  assert.match(problems[0]!.message, /deletedBranch.*not referenced by any condition or guard/);
  assert.throws(() => validateGraph(orphan), { status: 422, code: "pipeline_invalid" });
  assert.throws(() => validateGraph(orphan), /fields\.0\.id/);
  const refused = await h.request("PUT", "/api/world/teams/authors/pipeline", { expectedRevision: before.revision, graph: orphan });
  assert.equal(refused.status, 422); assert.equal(refused.body.code, "pipeline_invalid");
  assert.equal(refused.body.details[0].path, "fields.0.id");
  assert.match(refused.body.error, /deletedBranch.*not referenced by any condition/);
  assert.equal(f.p.teamView("authors").revision, before.revision);
  assert.equal(f.p.teamView("authors").policyHash, before.policyHash);
});

test("guard-only fields remain valid and required selections for every modeled reader", () => {
  for (const reader of ["edge", "pathWhen", "pathRequire"] as const) {
    const g = graph(); g.fields = [{ id: "flag", label: "Lead flag", type: "boolean" }];
    const match = { field: "flag", equals: true };
    if (reader === "edge") g.edges[0]!.when = match;
    else g.pathRules = [{ prefixes: ["src.ts"], message: "Flag needed", ...(reader === "pathWhen" ? { when: match, only: true } : { require: match }) }];
    assert.deepEqual(orphanFieldProblems(g), []);
    assert.equal(validateGraph(g).fields.length, 1);
    assert.deepEqual(selected(g, {}), ["select Lead flag"]);
    assert.deepEqual(selected(g, { flag: true }), []);
  }
});

test("saved orphan fields load after restart but are not required choices in new or existing runs", t => {
  const f = fixture(t); const legacy = graph(); legacy.fields.push({ id: "deletedBranch", label: "Deleted branch", type: "boolean" });
  f.p.teamView("authors");
  f.db.prepare("UPDATE team_pipelines SET graph = ?, revision = 1 WHERE team_id = 'authors'").run(JSON.stringify(legacy));
  f.reopen(); const view = f.p.teamView("authors");
  assert.equal(view.source, "team"); assert.equal(view.graph!.fields[0]!.id, "deletedBranch"); assert.deepEqual(view.problems, []);
  assert.deepEqual(selected(view.graph!, {}), []);
  assert.deepEqual(selected(view.graph!, { unknown: true }), ["unknown selection unknown"]);
  let run = f.start(); const snapshot = JSON.stringify(run.graph);
  f.reopen(); run = f.p.branch(f.lead, { runId: run.id, clientId: "legacy-branch", expectedRevision: run.revision, selections: {}, rationale: "No visible conditions" });
  run = f.done(run); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  assert.equal(JSON.stringify(run.graph), snapshot, "legacy snapshots are not rewritten");
  assert.throws(() => f.p.saveOverride("authors", { expectedRevision: 1, graph: legacy }), { status: 422 });
  const conditional = graph(); conditional.fields = [{ id: "visible", label: "Visible branch", type: "boolean" }, ...legacy.fields];
  conditional.entry = "choose"; conditional.nodes.unshift({ id: "choose", label: "Visible branch", kind: "condition", field: "visible" });
  conditional.edges.unshift({ id: "yes", from: "choose", to: "checks", port: "true" }, { id: "no", from: "choose", to: "deliver", port: "false" });
  assert.deepEqual(selected(conditional, {}), ["select Visible branch"]);
  assert.deepEqual(selected(conditional, { visible: true }), []);
});

for (const mismatch of ["both", "round", "fingerprint"] as const) test(`stale-only ${mismatch} evidence stays stale after re-pin; fresh evidence and endorsement unblock successors`, t => {
  const g = graph("dev"); g.nodes[0]!.evidence = ["report"];
  g.nodes.splice(1, 0, { id: "final", label: "Final check", kind: "step", source: "builtin:check", evidence: ["check"] });
  g.edges = [{ id: "after-report", from: "checks", to: "final" }, { id: "after-check", from: "final", to: "deliver" }];
  const f = fixture(t, g); let run = f.start();
  const report = () => f.p.report(f.lead, { runId: run.id, clientId: `report-${run.revision}`, expectedRevision: run.revision, nodeId: "checks", notes: "Reported exact candidate", evidence: [{ kind: "report", summary: "Scope reviewed", url: "https://example.invalid/report" }] });
  const endorse = () => f.p.done(f.lead, { runId: run.id, clientId: `endorse-${run.revision}`, expectedRevision: run.revision, nodeId: "checks", notes: "Accepted current report", evidence: [] });
  run = report(); run = endorse(); run = f.done(run, "final");
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  writeFileSync(join(f.root, "src.ts"), "export const value = 2;\n"); git(f.root, "add", "src.ts"); git(f.root, "commit", "-qm", "changed candidate");
  assert.deepEqual(f.p.get(run.id).steps.map(s => s.state), ["stale", "stale", "blocked"]);
  run = f.p.branch(f.lead, { runId: run.id, clientId: "repin", expectedRevision: run.revision, selections: {}, rationale: "Changed implementation", candidate: "HEAD" });
  if (mismatch !== "both") {
    for (const step of run.steps) for (const e of step.evidence) {
      if (mismatch === "round") e.fingerprint = run.candidate.fingerprint;
      else e.round = run.round;
    }
    f.db.prepare("UPDATE pipeline_runs SET snapshot = ? WHERE id = ?").run(JSON.stringify(run), run.id);
  }
  f.reopen(); run = f.p.get(run.id);
  assert.equal(run.round, 2); assert.deepEqual(run.steps.map(s => s.state), ["stale", "stale", "blocked"]);
  assert.equal(run.steps[0]!.completedBy, null); assert.equal(run.steps[0]!.evidence.length, 1);
  assert.match(f.p.status(f.lead, run.id).text, /checks: stale/);
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
  assert.throws(endorse, /required evidence is missing or stale/);
  assert.throws(() => f.done(run, "final"), /step is inactive, blocked/);
  run = report(); assert.deepEqual(run.steps.map(s => s.state), ["reported", "stale", "blocked"]);
  assert.throws(() => f.done(run, "final"), /step is inactive, blocked/);
  run = endorse(); assert.deepEqual(run.steps.map(s => s.state), ["done", "stale", "blocked"]);
  run = f.done(run, "final"); assert.deepEqual(run.steps.map(s => s.state), ["done", "done", "ready"]);
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
});

test("an unendorsed report also becomes stale when live bytes no longer match its pin", t => {
  const f = fixture(t); let run = f.start();
  run = f.p.report(f.lead, { runId: run.id, clientId: "unendorsed", expectedRevision: run.revision, nodeId: "checks", notes: "Successful check", evidence: [{ kind: "check", summary: "Pass", command: "test", exitCode: 0 }] });
  assert.equal(run.steps[0]!.state, "reported");
  writeFileSync(join(f.root, "src.ts"), "changed bytes\n");
  assert.deepEqual(f.p.get(run.id).steps.map(s => s.state), ["stale", "blocked"]);
});

test("FysikLab default preserves mandatory authoring/framework scopes and the dispatched fast path", () => {
  const copy = readFileSync(new URL("./fixtures/pipelines/fysiklab-default.json", import.meta.url), "utf8");
  const g = validateGraph(JSON.parse(copy).pipeline);
  assert.deepEqual(orphanFieldProblems(g), []);
  assert.deepEqual(parseAdapter(copy, "/tmp/fysiklab-copy", "fysiklab").problems, []);
  assert.ok(selected(g, {}).includes("select Additional architecture scope not already covered?"));
  assert.equal(g.nodes.length, 92); assert.equal(g.edges.length, 177);
  const choices = Object.fromEntries(g.fields.map(f => [f.id, f.type === "boolean" ? false : f.options![0]!]));
  let active = activation(g, { ...choices, kind: "framework" }).active; assert.ok(active.has("frameworkArchitecture"));
  active = activation(g, { ...choices, kind: "new-lesson", target: "new-chapter", coreSim: false }).active;
  assert.ok(active.has("chapterChecks-physics")); assert.ok(active.has("chapterChecks-frames")); assert.ok(active.has("chapterChecks-danish")); assert.ok(active.has("show"));
  active = activation(g, { ...choices, kind: "bug-fix", dispatched: true, danish: true, legal: true, finishedAudit: true, chapterCritics: "all" }).active;
  for (const node of ["danish", "legal", "finalAudit", "chapterCritics-curious"]) assert.equal(active.has(node), false, `ordinary fix slice excludes ${node}`);
  assert.ok(active.has("changed")); assert.equal(active.has("final-typecheck"), false);
  active = activation(g, { ...choices, kind: "new-lesson", target: "new-chapter", dispatched: true }).active; assert.ok(active.has("changed") && active.has("final-typecheck"));
  assert.ok(pathProblems(g, { ...choices, kind: "docs-only" }, [".claude/agents/physics.md"]).length);
});

test("staging and committing the same intended bytes preserves the fingerprint and pre-commit checks", t => {
  const f = fixture(t, graph("dev")); writeFileSync(join(f.root, "new.ts"), "new intended file\\n"); const before = capture(f.root); let run = f.done(f.start());
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false, "uncommitted dev candidate is not deliverable");
  git(f.root, "add", "new.ts"); assert.equal(capture(f.root, before.base).fingerprint, before.fingerprint);
  git(f.root, "commit", "-qm", "candidate"); assert.equal(capture(f.root, before.base).fingerprint, before.fingerprint);
  run = f.p.branch(f.lead, { runId: run.id, clientId: "pin-commit", expectedRevision: run.revision, selections: {}, rationale: "Same verified intended tree, pinned commit", candidate: "HEAD" });
  assert.equal(run.round, 1); assert.equal(run.steps[0]!.state, "done"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
});

test("discovery is deterministic, repo-only, de-duplicates reused resources, and runs no code", t => {
  const f = fixture(t); mkdirSync(join(f.root, ".claude", "agents"), { recursive: true }); mkdirSync(join(f.root, ".claude", "skills", "check"), { recursive: true }); mkdirSync(join(f.root, ".pi"), { recursive: true });
  writeFileSync(join(f.root, ".claude", "agents", "z.md"), "---\nname: Reviewer\ndescription: scoped report\n---\nNever execute me.");
  writeFileSync(join(f.root, ".claude", "skills", "check", "SKILL.md"), "---\nname: check\n---\nSkill");
  writeFileSync(join(f.root, ".pi", "settings.json"), JSON.stringify({ skills: ["../.claude/skills"] }));
  writeFileSync(join(f.dir, "private.md"), "DO NOT READ OUTSIDE REPO"); symlinkSync(join(f.dir, "private.md"), join(f.root, ".claude", "agents", "escape.md"));
  const a = discover(f.root), b = discover(f.root); assert.deepEqual(a, b); assert.equal(a.entries.filter(e => e.kind === "skill").length, 1); assert.ok(a.problems.some(p => p.includes("escapes")));
  const old = a.entries.find(e => e.kind === "agent")!; writeFileSync(join(f.root, old.path!), "Changed definition"); assert.notEqual(discover(f.root).entries.find(e => e.id === old.id)!.hash, old.hash);
});

test("adapter validates repo defaults; layout stays inherited and does not stale run evidence", t => {
  const f = fixture(t); let run = f.done(f.start()); const before = f.p.teamView("authors");
  const layout = f.p.saveLayout("authors", { expectedRevision: 0, positions: { checks: { x: 80, y: 90 } } });
  assert.equal(layout.source, "repo"); assert.equal(layout.revision, before.revision); assert.equal(layout.policyHash, before.policyHash); assert.equal(f.p.get(run.id).revision, run.revision);
  assert.throws(() => f.p.saveLayout("authors", { expectedRevision: 0, positions: {} }), { status: 409 });
  const override = f.p.saveOverride("authors", { expectedRevision: 0, graph: graph("dev") }); assert.equal(override.source, "team");
  assert.throws(() => f.p.saveOverride("authors", { expectedRevision: 0, graph: null }), { status: 409 });
  assert.equal(f.p.saveOverride("authors", { expectedRevision: 1, graph: null }).source, "repo");
  assert.equal(parseAdapter(JSON.stringify({ pipeline: { version: 7 } }), f.root, "test").adapter, null);
  rmSync(join(f.root, "orchestrator.json")); assert.equal(f.p.teamView("authors").protected, true); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
  assert.equal(f.p.saveOverride("authors", { expectedRevision: 2, graph: null }).protected, false, "only explicit founder reset unprotects a removed default");
});

test("crew cannot start, complete, branch, preflight or hand off; failed gate writes nothing", t => {
  const f = fixture(t); const run = f.start(); const before = f.counts();
  assert.throws(() => f.p.start(f.crew, { clientId: "crew-start" }), { status: 403 });
  assert.throws(() => f.p.done(f.crew, { runId: run.id, expectedRevision: run.revision, clientId: "crew-done", nodeId: "checks", notes: "done", evidence: [] }), { status: 403 });
  assert.throws(() => f.p.branch(f.crew, { runId: run.id, expectedRevision: run.revision, clientId: "crew-branch", selections: {}, rationale: "skip" }), { status: 403 });
  assert.throws(() => f.p.gate(f.crew, f.gate(run)), { status: 403 });
  assert.throws(() => f.m.handoff(f.crew, { title: "Crew delivery", summary: "not allowed", pipeline: f.gate(run) }), { status: 403 });
  assert.throws(() => f.m.handoff(f.lead, { title: "Too early", summary: "missing check", pipeline: f.gate(run) }), { status: 409 });
  assert.deepEqual(f.counts(), before); assert.equal(f.p.get(run.id).state, "open");
});

test("abandon is current-lead-only, terminal, replay-safe and preserves evidence after restart", t => {
  const g = graph(); g.nodes[0]!.evidence = ["report"];
  const f = fixture(t, g); let run = f.start();
  const report = join(f.dir, "retained.md"); writeFileSync(report, "Evidence retained for the record");
  run = f.p.done(f.lead, { runId: run.id, clientId: "retained-report", expectedRevision: run.revision, nodeId: "checks", notes: "Reviewed", evidence: [{ kind: "report", summary: "Scoped review", path: report }] });
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  const input = { runId: run.id, clientId: "close-wave", notes: "Superseded by another approach" };
  const before = f.counts();
  assert.throws(() => f.p.abandon(f.crew, input), { status: 403 });
  assert.throws(() => f.p.abandon(f.reviewer, input), { status: 403 });
  assert.throws(() => f.p.abandon(f.lead, { ...input, notes: " " }), { status: 400 });
  assert.deepEqual(f.counts(), before);
  f.lead.role = "member"; f.crew.role = "lead";
  assert.throws(() => f.p.abandon(f.lead, input), { status: 403 });
  const abandoned = f.p.abandon(f.crew, input);
  assert.equal(abandoned.state, "abandoned"); assert.equal(abandoned.revision, run.revision + 1);
  assert.equal(abandoned.abandonment!.notes, input.notes); assert.equal(abandoned.abandonment!.byAgentId, f.crew.id);
  assert.deepEqual(abandoned.steps, run.steps); assert.deepEqual(abandoned.candidate, run.candidate); assert.deepEqual(abandoned.graph, run.graph);
  const counts = f.counts();
  assert.deepEqual(f.p.abandon(f.crew, input), abandoned); assert.deepEqual(f.counts(), counts);
  assert.throws(() => f.p.abandon(f.crew, { ...input, notes: "different reason" }), { status: 409, code: "replay_conflict" });
  assert.throws(() => f.p.abandon(f.crew, { ...input, clientId: "second-close" }), /already abandoned/);
  const gate = f.p.gate(f.crew, f.gate(run)); assert.equal(gate.allowed, false); assert.ok(gate.reasons.includes("run is already abandoned"));
  assert.throws(() => f.m.handoff(f.crew, { title: "Closed wave", summary: "No delivery", pipeline: f.gate(run) }), { status: 409, code: "pipeline_gate_blocked" });
  assert.throws(() => f.p.branch(f.crew, { runId: run.id, clientId: "reopen", expectedRevision: abandoned.revision, selections: {}, rationale: "Try again" }), /already abandoned/);
  assert.throws(() => f.p.presentation(f.crew, run.id), /closed candidate/);
  assert.doesNotMatch(f.p.brief("authors", f.crew.id), new RegExp(run.id));
  assert.equal(f.p.status(f.crew).run, null); assert.match(f.p.status(f.crew).text, /Start a bounded wave/);
  assert.match(f.p.status(f.crew, run.id).text, /abandoned: Superseded/);
  writeFileSync(join(f.root, "src.ts"), "Later implementation\n"); f.reopen();
  assert.deepEqual(f.p.abandon(f.crew, input), abandoned); assert.deepEqual(f.p.get(run.id).steps, abandoned.steps);
  const evidence = abandoned.steps[0]!.evidence[0]!;
  assert.equal(readFileSync(f.p.evidenceFile(evidence.id), "utf8"), "Evidence retained for the record");
  const next = f.p.start(f.crew, { clientId: "replacement-wave" });
  assert.equal(f.p.status(f.crew).run!.id, next.id);
  assert.match(f.p.brief("authors", f.crew.id), new RegExp(next.id));
  assert.doesNotMatch(f.p.brief("authors", f.crew.id), new RegExp(run.id));
});

test("delivered runs cannot be abandoned", t => {
  const f = fixture(t); const run = f.done(f.start());
  f.m.handoff(f.lead, { title: "Delivered", summary: "Complete", pipeline: f.gate(run) });
  const before = f.counts();
  assert.throws(() => f.p.abandon(f.lead, { runId: run.id, clientId: "too-late", notes: "Not needed" }), /already delivered/);
  assert.equal(f.p.get(run.id).state, "delivered"); assert.deepEqual(f.counts(), before);
});

test("HTTP and CLI abandon validate reasons, refuse crew and replay with client-id alone", async t => {
  const f = fixture(t, graph("dev")); const h = await httpFixture(t, f); const run = f.done(f.start());
  const input = { session: h.session(), runId: run.id, clientId: "http-abandon" };
  for (const notes of [undefined, "", " ", 12]) assert.equal((await h.request("POST", "/api/agent/pipeline/abandon", { ...input, notes })).status, 400);
  assert.equal((await h.request("POST", "/api/agent/pipeline/abandon", { ...input, session: h.session(f.crew.id), notes: "Skip" })).status, 403);
  assert.equal((await h.request("GET", "/api/agent/pipeline/abandon")).status, 405);
  const args = ["pipeline", "abandon", run.id, "--notes", "Replaced wave", "--client-id", "cli-abandon", "--harness", "manual", "--session", f.lead.id];
  const first = await h.cli(args); assert.equal(first.status, 0, first.stderr);
  const abandoned = JSON.parse(first.stdout); assert.equal(abandoned.state, "abandoned");
  const second = await h.cli(args); assert.equal(second.status, 0, second.stderr); assert.deepEqual(JSON.parse(second.stdout), abandoned);
  const mismatch = await h.request("POST", "/api/agent/pipeline/abandon", { ...input, clientId: "cli-abandon", notes: "Changed reason" });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, "replay_conflict");
  const refused = await h.cli(["pipeline", "gate", "--run", run.id, "--harness", "manual", "--session", f.lead.id]);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /already abandoned/);
});

test("declared branches cannot bypass path guards or skip an activated required step", t => {
  const g = graph(); g.fields = [{ id: "kind", label: "Kind", type: "enum", options: ["code", "docs"] }];
  g.nodes.splice(1, 0, { id: "kind", label: "Kind", kind: "condition", field: "kind" }, { id: "code", label: "Code review", kind: "step", source: "builtin:check", evidence: ["check"] });
  g.edges = [{ id: "choose", from: "checks", to: "kind" }, { id: "code-path", from: "kind", to: "code", port: "code" }, { id: "docs-path", from: "kind", to: "deliver", port: "docs" }, { id: "after-review", from: "code", to: "deliver" }];
  g.pathRules = [{ when: { field: "kind", equals: "docs" }, prefixes: ["docs"], only: true, message: "Docs path cannot hide executable changes" }];
  const f = fixture(t, g); writeFileSync(join(f.root, "src.ts"), "changed code\n"); let run = f.start();
  assert.throws(() => f.p.branch(f.lead, { runId: run.id, clientId: "bypass", expectedRevision: run.revision, selections: { kind: "docs" }, rationale: "pretend docs" }), { status: 422 });
  run = f.p.branch(f.lead, { runId: run.id, clientId: "code", expectedRevision: run.revision, selections: { kind: "code" }, rationale: "Executable change" }); run = f.done(run);
  assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false); run = f.done(run, "code"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  assert.equal(f.p.gate(f.lead, { ...f.gate(run), nodeId: "code" }).allowed, false, "an ordinary report/check is not an internal-review bypass");
});

test("assigned crew reports immutable copied evidence; only lead endorses and ids cannot cross steps", t => {
  const g = graph(); g.nodes[0]!.evidence = ["report"]; const f = fixture(t, g); let run = f.start();
  const report = join(f.dir, "report.md"); writeFileSync(report, "A scoped review report");
  assert.throws(() => f.p.report(f.crew, { runId: run.id, clientId: "unassigned", expectedRevision: run.revision, nodeId: "checks", notes: "report", evidence: [{ kind: "report", summary: "review", path: report }] }), { status: 403 });
  run = f.p.assign(f.lead, { runId: run.id, clientId: "assign", expectedRevision: run.revision, nodeId: "checks", agentId: f.crew.id });
  run = f.p.report(f.crew, { runId: run.id, clientId: "report", expectedRevision: run.revision, nodeId: "checks", notes: "reviewed", evidence: [{ kind: "report", summary: "review", path: report }] });
  const evidence = run.steps[0]!.evidence[0]!; assert.equal(run.steps[0]!.completedBy, null); assert.match(evidence.fileUrl!, /^\/api\/pipeline\/evidence\//); writeFileSync(report, "source changed after attach"); assert.equal(readFileSync(evidence.storedPath!, "utf8"), "A scoped review report");
  run = f.p.done(f.lead, { runId: run.id, clientId: "endorse", expectedRevision: run.revision, nodeId: "checks", notes: "Accepted report", evidence: [], evidenceIds: [evidence.id] }); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  writeFileSync(evidence.storedPath!, "tampered copy"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
});

test("changed bytes and refreshed rounds invalidate prior completion and evidence", t => {
  const f = fixture(t); let run = f.done(f.start()); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  const old = f.gate(run); writeFileSync(join(f.root, "src.ts"), "new scope\n"); assert.equal(f.p.gate(f.lead, old).allowed, false);
  run = f.p.branch(f.lead, { runId: run.id, clientId: "refresh", expectedRevision: run.revision, selections: {}, rationale: "Implementation changed intended bytes", candidate: "HEAD" });
  assert.equal(run.round, 2); assert.equal(f.p.gate(f.lead, old).allowed, false);
  assert.throws(() => f.p.done(f.lead, { runId: run.id, clientId: "stale-evidence", expectedRevision: run.revision, nodeId: "checks", notes: "reuse old check", evidence: [] }), { status: 409 });
  run = f.done(run); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
});

test("delivery and replay commit once; transaction failure rolls back work, messages and run", t => {
  const f = fixture(t); const run = f.done(f.start()); const input = { title: "Complete", summary: "checked", clientId: "handoff", pipeline: f.gate(run) }; const before = f.counts();
  f.db.exec("CREATE TRIGGER refuse_delivery BEFORE INSERT ON message_deliveries BEGIN SELECT RAISE(ABORT, 'test delivery failure'); END");
  assert.throws(() => f.m.handoff(f.lead, input), /test delivery failure/); assert.deepEqual(f.counts(), before); assert.equal(f.p.get(run.id).state, "open");
  f.db.exec("DROP TRIGGER refuse_delivery"); const delivered = f.m.handoff(f.lead, input); assert.equal(f.p.get(run.id).state, "delivered"); const counts = f.counts();
  assert.deepEqual(f.m.handoff(f.lead, input), delivered); assert.deepEqual(f.counts(), counts);
  assert.throws(() => f.m.handoff(f.lead, { ...input, pipeline: { ...input.pipeline, round: 2 } }), { status: 409 });
  f.reopen(); assert.equal(f.p.get(run.id).state, "delivered"); assert.deepEqual(f.m.handoff(f.lead, input), delivered);
});

test("start/done request replay rejects key reuse and lead takeover inherits the durable run", t => {
  const f = fixture(t); const input = { clientId: "replay-start" }; const started = f.p.start(f.lead, input);
  assert.deepEqual(f.p.start(f.lead, input), started); assert.throws(() => f.p.start(f.lead, { ...input, base: "dev" }), { status: 409 });
  const done = { runId: started.id, clientId: "replay-done", expectedRevision: started.revision, nodeId: "checks", notes: "checked", evidence: [{ kind: "check" as const, summary: "passed", command: "test", exitCode: 0 }] };
  const completed = f.p.done(f.lead, done); assert.deepEqual(f.p.done(f.lead, done), completed);
  f.lead.role = "member"; f.crew.role = "lead"; f.reopen(); assert.equal(f.p.get(started.id).leadId, f.crew.id);
  assert.throws(() => f.p.gate(f.lead, f.gate(completed)), { status: 403 }); assert.equal(f.p.gate(f.crew, f.gate(completed)).allowed, true);
});

test("Git gate binds repository/ref/candidate, refuses release, and unavailable checkouts fail closed", t => {
  const f = fixture(t, graph("dev")); const run = f.done(f.start());
  const valid = { ...f.gate(run), operation: "push" as const, repo: f.root, ref: "refs/heads/dev" };
  assert.equal(f.p.gate(f.lead, valid).allowed, true); assert.equal(f.p.gate(f.lead, { ...valid, ref: "main" }).allowed, false);
  assert.equal(f.p.gate(f.lead, { ...valid, operation: "pr" }).allowed, false); assert.equal(f.p.gate(f.lead, { ...valid, repo: f.dir }).allowed, false);
  assert.equal(f.p.gate(f.lead, { ...valid, candidate: "f".repeat(40) }).allowed, false);
  rmSync(join(f.root, ".git"), { recursive: true, force: true }); assert.equal(f.p.gate(f.lead, valid).allowed, false);
});

test("CLI gate refuses an office outage without a cached grant or local delivery", t => {
  const f = fixture(t, graph("dev")); const run = f.done(f.start()); const before = capture(f.root);
  const result = spawnSync(join(process.cwd(), "bin", "inbox"), ["pipeline", "gate", "--harness", "manual", "--session", "test", "--operation", "push", "--repo", f.root, "--ref", "dev", "--candidate", run.candidate.head, "--run", run.id], { encoding: "utf8", timeout: 15000, env: { ...process.env, HOME: f.dir, INBOX_URL: "http://127.0.0.1:1", INBOX_DATA_DIR: join(f.dir, "unused-office"), INBOX_PRESENCE_DISCOVERY: "0", INBOX_CODEX_ACCOUNT_POLLING: "0", INBOX_BROWSER_CLEANUP: "0" } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /could not reach inbox|fetch failed/); assert.equal(capture(f.root).head, before.head); assert.equal(f.p.get(run.id).state, "open");
});

test("HTTP editor/agent routes validate locks, origins and malformed requests; CLI Git gate is exact", async t => {
  const f = fixture(t, graph("dev")); const h = await httpFixture(t, f);
  assert.equal((await h.request("GET", "/api/world/teams/authors/pipeline/palette")).body.entries.some((e: { id: string }) => e.id === "builtin:check"), true);
  assert.equal((await h.request("PUT", "/api/world/teams/authors/pipeline/layout", { expectedRevision: 0, positions: { checks: { x: 22, y: 12 } } })).status, 200);
  assert.equal((await h.request("PUT", "/api/world/teams/authors/pipeline/layout", { expectedRevision: 0, positions: {} })).status, 409);
  assert.equal((await h.request("PUT", "/api/world/teams/authors/pipeline", { expectedRevision: 0, graph: graph() }, { origin: "https://unrelated.invalid" })).status, 403);
  for (const operation of ["start", "branch", "assign", "done", "report", "status", "gate"]) assert.equal((await h.request("POST", `/api/agent/pipeline/${operation}`, null)).status, 400);
  const started = await h.request("POST", "/api/agent/pipeline/start", { session: h.session(), clientId: "http-start" }); assert.equal(started.status, 200);
  const run = f.done(started.body); const args = ["pipeline", "gate", "--harness", "manual", "--session", f.lead.id, "--operation", "push", "--repo", f.root, "--candidate", run.candidate.head, "--run", run.id, "--ref"];
  const allowed = await h.cli([...args, "refs/heads/dev"]); assert.equal(allowed.status, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).allowed, true);
  const refused = await h.cli([...args, "main"]); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /ref is not/);
});

test("approval binds the submitted run candidate and rejects automatic/stale accepts", async t => {
  const g = graph("dev"); g.nodes[0] = { id: "checks", label: "Founder approval", kind: "approval", source: "builtin:founder-approval", evidence: ["approval"] };
  const f = fixture(t, g); const h = await httpFixture(t, f); let run = f.start();
  const submit = (title: string) => h.request("POST", "/api/agent/items", { session: h.session(), pipeline: { runId: run.id }, item: { type: "milestone", title, context: "Owned candidate" } });
  const automatic = (await submit("Automatic does not satisfy explicit approval")).body;
  h.inbox.answer(automatic.itemId, { revision: automatic.revision, action: "accept" }, "approve_all");
  const done = (item: { itemId: string; revision: number }, key: string) => f.p.done(f.lead, { runId: run.id, expectedRevision: run.revision, clientId: key, nodeId: "checks", notes: "Founder accepted matching snapshot", evidence: [{ kind: "approval", summary: "Exact acceptance", approval: item }] });
  assert.throws(() => done(automatic, "automatic"), /explicit founder/);
  const item = (await submit("Founder explicitly accepts")).body;
  assert.match(h.inbox.item(item.itemId).context, new RegExp(run.candidate.fingerprint));
  assert.equal((await h.request("POST", `/api/items/${item.itemId}/replies`, { revision: item.revision, action: "accept" })).status, 200);
  run = done({ itemId: item.itemId, revision: item.revision }, "explicit"); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, true);
  const revised = await h.request("POST", "/api/agent/items", { session: h.session(), pipeline: { runId: run.id }, item: { type: "milestone", key: h.inbox.item(item.itemId).key, title: "Founder explicitly accepts", context: "Changed presented context" } });
  assert.equal(revised.body.revision, item.revision + 1); assert.equal(f.p.gate(f.lead, f.gate(run)).allowed, false);
});

test("legacy delivery retry identities survive adoption, and startup briefing addresses the first mate", t => {
  const f = fixture(t); writeFileSync(join(f.root, "orchestrator.json"), JSON.stringify({ project: "test", pipeline: null }));
  const input = { title: "Legacy", summary: "same delivery", clientId: "pre-pipeline-handoff" };
  const handed = f.m.handoff(f.lead, input);
  assert.equal(f.db.prepare("SELECT replay_fingerprint FROM messages WHERE id = ?").get(handed.message.id)!.replay_fingerprint,
    requestFingerprint({ title: input.title, summary: input.summary, to: null, work: null }), "absent pipeline must preserve the old replay fingerprint");
  const review = { work: handed.work.id, verdict: "accept", notes: "legacy accept", round: 1, clientId: "pre-pipeline-review" };
  const accepted = f.m.review(f.reviewer, review);
  assert.equal(f.db.prepare("SELECT replay_fingerprint FROM messages WHERE id = ?").get(accepted.message.id)!.replay_fingerprint,
    requestFingerprint({ verdict: review.verdict, notes: review.notes, round: 1 }));
  writeFileSync(join(f.root, "orchestrator.json"), JSON.stringify({ project: "test", pipeline: graph() }));
  assert.deepEqual(f.m.handoff(f.lead, input), handed); assert.deepEqual(f.m.review(f.reviewer, review), accepted);
  assert.match(f.p.brief("authors"), /You own this pipeline/); assert.match(f.p.brief("authors", f.crew.id), /Do your assigned step/);
});

test("final review refuses crew and stale work rounds atomically; lead acceptance and replay succeed", t => {
  const f = fixture(t); writeFileSync(join(f.root, "orchestrator.json"), JSON.stringify({ project: "test", pipeline: null }));
  const handed = f.m.handoff(f.lead, { title: "Legacy candidate", summary: "For receiving-team review", clientId: "legacy" });
  f.state.teams.find(team => team.id === "reviewers")!.worktrees = [f.root]; f.reviewer.cwd = f.root;
  const peer = { ...f.crew, id: "review-crew", identity: "review-crew", teamId: "reviewers", role: "member" as const };
  f.db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, ?, 'member', 'now')").run(peer.id, peer.identity, peer.name, peer.teamId); f.state.agents.push(peer);
  f.p.saveOverride("reviewers", { expectedRevision: 0, graph: graph("review"), repoRoot: f.root });
  let run = f.p.start(f.reviewer, { clientId: "review-run", workId: handed.work.id, workRound: 1 });
  run = f.p.done(f.reviewer, { runId: run.id, clientId: "review-done", expectedRevision: run.revision, nodeId: "checks", notes: "Reviewed exact incoming work", evidence: [{ kind: "check", summary: "passes", command: "review checks", exitCode: 0 }] });
  const input = { work: handed.work.id, round: 1, verdict: "accept", notes: "Accepted", clientId: "accept", pipeline: { ...f.gate(run, "review"), workId: handed.work.id, workRound: 1 } };
  const before = f.counts(); assert.throws(() => f.m.review(peer, input), { status: 403 }); assert.throws(() => f.m.review(f.reviewer, { ...input, round: 2 }), { status: 409 }); assert.deepEqual(f.counts(), before);
  const accepted = f.m.review(f.reviewer, input); assert.equal(accepted.work.state, "accepted"); assert.equal(f.p.get(run.id).state, "delivered"); assert.deepEqual(f.m.review(f.reviewer, input), accepted);
  f.m.handoff(f.lead, { work: handed.work.id, summary: "Second round", clientId: "round-two" });
  assert.throws(() => f.p.start(f.reviewer, { clientId: "stale-review-start", workId: handed.work.id, workRound: 1 }), { status: 409 });
});

test("a declared lane's worktree delivers outside runs, so a run can never be started in it", (t) => {
  const f = fixture(t); const lane = join(f.dir, "einstein"); git(f.root, "worktree", "add", "-q", "-b", "einstein", lane);
  const adapter = JSON.parse(readFileSync(join(f.root, "orchestrator.json"), "utf8"));
  writeFileSync(join(f.root, "orchestrator.json"), JSON.stringify({ ...adapter, lanes: [{ name: "einstein", worktree: "../einstein" }, { name: "galilei", worktree: "../galilei" }], pipelineHooks: { laneDelivery: { lanes: ["einstein"] } } }));
  git(f.root, "commit", "-qam", "Declare the lane"); git(lane, "merge", "-q", "--ff-only", "dev");
  assert.throws(() => f.p.start(f.lead, { clientId: "in-lane", checkout: lane }), { status: 409, code: "pipeline_lane_checkout" });
  assert.equal(f.start().state, "open", "the team's own checkout still starts runs");
});
