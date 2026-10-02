import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Messages } from "../src/server/messages.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import type { World } from "../src/server/world.ts";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { validateGraph, activation, pathProblems } from "../src/server/pipelines/model.ts";
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

test("validation rejects cycles, missing delivery, missing condition ports and unchecked steps", () => {
  assert.equal(validateGraph(graph()).nodes.length, 2);
  assert.throws(() => validateGraph({ ...graph(), nodes: [graph().nodes[0]] }), /endpoints/);
  assert.throws(() => validateGraph({ ...graph(), nodes: [{ ...graph().nodes[0], evidence: [] }, graph().nodes[1]] }), /evidence/);
  assert.throws(() => validateGraph({ ...graph(), fields: [{ id: "risk", label: "Risk", type: "boolean" }], nodes: [{ id: "checks", label: "Risk", kind: "condition", field: "risk" }, graph().nodes[1]], edges: [{ id: "yes", from: "checks", to: "deliver", port: "true" }] }), /false branch/);
  assert.throws(() => validateGraph({ ...graph(), nodes: [...graph().nodes, { id: "stray", label: "Unreachable", kind: "step", source: "builtin:check", evidence: ["check"] }] }), /reachable/);
});

test("FysikLab default preserves mandatory authoring/framework scopes and the dispatched fast path", () => {
  const g = validateGraph(JSON.parse(readFileSync(new URL("./fixtures/pipelines/fysiklab-default.json", import.meta.url), "utf8")).pipeline);
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
