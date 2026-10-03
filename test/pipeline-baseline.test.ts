import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineEvidenceInput, PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// A failing check counts only when the same command failed the same way on the run's base, and is never shown as a pass.
const graph: PipelineGraph = { version: 1, id: "wave", label: "Checked delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "checks", to: "deliver" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const check = (command: string, exitCode: number, onBase = false): PipelineEvidenceInput => ({ kind: "check", summary: onBase ? "Ran on base" : "Ran on candidate", command, exitCode, ...(onBase ? { onBase } : {}) });

async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-baseline-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "authors"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "authors", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "branch", "baseline");
  writeFileSync(join(root, "other.ts"), "export const other = 1;\n"); git(root, "add", "."); git(root, "commit", "-qm", "published meanwhile"); git(root, "branch", "later");
  writeFileSync(join(root, "src.ts"), "export const value = 2;\n"); git(root, "commit", "-qam", "wave");
  const db = openDatabase(join(dir, "office.sqlite"));
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: p, state: () => state, onChange: () => {}, react: async () => {}, resolve: () => lead } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  let n = 0;
  const run = () => p.get(p.start(lead, { clientId: `start-${++n}`, base: "baseline" }).id);
  const report = (r: PipelineRun, ...evidence: PipelineEvidenceInput[]) => p.report(lead, { runId: r.id, clientId: `report-${++n}`, expectedRevision: p.get(r.id).revision, nodeId: "checks", notes: "Recorded", evidence });
  const done = (r: PipelineRun, ...evidence: PipelineEvidenceInput[]) => p.done(lead, { runId: r.id, clientId: `done-${++n}`, expectedRevision: p.get(r.id).revision, nodeId: "checks", notes: "Checked", evidence });
  const gate = (r: PipelineRun) => { const now = p.get(r.id); return p.gate(lead, { runId: now.id, delivery: "dev", round: now.round, candidate: now.candidate.head }); };
  const step = (r: PipelineRun) => p.get(r.id).steps.find(s => s.nodeId === "checks")!;
  const http = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { root, p, lead, run, report, done, gate, step, http };
}

