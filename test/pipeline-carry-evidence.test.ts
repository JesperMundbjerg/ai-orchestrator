import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { validateGraph } from "../src/server/pipelines/model.ts";
import type { PipelineGraph, PipelineNode, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Rebase first, extended (the founder's "Both"): when a re-base keeps the change identical, the reports of a step that
// judges only the diff (`carry: "same-patch"`) carry over like the founder's approval. What depends on the merged tree
// (checks bound to the candidate commit, builds, captures) never does.
const nodes: PipelineNode[] = [
  { id: "build", label: "Crew builds and tests", kind: "step", source: "builtin:work", evidence: ["report"] },
  { id: "review", label: "Code review of the diff", kind: "step", source: "builtin:work", evidence: ["report"], carry: "same-patch" },
  { id: "design", label: "Design review of the diff", kind: "step", source: "builtin:work", evidence: ["report"], carry: "same-patch" },
  { id: "checks", label: "Tests", kind: "step", source: "builtin:check", evidence: ["check"], command: "npm test" },
  { id: "dev", label: "Deliver to dev", kind: "delivery", delivery: "dev" },
];
const graph: PipelineGraph = { version: 1, id: "wave", label: "Reviewed delivery", entry: "build", fields: [], nodes,
  edges: [{ id: "a", from: "build", to: "review" }, { id: "b", from: "review", to: "design" }, { id: "c", from: "design", to: "checks" }, { id: "d", from: "checks", to: "dev" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.editor=true", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const lines = (edits: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";
const short = (sha: string) => sha.slice(0, 10);

function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-carry-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), lines()); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const origin = join(dir, "origin.git"); git(dir, "init", "--bare", "-q", origin); git(root, "remote", "add", "origin", origin); git(root, "push", "-q", "origin", "dev");
  const upstream = join(dir, "upstream"); git(dir, "clone", "-q", "-b", "dev", origin, upstream);
  git(root, "checkout", "-q", "-b", "wave");
  const edit = (cwd: string, edits: Record<number, string>, message: string) => { writeFileSync(join(cwd, "src.ts"), lines(edits)); git(cwd, "commit", "-qam", message); return git(cwd, "rev-parse", "HEAD"); };
  const advance = (edits: Record<number, string>) => { const sha = edit(upstream, edits, "upstream"); git(upstream, "push", "-q", "origin", "dev"); git(root, "fetch", "-q", "origin"); return sha; };
  const reports = join(dir, "reports"); mkdirSync(reports);

  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });

  let n = 0;
  const start = () => p.start(lead, { clientId: `start-${++n}`, base: "origin/dev" });
  const report = (run: PipelineRun, nodeId: string, complete = true) => {
    const file = join(reports, `${nodeId}-${++n}.md`); writeFileSync(file, `# ${nodeId}\nNo findings.\n`);
    const input = { runId: run.id, clientId: `${nodeId}-${n}`, expectedRevision: p.get(run.id).revision, nodeId, notes: `${nodeId} done`, evidence: [{ kind: "report" as const, summary: `${nodeId}: no findings`, path: file }] };
    return complete ? p.done(lead, input) : p.report(lead, input);
  };
  const check = (run: PipelineRun) => p.done(lead, { runId: run.id, clientId: `check-${++n}`, expectedRevision: p.get(run.id).revision, nodeId: "checks", notes: "passed",
    evidence: [{ kind: "check", summary: "passed", command: "npm test", exitCode: 0, candidate: p.get(run.id).candidate.head }] });
  const all = (run: PipelineRun) => check(report(report(report(run, "build"), "review"), "design"));
  const rebase = (run: PipelineRun) => p.branch(lead, { runId: run.id, clientId: `rebase-${++n}`, selections: {}, rationale: "rebased onto origin/dev", base: "origin/dev", candidate: "HEAD" });
  const step = (run: PipelineRun, id: string) => p.get(run.id).steps.find(s => s.nodeId === id)!;
  const gate = (run: PipelineRun) => p.gate(lead, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head });
  const events = (kind: string) => db.prepare("SELECT detail FROM events WHERE kind = ?").all(kind).map(r => JSON.parse(String(r.detail)));
  const telemetry = () => { p.telemetry.flush(); return events("pipeline.telemetry.integration"); };
  return { root, db, p, lead, git, edit, advance, start, report, check, all, rebase, step, gate, events, telemetry };
}

