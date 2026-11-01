import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { validateGraph } from "../src/server/pipelines/model.ts";
import type { World } from "../src/server/world.ts";
import { INBOX_BIN } from "../src/shared/pipeline-cli.ts";
import { pipelineCommand } from "../src/cli/pipeline.ts";
import { checkEvidence, checkPlan, runCommand } from "../src/cli/pipeline-check.ts";
import type { PipelineEvidenceInput, PipelineGraph, PipelineNode, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// A check step that names its command counts only with that command, exit 0, run at the run's current candidate.
// A crew-only step never counts the first mate's own evidence. Steps that name neither behave as before.
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const graphOf = (node: Partial<PipelineNode> & { id: string }): PipelineGraph => ({ version: 1, id: "wave", label: "Enforced", entry: node.id, fields: [],
  nodes: [{ label: "Step", kind: "step", source: node.evidence?.includes("check") ? "builtin:check" : "builtin:work", evidence: ["report"], ...node } as PipelineNode, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: node.id, to: "deliver" }] });

async function office(t: TestContext, graph: PipelineGraph) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-check-command-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "authors"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "authors", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "branch", "baseline");
  writeFileSync(join(root, "src.ts"), "export const value = 2;\n"); git(root, "commit", "-qam", "wave");
  const db = openDatabase(join(dir, "office.sqlite"));
  const agent = (id: string, role: "lead" | "member") => ({ id, name: id, identity: id, harness: "manual", cwd: root, teamId: "authors", role, paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false }) as WorldAgent;
  const lead = agent("captain", "lead"); const crew = agent("crew", "member");
  const state = { agents: [lead, crew], teams: [{ id: "authors", name: "authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'authors', 1, 'now')").run();
  for (const a of [lead, crew]) db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES (?, ?, ?, 'authors', ?, 'now')").run(a.id, a.id, a.id, a.role);
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: p, state: () => state, onChange: () => {}, react: async () => {}, resolve: () => lead } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  let n = 0; const nodeId = graph.entry;
  const run = () => p.get(p.start(lead, { clientId: `start-${++n}`, base: "baseline" }).id);
  const report = (who: WorldAgent, r: PipelineRun, ...evidence: PipelineEvidenceInput[]) => p.report(who, { runId: r.id, clientId: `report-${++n}`, expectedRevision: p.get(r.id).revision, nodeId, notes: "Recorded", evidence });
  const done = (r: PipelineRun, ...evidence: PipelineEvidenceInput[]) => p.done(lead, { runId: r.id, clientId: `done-${++n}`, expectedRevision: p.get(r.id).revision, nodeId, notes: "Disposed", evidence });
  const gate = (r: PipelineRun) => { const now = p.get(r.id); return p.gate(lead, { runId: now.id, delivery: "dev", round: now.round, candidate: now.candidate.head }); };
  const step = (r: PipelineRun) => p.get(r.id).steps.find(s => s.nodeId === nodeId)!;
  const http = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { root, dir, port, p, lead, crew, run, report, done, gate, step, http, nodeId };
}
/** Evidence as `inbox pipeline check` records it. */
const ran = (command: string, exitCode: number, candidate: string): PipelineEvidenceInput => ({ kind: "check", summary: `ran ${command}`, command, exitCode, durationMs: 1234, outputTail: "ok", candidate });
const refusal = (code: string, ...parts: RegExp[]) => (e: Error & { code?: string }) => e.code === code && parts.every(x => x.test(e.message));

