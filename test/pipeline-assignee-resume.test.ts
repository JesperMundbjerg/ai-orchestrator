import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, sessionKey } from "../src/server/db.ts";
import { InboxError } from "../src/server/inbox.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { telemetryQuery } from "../src/server/pipelines/protocol.ts";
import { INBOX_BIN } from "../src/shared/pipeline-cli.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
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
  /** What the office's world records for an agent id's live pane (world.ts recordSession), or forgets it. */
  const ran = (agentId: string, harness: string, sessionId: string) => db.prepare("INSERT INTO world_agent_sessions (agent_id, session_key, seen_at) VALUES (?, ?, 'now') ON CONFLICT (agent_id) DO UPDATE SET session_key = excluded.session_key")
    .run(agentId, sessionKey(harness, sessionId));
  const step = (run: PipelineRun) => p.get(run.id).steps.find(s => s.nodeId === "plan")!;
  const carried = () => { p.telemetry.flush(); return p.telemetry.read({ kind: "assignee" }).events; };
  return { state, lead, old, resumed, p, db, assign, report, refusal, ran, step, carried, start: () => p.start(lead, { clientId: `start-${n++}` }) };
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

test("a resumed session under a new agent id reports its step only on an exact harness + session id match, and the step moves to it", t => {
  const o = office(t);
  o.old.status = "idle"; o.old.paneId = "p-old"; o.ran(o.old.id, "claude", "sess-1");
  let run = o.assign(o.start(), o.old.id);
  assert.equal(o.step(run).assignedSession, sessionKey("claude", "sess-1"));
  // Crash: the old pane is gone; `claude --resume sess-1` comes back under another herdr name, so another agent id.
  o.old.status = "offline"; o.old.paneId = null; o.ran(o.resumed.id, "claude", "sess-1");
  run = o.report(run, o.resumed);
  assert.equal(o.step(run).assignedTo, o.resumed.id); assert.equal(o.step(run).state, "reported");
  assert.equal(o.step(run).assignedSession, sessionKey("claude", "sess-1"));
  const events = o.carried(); assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.detail, { how: "same-session", nodeId: "plan", from: o.old.id, to: o.resumed.id, recordedAt: "assignment" });
  assert.equal(events[0]!.runId, run.id);
  // `inbox pipeline telemetry --kind assignee` asks the office with kind=assignee: accepted, and only those events come back.
  const query = telemetryQuery(new URLSearchParams("kind=assignee"));
  assert.equal(query.kind, "assignee");
  assert.deepEqual(o.p.telemetry.read(query).events.map(e => e.kind), ["assignee"]);
  o.p.telemetry.note("integration", run.id, run.teamId, { changes: ["unchanged"] }); o.p.telemetry.flush();
  assert.deepEqual(o.p.telemetry.read(query).events.map(e => e.kind), ["assignee"]);
  assert.ok(o.p.telemetry.read(telemetryQuery(new URLSearchParams("kind=integration"))).events.every(e => e.kind === "integration"));
  // The old id no longer holds it: back under its old name in a new session, it is someone else.
  o.old.status = "idle"; o.old.paneId = "p-old"; o.ran(o.old.id, "claude", "sess-9");
  assert.equal(o.refusal(() => o.report(run, o.old)).code, "pipeline_not_assignee");
});

test("a forked, unknown, other-harness or not-running session is refused and the step stays put", t => {
  const o = office(t);
  o.ran(o.old.id, "claude", "sess-1");
  const run = o.assign(o.start(), o.old.id);
  const refused = (why: string) => {
    const err = o.refusal(() => o.report(run, o.resumed));
    assert.equal(err.status, 403, why); assert.equal(err.code, "pipeline_not_assignee", why);
    assert.equal(o.step(run).assignedTo, o.old.id, why);
  };
  refused("the office never saw the new agent's session");
  o.ran(o.resumed.id, "claude", "sess-1-fork"); refused("--fork-session starts a new session id");
  o.ran(o.resumed.id, "pi", "sess-1"); refused("the same session id under another harness is another session");
  o.ran(o.resumed.id, "claude", "sess-1"); o.resumed.status = "offline"; o.resumed.paneId = null; refused("only a running agent has a session now");
  assert.equal(o.carried().length, 0);
});