test("a check that fails exactly as on base counts, and is shown as failing as on base everywhere", async t => {
  const o = await office(t); const r = o.run();
  // The base record arrives through the agent protocol, as `inbox pipeline report --on-base` sends it.
  const sent = await o.http("/api/agent/pipeline/report", { session: { harness: "manual", sessionId: "captain", cwd: o.root }, runId: r.id, clientId: "base-record", expectedRevision: r.revision, nodeId: "checks", notes: "npm test fails on base", evidence: [check("npm test", 1, true)] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const base = o.step(r).evidence[0]!;
  assert.equal(base.onBase, true); assert.equal(base.ranOn, r.candidate.base);
  // A base record never completes a required check by itself.
  assert.throws(() => o.done(r), { code: "pipeline_evidence_required" });
  o.done(r, check(" npm test ", 1));
  const s = o.step(r);
  assert.equal(s.state, "done");
  assert.deepEqual(s.baselineFailures, [`\`npm test\` exit 1 (base ${r.candidate.base.slice(0, 10)})`]);
  const result = o.gate(r);
  assert.equal(result.allowed, true, result.reasons.join("; "));
  assert.equal(result.baselineFailures?.length, 1); assert.match(result.baselineFailures![0]!, /^checks: fails as on base: `npm test` exit 1/);
  assert.match(o.p.brief("authors", "captain"), /checks: done .*fails as on base, not a pass: `npm test` exit 1/);
});

test("a passing check is unmarked, and a failure without its exact base twin is refused by done, Runs and the gate", async t => {
  const o = await office(t);
  const clean = o.run(); o.done(clean, check("npm test", 0));
  assert.equal(o.step(clean).baselineFailures, undefined); assert.equal(o.gate(clean).baselineFailures, undefined);
  o.p.abandon(o.lead, { runId: clean.id, clientId: "close-clean", notes: "Next case" });
  const r = o.run();
  // The base passes while the candidate fails; another command; another exit code: all stay refused.
  for (const [baseRecord, failure] of [[check("npm test", 0, true), /failed with exit 1 on base/], [check("npm run test", 1, true), /`npm test` exited 1 on the candidate/], [check("npm test", 2, true), /same command failed with exit 1/]] as const) {
    o.report(r, baseRecord);
    assert.throws(() => o.done(r, check("npm test", 1)), (e: Error & { code?: string }) => e.code === "pipeline_evidence_required" && failure.test(e.message));
  }
  // A report of the failure is kept, but it never makes the step done, and done still names why.
  o.report(r, check("npm test", 1));
  const s = o.step(r);
  assert.notEqual(s.state, "done"); assert.equal(s.baselineFailures, undefined);
  const result = o.gate(r);
  assert.equal(result.allowed, false); assert.ok(result.reasons.some(x => /^checks: /.test(x)));
  const failing = o.step(r).evidence.at(-1)!;
  assert.throws(() => o.p.done(o.lead, { runId: r.id, clientId: "endorse-failure", expectedRevision: o.p.get(r.id).revision, nodeId: "checks", notes: "Endorse", evidence: [], evidenceIds: [failing.id] }), /same command failed with exit 1 on base/);
});

test("a re-base retires the base record, even when the round is kept; the failure is recorded again on the new base", async t => {
  const o = await office(t);
  // Own bytes on a wave branch from the old base; integration work is published meanwhile and merged in.
  git(o.root, "checkout", "-qb", "wave", "baseline"); writeFileSync(join(o.root, "src.ts"), "export const value = 3;\n"); git(o.root, "commit", "-qam", "own bytes");
  const r = o.run();
  o.report(r, check("npm test", 1, true)); o.done(r, check("npm test", 1));
  assert.equal(o.gate(r).allowed, true);
  const remote = join(o.root, "..", "remote.git"); git(o.root, "init", "--bare", "-q", remote); git(o.root, "remote", "add", "origin", remote);
  git(o.root, "push", "-q", "origin", "later:dev"); git(o.root, "fetch", "-q", "origin"); git(o.root, "merge", "-q", "--no-edit", "later");
  const later = git(o.root, "rev-parse", "later");
  const moved = o.p.branch(o.lead, { runId: r.id, clientId: "rebase", selections: {}, rationale: "Published work merged meanwhile", base: later });
  // Unchanged own bytes keep the round, so only the recorded base tells the old record apart.
  assert.equal(moved.candidate.base, later); assert.equal(moved.round, r.round);
  const s = o.step(r);
  assert.equal(s.state, "stale"); assert.equal(s.baselineFailures, undefined);
  assert.ok(s.problems?.some(x => x.includes(`was recorded on base ${r.candidate.base.slice(0, 10)}, not this run's base ${later.slice(0, 10)}`)), JSON.stringify(s.problems));
  assert.equal(o.gate(r).allowed, false);
  assert.throws(() => o.done(r, check("npm test", 1)), /same command failed with exit 1 on base/);
  o.report(r, check("npm test", 1, true));
  o.done(r, check("npm test", 1));
  assert.deepEqual(o.step(r).evidence.filter(e => e.onBase).map(e => e.ranOn), [later]);
  assert.deepEqual(o.gate(r).baselineFailures, [`checks: fails as on base: \`npm test\` exit 1 (base ${later.slice(0, 10)})`]);
});

test("only checks can be recorded on the base, and a check still needs an integer exit code", async t => {
  const o = await office(t); const r = o.run();
  assert.throws(() => o.report(r, { kind: "report", summary: "base", url: "https://example.invalid/r", onBase: true }), { status: 422 });
  assert.throws(() => o.report(r, { kind: "check", summary: "no exit", command: "npm test" }), /needs its command and exit code/);
  assert.throws(() => o.report(r, { kind: "check", summary: "odd exit", command: "npm test", exitCode: 1.5 }), /needs its command and exit code/);
});
