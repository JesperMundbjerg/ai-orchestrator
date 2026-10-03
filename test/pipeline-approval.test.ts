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
import { Messages } from "../src/server/messages.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Founder approval and review receipts authorize only the run, round, scope and bytes they were given for.
const approvalGraph: PipelineGraph = { version: 1, id: "wave", label: "Approved delivery", entry: "approve", fields: [],
  nodes: [{ id: "approve", label: "Founder approves", kind: "approval", source: "builtin:founder-approval", evidence: ["approval"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "approve", to: "deliver" }] };
const reviewGraph: PipelineGraph = { version: 1, id: "wave", label: "Reviewed delivery", entry: "review", fields: [],
  nodes: [{ id: "review", label: "Other team reviews", kind: "step", source: "builtin:work", evidence: ["review"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "review", to: "deliver" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

async function office(t: TestContext, graph = approvalGraph) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-approval-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Two teams in two repositories whose waves change src.ts from different baselines to the same final bytes.
  const repo = (name: string, start: string) => {
    const root = join(dir, name); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
    writeFileSync(join(root, "src.ts"), start); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: name, integrationBranch: "dev", pipeline: graph }));
    git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "branch", "baseline");
    writeFileSync(join(root, "src.ts"), "export const value = 'same final bytes';\n"); git(root, "commit", "-qam", "wave");
    return root;
  };
  const root = repo("authors", "export const value = 1;\n"), other = repo("others", "export const value = 'other baseline';\n");
  const db = openDatabase(join(dir, "office.sqlite"));
  const team = (id: string, worktrees: string[]) => ({ id, name: id, purpose: "", standing: true, path: null, branch: null, worktrees, handsTo: null, createdAt: "now" });
  const agent = (id: string, teamId: string, cwd: string) => ({ id, name: id, identity: id, harness: "manual", cwd, teamId, role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as WorldAgent;
  const lead = agent("captain", "authors", root), otherLead = agent("other-captain", "others", other), reviewer = agent("reviewer", "reviewers", dir);
  const state = { agents: [lead, otherLead, reviewer], teams: [team("authors", [root]), team("others", [other]), team("reviewers", [])], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  for (const t of state.teams) db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES (?, ?, 1, 'now')").run(t.id, t.name);
  for (const a of state.agents) db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, ?, ?, 'now')").run(a.id, a.identity, a.name, a.teamId, a.role);
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const m = new Messages(db, null, () => state, () => new Date(), () => {}); m.pipelines = p;
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const auto = new AutoApprove(db, inbox);
  const world = { pipelines: p, messages: m, state: () => state, onChange: () => {}, react: async () => {}, resolve: (s: { sessionId?: string }) => state.agents.find(a => a.id === s.sessionId)! } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  let n = 0;
  const present = async (run: PipelineRun, by = lead, key = `present-${++n}`) => {
    const r = await request("POST", "/api/agent/items", { session: { harness: "manual", sessionId: by.id, cwd: by.cwd }, pipeline: { runId: run.id }, item: { type: "milestone", key, title: "Wave ready", context: "Pinned candidate" } });
    assert.equal(r.status, 200, JSON.stringify(r.body)); return { itemId: r.body.itemId as string, revision: r.body.revision as number };
  };
  const reply = (item: { itemId: string; revision: number }, action: "accept" | "discuss" | "request_changes", text = "") => request("POST", `/api/items/${item.itemId}/replies`, { revision: item.revision, action, text });
  const approve = (run: PipelineRun, item: { itemId: string; revision: number }, by = lead) => p.done(by, { runId: run.id, clientId: `approve-${++n}`, expectedRevision: run.revision, nodeId: "approve", notes: "Founder accepted", evidence: [{ kind: "approval", summary: "Explicit acceptance", approval: item }] });
  const gate = (run: PipelineRun, by = lead) => p.gate(by, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head });
  // The base is the commit before the wave, so each scope is the nonempty src.ts change.
  const start = (by = lead) => p.start(by, { clientId: `start-${++n}`, base: "baseline" });
  const step = (run: PipelineRun, nodeId = "approve") => p.get(run.id).steps.find(s => s.nodeId === nodeId)!;
  return { dir, root, other, db, p, m, inbox, auto, lead, otherLead, reviewer, state, present, reply, approve, gate, start, step, request };
}

test("an acceptance never authorizes another run: abandoned run, or equal bytes in another repository", async t => {
  const o = await office(t);
  const a = o.start(); const item = await o.present(a);
  assert.equal((await o.reply(item, "accept")).status, 200);
  assert.equal(o.gate(o.approve(a, item)).allowed, true);
  o.p.abandon(o.lead, { runId: a.id, clientId: "close-a", notes: "Replaced" });
  // Run B has the very same intended bytes, but the founder never saw it.
  const b = o.start(); assert.equal(b.candidate.fingerprint, a.candidate.fingerprint);
  assert.throws(() => o.approve(b, item), { status: 409, message: /another run's presentation/ });
  assert.equal(o.gate(b).allowed, false);
  // Another team, another repository, a different baseline, identical final bytes.
  const elsewhere = o.start(o.otherLead);
  assert.deepEqual(elsewhere.candidate.changedPaths, ["src.ts"]); assert.equal(elsewhere.candidate.fingerprint, a.candidate.fingerprint);
  assert.throws(() => o.approve(elsewhere, item, o.otherLead), { status: 409, message: /another run's presentation/ });
  assert.equal(o.gate(elsewhere, o.otherLead).allowed, false);
});

test("an acceptance from an earlier round never counts after the bytes change and change back", async t => {
  const o = await office(t);
  let run = o.start(); const item = await o.present(run); await o.reply(item, "accept");
  const head = run.candidate.head;
  writeFileSync(join(o.root, "src.ts"), "export const value = 'interim';\n"); git(o.root, "commit", "-qam", "interim");
  run = o.p.branch(o.lead, { runId: run.id, clientId: "interim", expectedRevision: run.revision, selections: {}, rationale: "interim", candidate: "HEAD" });
  git(o.root, "revert", "--no-edit", "HEAD");
  run = o.p.branch(o.lead, { runId: run.id, clientId: "back", expectedRevision: run.revision, selections: {}, rationale: "back", candidate: "HEAD" });
  assert.notEqual(run.candidate.head, head); assert.equal(run.round, 3);
  assert.throws(() => o.approve(run, item), { status: 409, message: /earlier round/ });
  // Presenting the current round again is the way forward.
  const again = await o.present(run, o.lead, "present-again"); await o.reply(again, "accept");
  assert.equal(o.gate(o.approve(run, again)).allowed, true);
});

test("a later message keeps the approval; only an explicit change of decision withdraws it, and Runs agrees with the gate", async t => {
  const o = await office(t);
  let run = o.start(); const item = await o.present(run); await o.reply(item, "accept");
  run = o.approve(run, item);
  assert.equal((await o.reply(item, "discuss", "Thanks. Keep the accepted receipt layout.")).status, 200);
  assert.equal(o.step(run).state, "done"); assert.equal(o.gate(run).allowed, true);
  assert.equal(o.inbox.detail(item.itemId).pipelineApproval?.accepted, true);

  assert.equal((await o.reply(item, "request_changes", "Actually, not yet.")).status, 200);
  const stale = o.step(run);
  assert.equal(stale.state, "stale"); assert.match(stale.problems!.join(), /changed the decision/);
  const refused = o.gate(run);
  assert.equal(refused.allowed, false);
  assert.ok(refused.reasons.some(r => r.includes("approve: stale") && r.includes(stale.problems![0]!)), refused.reasons.join("; "));
  assert.equal(o.inbox.detail(item.itemId).pipelineApproval?.accepted, false);

  // Accepting the same revision again is the founder's own decision once more.
  await o.reply(item, "accept");
  assert.equal(o.step(run).state, "done"); assert.equal(o.gate(run).allowed, true);
});

test("approve-all leaves a pipeline's approval waiting for the founder; an explicit Accept still works on an auto-answered one", async t => {
  const o = await office(t);
  o.auto.setEnabled(true);
  const run = o.start(); const item = await o.present(run);
  assert.equal(o.inbox.item(item.itemId).state, "needs_attention");
  assert.deepEqual(o.inbox.detail(item.itemId).replies, []);
  assert.deepEqual(o.inbox.detail(item.itemId).pipelineApproval, { runId: run.id, accepted: false });
  // Ordinary items are still auto-answered, and turning it on again sweeps nothing pipeline-bound.
  const plain = o.inbox.submit({ session: { harness: "manual", sessionId: "someone-else" }, item: { type: "milestone", title: "Unrelated" } });
  assert.equal(o.inbox.item(plain.itemId).state, "answer_queued");
  o.auto.setEnabled(false); o.auto.setEnabled(true);
  assert.equal(o.inbox.item(item.itemId).state, "needs_attention");

  // An item auto-answered before this rule keeps an explicit Accept the founder can give.
  const legacy = await o.present(run, o.lead, "legacy");
  o.inbox.answer(legacy.itemId, { id: `approve-all:${legacy.itemId}:${legacy.revision}`, revision: legacy.revision, action: "accept", text: "Auto-approved (approve all)." }, "approve_all");
  assert.throws(() => o.approve(run, legacy), /explicit founder acceptance/);
  assert.equal(o.inbox.detail(legacy.itemId).pipelineApproval?.accepted, false);
  await o.reply(legacy, "accept");
  assert.equal(o.inbox.detail(legacy.itemId).pipelineApproval?.accepted, true);
  assert.equal(o.gate(o.approve(run, legacy)).allowed, true);
});

test("QA answers never take a pipeline's approval: the QA agent is not offered it, cannot answer it, and it stays in Needs you", async t => {
  const o = await office(t);
  // The reviewer is the QA agent here; nothing but the office's own records decides what it may answer.
  o.auto.qa.office = { agent: (id) => (id === "reviewer" ? { id, name: "reviewer", online: true, taskIds: [] } : null),
    resolve: () => ({ id: "reviewer", name: "reviewer", online: true, taskIds: [] }), notice: () => {} };
  o.auto.setMode("qa", "reviewer");
  const run = o.start(); const item = await o.present(run);
  assert.equal(o.auto.qa.next({ harness: "manual", sessionId: "reviewer" }).item, null);
  assert.throws(() => o.auto.qa.answer({ session: { harness: "manual", sessionId: "reviewer" }, item: item.itemId, revision: item.revision, action: "accept", reason: "r" }),
    /stays with the founder: a pipeline's “Founder approves” step/);
  assert.equal(o.inbox.state().items.length, o.auto.qa.mark(o.inbox.state()).items.filter((i) => !i.withQa).length, "nothing pipeline-bound leaves Needs you");
  // Even a QA answer that reached it some other way is not the founder's acceptance.
  o.inbox.answer(item.itemId, { id: `qa:${item.itemId}:${item.revision}`, revision: item.revision, action: "accept", text: "QA" }, "qa_agent");
  assert.throws(() => o.approve(run, item), /explicit founder acceptance/);
});

test("a review receipt belongs to the run that handed the work over, not to equal bytes elsewhere", async t => {
  const o = await office(t, reviewGraph);
  const a = o.start();
  const handed = o.m.handoff(o.lead, { title: "Review the wave", summary: "Exact candidate", to: "reviewers", clientId: "hand-a", pipeline: { runId: a.id, delivery: "handoff", round: a.round, candidate: a.candidate.head, nodeId: "review" } });
  o.m.review(o.reviewer, { work: handed.work.id, verdict: "accept", notes: "Looks right", round: handed.work.round, clientId: "review-a" });
  const review = { kind: "review" as const, summary: "Accepted by reviewers", review: { workId: handed.work.id, round: handed.work.round } };
  const done = (run: PipelineRun, by = o.lead) => o.p.done(by, { runId: run.id, clientId: `review-done-${run.id}`, expectedRevision: run.revision, nodeId: "review", notes: "Reviewed", evidence: [review] });
  assert.equal(o.gate(done(a)).allowed, true);
  o.p.abandon(o.lead, { runId: a.id, clientId: "close-review-a", notes: "Replaced" });
  const b = o.start();
  assert.throws(() => done(b), { status: 409, message: /did not hand over/ });
  const elsewhere = o.start(o.otherLead);
  assert.throws(() => done(elsewhere, o.otherLead), { status: 409, message: /did not hand over/ });
});