test("a step assigned before its holder's session was known follows the session the office later saw the holder run", t => {
  const o = office(t);
  let run = o.assign(o.start(), o.old.id);
  assert.equal(o.step(run).assignedSession, null);
  o.ran(o.old.id, "claude", "sess-1"); o.ran(o.resumed.id, "claude", "sess-1");
  run = o.report(run, o.resumed);
  assert.equal(o.step(run).assignedTo, o.resumed.id);
  assert.equal(o.carried()[0]!.detail.recordedAt, "agent");
});

test("the world records each running pane's harness session per agent id, hashed, and nothing for a task nobody runs", t => {
  const db = openDatabase(":memory:");
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const dir = mkdtempSync(join(tmpdir(), "assignee-world-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inbox = new Inbox(db, join(dir, "files"), presence);
  let live: LiveAgent[] = [];
  const source = { available: () => true, live: () => live, prompt: async () => {}, notify: async () => {}, createWorktree: async () => ({ paneId: "w" }), startAgent: async () => {} } as unknown as AgentSource;
  const world = new World(db, source, () => inbox.state());
  t.after(() => db.close());
  const keys = () => new Map((db.prepare("SELECT agent_id, session_key FROM world_agent_sessions").all() as { agent_id: string; session_key: string }[]).map(r => [r.agent_id, r.session_key]));
  live = [{ paneId: "p1", harness: "claude", sessionId: "sess-1", cwd: dir, status: "idle", title: null, name: "dispatch-einstein" }];
  const before = world.state().agents.find(a => a.name && a.paneId === "p1")!;
  assert.equal(keys().get(before.id), sessionKey("claude", "sess-1"));
  assert.ok(![...keys().values()].includes("sess-1"));
  // Resumed in another pane under another herdr name: a new agent id, the same session key.
  live = [{ paneId: "p2", harness: "claude", sessionId: "sess-1", cwd: dir, status: "idle", title: null, name: "einstein" }];
  const after = world.state().agents.find(a => a.paneId === "p2")!;
  assert.notEqual(after.id, before.id);
  assert.equal(keys().get(after.id), keys().get(before.id));
  // A session the harness now runs in that pane replaces what was recorded for it.
  live = [{ paneId: "p2", harness: "claude", sessionId: "sess-2", cwd: dir, status: "idle", title: null, name: "einstein" }];
  world.state(); assert.equal(keys().get(after.id), sessionKey("claude", "sess-2"));
  // A write made while a decision's transaction is open and then rolled back is made again at the next look.
  live = [{ paneId: "p2", harness: "claude", sessionId: "sess-4", cwd: dir, status: "idle", title: null, name: "einstein" }];
  db.exec("BEGIN"); world.state(); db.exec("ROLLBACK");
  assert.equal(keys().get(after.id), sessionKey("claude", "sess-2"));
  world.state(); assert.equal(keys().get(after.id), sessionKey("claude", "sess-4"));
  live = [];
  inbox.submit({ session: { harness: "claude", sessionId: "sess-3", cwd: join(dir, "elsewhere") }, item: { type: "milestone", fixed: "Fixed.", title: "Offline work" } });
  const offline = world.state().agents.filter(a => !a.paneId);
  assert.ok(offline.length >= 1); for (const a of offline) assert.ok(!keys().has(a.id) || a.id === before.id || a.id === after.id);
  assert.equal(keys().size, 2);
});

test("migration 21 adds the session record to an existing database without touching its agents", t => {
  const dir = mkdtempSync(join(tmpdir(), "assignee-migration-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "inbox.sqlite");
  let db = openDatabase(file);
  db.prepare("INSERT INTO world_agents (id, identity, name, role, first_seen_at) VALUES ('a1', 'claude:/x@gal', 'Gal', 'member', 'now')").run();
  db.exec("DROP TABLE world_agent_sessions; PRAGMA user_version = 20"); db.close();
  db = openDatabase(file); t.after(() => db.close());
  assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 21);
  assert.deepEqual(db.prepare("SELECT id, name FROM world_agents").all().map(r => ({ ...r })), [{ id: "a1", name: "Gal" }]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM world_agent_sessions").get()!.n), 0);
});