test("an identical patch carries the review reports over a re-base, marked with their round, while the build and checks are done again", t => {
  const o = office(t);
  const old = o.edit(o.root, { 2: "export const line2 = 'wave';", 3: "export const line3 = 'wave';" }, "wave");
  const run = o.all(o.start());
  assert.equal(o.gate(run).allowed, true);
  const reviewed = o.step(run, "review").evidence[0]!; const designed = o.step(run, "design").evidence[0]!;

  // Upstream changes the same file elsewhere: the merged bytes differ (a new round), the patch does not.
  const tip = o.advance({ 11: "export const line11 = 'upstream';" });
  o.git(o.root, "rebase", "-q", "origin/dev");
  const moved = o.rebase(run);
  assert.equal(moved.round, run.round + 1, "new intended bytes are a new round");

  for (const id of ["review", "design"]) {
    const s = o.step(moved, id);
    assert.equal(s.state, "done", `${id} judged the same change and is not asked again`);
    assert.equal(s.completedBy, o.lead.id);
    assert.equal(s.evidence.length, 1);
    assert.equal(s.evidence[0]!.round, moved.round);
    assert.deepEqual([s.evidence[0]!.carriedFrom?.round, s.evidence[0]!.carriedFrom?.head, s.evidence[0]!.carriedFrom?.base], [run.round, old, run.candidate.base], "names the round, commit and base it came from");
  }
  const copy = o.step(moved, "review").evidence[0]!;
  assert.notEqual(copy.id, reviewed.id, "a new record, not the old one rewritten");
  assert.equal(copy.carriedFrom?.evidenceId, reviewed.id);
  assert.equal(copy.summary, reviewed.summary);
  assert.equal(copy.fileUrl, `/api/pipeline/evidence/${copy.id}`);
  assert.equal(o.p.evidenceFile(copy.id), reviewed.storedPath, "the same hash-checked attachment under the copy's id");
  assert.equal(o.step(moved, "build").state, "stale", "a step that does not declare same-patch (the build) is done again");
  assert.equal(o.step(moved, "checks").state, "stale", "a check bound to the candidate commit is run again");

  const record = moved.rebases!.at(-1)!;
  assert.equal(record.evidence?.carried, true);
  assert.equal(record.evidence?.fromRound, run.round);
  assert.equal(record.evidence?.text, `reports carried over from round ${run.round} (${short(old)}): same change, rebased onto ${short(tip)} (Code review of the diff, Design review of the diff)`);
  assert.deepEqual(record.evidence?.steps.map(s => [s.nodeId, s.done, s.evidenceIds[0]!.from]), [["review", true, reviewed.id], ["design", true, designed.id]]);
  assert.match(o.p.brief("authors", o.lead.id, o.p.get(run.id)), /Reports carried over from round 1/);
  const [carried] = o.events("pipeline.evidence.carried");
  assert.deepEqual([carried.runId, carried.round, carried.fromRound, carried.from, carried.to, carried.base], [run.id, moved.round, run.round, old, moved.candidate.head, tip]);
  assert.equal(carried.patch.before, carried.patch.after);
  const [noted] = o.telemetry().map(e => e as { carried?: { evidence?: { carried: boolean; fromRound: number; steps: { nodeId: string; done: boolean }[] } } });
  assert.deepEqual(noted?.carried?.evidence, { carried: true, fromRound: run.round, steps: [{ nodeId: "review", records: 1, done: true }, { nodeId: "design", records: 1, done: true }] });

  // The build and checks are done again; the reviews are not.
  const again = o.check(o.report(moved, "build"));
  assert.equal(o.gate(again).allowed, true);
});