test("a check step that names its command refuses free-form evidence and says which command to run", async t => {
  const o = await office(t, graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: "npm run typecheck" })); const r = o.run();
  const named = [/`npm run typecheck`/, new RegExp(`${INBOX_BIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} pipeline check ${r.id} typecheck`)];
  // Any exit-0 check satisfied this step before; now another command, a bare record and a base record are all refused.
  assert.throws(() => o.report(o.lead, r, { kind: "check", summary: "free", command: "npm test", exitCode: 0 }), refusal("pipeline_check_command", /`npm test` is not Typecheck/, ...named));
  assert.throws(() => o.done(r, { kind: "check", summary: "free", command: "npm run typecheck", exitCode: 0 }), refusal("pipeline_check_command", /not recorded against a candidate/, ...named));
  assert.throws(() => o.report(o.lead, r, { ...ran("npm run typecheck", 0, r.candidate.head), onBase: true }), refusal("pipeline_check_command", /not a base record/));
  assert.throws(() => o.report(o.lead, r, ran("npm run typecheck", 0, r.candidate.base)), refusal("pipeline_check_command", /ran at .* not the run's current candidate/));
  assert.equal(o.step(r).evidence.length, 0);
  assert.equal(o.gate(r).allowed, false);
  assert.match(o.gate(r).reasons.join("\n"), /typecheck: ready; requires check evidence for `npm run typecheck` with exit 0 at candidate .*: run .* pipeline check /);
  assert.match(o.p.brief("authors", "captain"), /typecheck: ready .*requires check evidence for `npm run typecheck`.*pipeline check /);
  // A failing run is recorded but never counts, and nothing counts as failing "as on base" for such a step.
  o.report(o.lead, r, ran("npm run typecheck", 2, r.candidate.head));
  assert.equal(o.step(r).state, "stale"); assert.equal(o.step(r).baselineFailures, undefined);
  assert.match(o.step(r).problems!.join(), /exited 2 .* needs exit 0/);
  assert.throws(() => o.done(r), refusal("pipeline_check_command", /needs check evidence for `npm run typecheck` with exit 0/));
  assert.equal(o.gate(r).allowed, false);
  // The command with exit 0 at the current candidate completes it, and the briefing names it.
  o.done(r, ran(" npm run typecheck ", 0, r.candidate.head));
  assert.equal(o.step(r).state, "done"); assert.equal(o.gate(r).allowed, true, o.gate(r).reasons.join("; "));
  assert.match(o.p.brief("authors", "captain"), /typecheck: done .*required command: `npm run typecheck`/);
  const stored = o.step(r).evidence.at(-1)!; assert.deepEqual([stored.durationMs, stored.outputTail, stored.candidate], [1234, "ok", r.candidate.head]);
});

test("recorded check evidence goes stale when the run is re-pinned to another commit, even with the same bytes", async t => {
  const o = await office(t, graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: "npm run typecheck" })); const r = o.run();
  o.done(r, ran("npm run typecheck", 0, r.candidate.head)); assert.equal(o.gate(r).allowed, true);
  git(o.root, "commit", "-q", "--amend", "-m", "wave, reworded");
  const moved = o.p.branch(o.lead, { runId: r.id, clientId: "repin", selections: {}, rationale: "Reworded commit", candidate: "HEAD", expectedRevision: o.p.get(r.id).revision });
  assert.equal(moved.round, r.round, "same intended bytes keep the round");
  assert.notEqual(moved.candidate.head, r.candidate.head);
  assert.equal(o.step(r).state, "stale");
  assert.match(o.step(r).problems!.join(), /ran at .* not the run's current candidate/);
  assert.equal(o.gate(r).allowed, false);
  const again = o.p.get(r.id); o.done(again, ran("npm run typecheck", 0, again.candidate.head));
  assert.equal(o.gate(again).allowed, true);
});

test("a list of commands requires every one of them", async t => {
  const o = await office(t, graphOf({ id: "checks", label: "Checks", evidence: ["check"], command: ["npm run typecheck", "npm run lint"] })); const r = o.run();
  o.report(o.lead, r, ran("npm run typecheck", 0, r.candidate.head));
  assert.throws(() => o.done(r), refusal("pipeline_check_command", /`npm run lint` with exit 0/));
  o.done(r, ran("npm run lint", 0, r.candidate.head));
  assert.equal(o.step(r).state, "done");
});

test("the agent protocol carries the new evidence fields, bounded; a node without a command behaves as before", async t => {
  const o = await office(t, graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: "npm run typecheck" })); const r = o.run();
  const send = (evidence: unknown, clientId: string) => o.http("/api/agent/pipeline/report", { session: { harness: "manual", sessionId: "captain", cwd: o.root }, runId: r.id, clientId, expectedRevision: o.p.get(r.id).revision, nodeId: "typecheck", notes: "n", evidence: [evidence] });
  assert.equal((await send({ ...ran("npm run typecheck", 0, r.candidate.head), outputTail: "x".repeat(4001) }, "long")).status, 400);
  assert.equal((await send({ ...ran("npm run typecheck", 0, r.candidate.head), durationMs: -1 }, "negative")).status, 400);
  const ok = await send(ran("npm run typecheck", 0, r.candidate.head), "ok"); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const free = await office(t, graphOf({ id: "checks", label: "Checks", evidence: ["check"] })); const f = free.run();
  free.done(f, { kind: "check", summary: "free-form", command: "anything", exitCode: 0 });
  assert.equal(free.gate(f).allowed, true);
});

test("graphs validate the command and by fields, and an existing graph without them is unchanged", () => {
  const base = graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"] });
  const withNode = (patch: Record<string, unknown>) => ({ ...base, nodes: [{ ...base.nodes[0]!, ...patch }, base.nodes[1]!] });
  assert.equal(validateGraph(withNode({ command: " npm run typecheck " })).nodes[0]!.command, "npm run typecheck");
  assert.deepEqual(validateGraph(withNode({ command: ["a", "b"] })).nodes[0]!.command, ["a", "b"]);
  for (const bad of ["", "   ", "a\nb", "x".repeat(501), [], ["a", "a"], 5]) assert.throws(() => validateGraph(withNode({ command: bad })), { code: "pipeline_invalid" });
  assert.throws(() => validateGraph(withNode({ evidence: ["report"], command: "npm test" })), /needs check evidence/);
  assert.throws(() => validateGraph(withNode({ by: "lead" })), /"by"/);
  assert.throws(() => validateGraph({ ...base, nodes: [base.nodes[0]!, { ...base.nodes[1]!, by: "crew" }] }), /"by"/);
  assert.equal(validateGraph(withNode({ by: "crew" })).nodes[0]!.by, "crew");
  assert.ok(validateGraph(base).nodes.every(n => !("command" in n) && !("by" in n)), "no field appears on a node that did not set it");
  // FysikLab's own graph, read only, still loads and validates with neither field.
  const file = "/Users/jesper/projects/space-shuttle/orchestrator.json";
  if (!existsSync(file)) return;
  const graph = validateGraph(JSON.parse(readFileSync(file, "utf8")).pipeline);
  assert.equal(graph.id, "fysiklab-dev-v2"); assert.equal(graph.nodes.length, 15);
  assert.ok(graph.nodes.every(n => n.command === undefined && n.by === undefined));
});

test("crew-only steps refuse the first mate's own evidence; crew reports and the first mate endorses it", async t => {
  const o = await office(t, graphOf({ id: "build", label: "Build", evidence: ["report"], by: "crew" })); const r = o.run();
  const url = (what: string): PipelineEvidenceInput => ({ kind: "report", summary: what, url: "https://example.invalid/report" });
  const handTo = [/crew work/, /Hand it to a crew member/, new RegExp(`${INBOX_BIN.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} pipeline assign ${r.id} build AGENT`)];
  // Neither reporting nor completing on its own account, nor completing "for" the crew, is allowed.
  assert.throws(() => o.report(o.lead, r, url("I built it")), refusal("pipeline_crew_work", ...handTo));
  assert.throws(() => o.done(r, url("Crew built it, I attach the report")), refusal("pipeline_crew_work", ...handTo));
  assert.throws(() => o.done(r), refusal("pipeline_evidence_required"));
  assert.equal(o.step(r).evidence.length, 0);
  assert.match(o.p.brief("authors", "captain"), /build: ready .*crew work: the first mate does not build or repair it, so assign a crew member/);
  assert.match(o.gate(r).reasons.join("\n"), /build: ready; crew work/);
  // The crew member's report counts once the first mate endorses it.
  o.p.assign(o.lead, { runId: r.id, clientId: "assign", expectedRevision: o.p.get(r.id).revision, nodeId: "build", agentId: o.crew.id });
  o.report(o.crew, o.p.get(r.id), url("Built it"));
  assert.equal(o.step(r).state, "reported");
  o.done(o.p.get(r.id));
  assert.equal(o.step(r).state, "done"); assert.equal(o.step(r).completedBy, o.lead.id); assert.equal(o.step(r).evidence[0]!.byAgentId, o.crew.id);
  assert.equal(o.gate(r).allowed, true, o.gate(r).reasons.join("; "));
});

test("without by, the first mate may still record its own evidence, as before", async t => {
  const o = await office(t, graphOf({ id: "build", label: "Build", evidence: ["report"] })); const r = o.run();
  o.done(r, { kind: "report", summary: "I built it", url: "https://example.invalid/report" });
  assert.equal(o.gate(r).allowed, true);
});