test("a re-base whose change differs carries no report: every review is asked again, and recorded so", t => {
  const o = office(t);
  const old = o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = o.all(o.start());
  o.advance({ 2: "export const line2 = 'upstream';" });
  assert.throws(() => o.git(o.root, "rebase", "-q", "origin/dev"), "the same line conflicts");
  writeFileSync(join(o.root, "src.ts"), lines({ 2: "export const line2 = 'wave and upstream';" }));
  o.git(o.root, "add", "src.ts"); o.git(o.root, "rebase", "--continue");

  const moved = o.rebase(run);
  for (const id of ["review", "design"]) assert.equal(o.step(moved, id).state, "stale");
  assert.ok(o.step(moved, "review").evidence.every(e => !e.carriedFrom));
  const record = moved.rebases!.at(-1)!;
  assert.equal(record.evidence?.carried, false);
  assert.equal(record.evidence?.text, `reports asked again: the change differs from what was reviewed at ${short(old)} (Code review of the diff, Design review of the diff)`);
  assert.equal(o.events("pipeline.evidence.carried").length, 0);
  assert.equal(o.events("pipeline.evidence.reasked").length, 1);
});

test("a report that was only reported carries as reported, for the first mate to endorse; an ordinary re-pin carries nothing", t => {
  const o = office(t);
  o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = o.report(o.report(o.start(), "build"), "review", false);
  assert.equal(o.step(run, "review").state, "reported");
  o.advance({ 11: "export const line11 = 'upstream';" });
  o.git(o.root, "rebase", "-q", "origin/dev");
  const moved = o.rebase(run);
  assert.equal(o.step(moved, "build").state, "stale");
  const review = o.step(moved, "review");
  assert.equal(review.completedBy, null, "a report the first mate had not endorsed is not completed by the carry");
  assert.ok(review.evidence.some(e => e.carriedFrom?.round === run.round && e.round === moved.round));
  assert.deepEqual(moved.rebases!.at(-1)!.evidence?.steps.map(s => [s.nodeId, s.done]), [["review", false]]);

  // A further commit re-pinned without a re-base: a new round, and nothing carries, as before.
  const repinned = o.p.branch(o.lead, { runId: run.id, clientId: "repin", expectedRevision: o.p.get(run.id).revision, selections: {}, rationale: "more", candidate: "HEAD" });
  o.edit(o.root, { 2: "export const line2 = 'wave';", 5: "export const line5 = 'more';" }, "more");
  const later = o.p.branch(o.lead, { runId: run.id, clientId: "repin-2", expectedRevision: repinned.revision, selections: {}, rationale: "more work", candidate: "HEAD" });
  assert.equal(later.round, moved.round + 1);
  assert.equal(o.step(later, "review").evidence.filter(e => e.round === later.round).length, 0);
  assert.equal(o.events("pipeline.evidence.carried").length, 1, "only the re-base carried");
});

test("only a reports-only step may declare same-patch: checks, artifacts, reviews and approvals are refused", () => {
  const withNode = (node: Record<string, unknown>) => validateGraph({ ...graph, nodes: graph.nodes.map(n => n.id === "review" ? { ...n, ...node } : n) });
  assert.equal(withNode({}).nodes.find(n => n.id === "review")?.carry, "same-patch", "kept through validation");
  for (const bad of [{ evidence: ["check"] }, { evidence: ["check"], command: "npm test" }, { evidence: ["report", "artifact"] }, { evidence: ["review"] }, { kind: "approval", evidence: ["approval"] }, { carry: "always" }])
    assert.throws(() => withNode(bad), /"carry" is "same-patch" and belongs to a step whose evidence is reports only/, JSON.stringify(bad));
});