test("the CLI runner runs the command in the checkout, bounds its output tail and records exit code and candidate", async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-runner-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "marker.txt"), "here");
  const pass = await runCommand("cat marker.txt && echo done", dir);
  assert.equal(pass.exitCode, 0); assert.match(pass.outputTail, /heredone/); assert.ok(pass.durationMs >= 0);
  const fail = await runCommand("echo boom >&2; exit 3", dir);
  assert.equal(fail.exitCode, 3); assert.match(fail.outputTail, /boom/);
  const loud = await runCommand("yes line | head -c 100000", dir);
  assert.ok(loud.outputTail.length <= 4000);
  const slow = await runCommand("sleep 5", dir, { timeoutMs: 100 });
  assert.notEqual(slow.exitCode, 0); assert.match(slow.outputTail, /stopped after/);
  const evidence = checkEvidence(fail, "a".repeat(40));
  assert.deepEqual([evidence.kind, evidence.command, evidence.exitCode, evidence.candidate], ["check", "echo boom >&2; exit 3", 3, "a".repeat(40)]);
  const graph = graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: ["a", "b"] });
  const fake = { id: "run1", state: "open", graph, steps: [{ nodeId: "typecheck", state: "ready" }] } as unknown as PipelineRun;
  assert.deepEqual(checkPlan(fake, "typecheck", "how"), ["a", "b"]);
  assert.throws(() => checkPlan(fake, undefined, "how"), /name the step/);
  assert.throws(() => checkPlan(fake, "deliver", "how"), /names no required command/);
  assert.throws(() => checkPlan({ ...fake, state: "abandoned" } as PipelineRun, "typecheck", "how"), /abandoned/);
});

test("inbox pipeline check runs the declared command in the candidate checkout and completes the step", async t => {
  const o = await office(t, graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: "cat src.ts && echo checked" })); const r = o.run();
  const saved = { url: process.env.INBOX_URL, log: console.log, err: console.error, write: process.stderr.write };
  process.env.INBOX_URL = `http://127.0.0.1:${o.port}`; console.log = () => {}; console.error = () => {}; process.stderr.write = (() => true) as typeof process.stderr.write;
  const session = { harness: "manual" as const, sessionId: "captain", cwd: o.root };
  try {
    await pipelineCommand(["check", r.id, "typecheck"], { complete: true, notes: "ran it" }, session);
  } finally { process.env.INBOX_URL = saved.url; console.log = saved.log; console.error = saved.err; process.stderr.write = saved.write; }
  const step = o.step(r);
  assert.equal(step.state, "done");
  const [e] = step.evidence;
  assert.deepEqual([e!.command, e!.exitCode, e!.candidate], ["cat src.ts && echo checked", 0, r.candidate.head]);
  assert.match(e!.outputTail!, /value = 2;[\s\S]*checked/); assert.ok(e!.durationMs! >= 0);
  assert.equal(o.gate(r).allowed, true, o.gate(r).reasons.join("; "));
});

test("inbox pipeline check records a failing run without completing, and exits with an error", async t => {
  const o = await office(t, graphOf({ id: "typecheck", label: "Typecheck", evidence: ["check"], command: "exit 4" })); const r = o.run();
  const saved = { url: process.env.INBOX_URL, log: console.log, err: console.error, write: process.stderr.write };
  process.env.INBOX_URL = `http://127.0.0.1:${o.port}`; console.log = () => {}; console.error = () => {}; process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await assert.rejects(pipelineCommand(["check", r.id, "typecheck"], { complete: true }, { harness: "manual", sessionId: "captain", cwd: o.root }), /check failed: `exit 4` exited 4.*pipeline check/);
  } finally { process.env.INBOX_URL = saved.url; console.log = saved.log; console.error = saved.err; process.stderr.write = saved.write; }
  assert.notEqual(o.step(r).state, "done"); assert.equal(o.step(r).evidence[0]!.exitCode, 4);
  assert.equal(o.gate(r).allowed, false);
});

test("the editor offers crew-only for new build steps and edits the required command as text", async () => {
  const { nodeFromDefinition, commandFromText, commandText, builtins } = await import("../src/ui/pipelines/model.ts");
  const work = builtins.find(d => d.id === "builtin:work")!;
  assert.equal(nodeFromDefinition(work, "n-build").by, "crew");
  assert.equal(nodeFromDefinition(builtins.find(d => d.id === "builtin:check")!, "n-check").by, undefined);
  assert.equal(commandFromText("  npm run typecheck \n"), "npm run typecheck");
  assert.deepEqual(commandFromText("npm run typecheck\nnpm run lint\nnpm run lint"), ["npm run typecheck", "npm run lint"]);
  assert.equal(commandFromText("  \n"), undefined);
  assert.equal(commandText({ command: ["a", "b"] }), "a\nb"); assert.equal(commandText({}), "");
});
