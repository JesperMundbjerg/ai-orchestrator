import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import type { PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph: PipelineGraph = { version: 1, id: "wave", label: "Bounded delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "dev", label: "Deliver to dev", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "checks", to: "dev" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A team working on a feature branch of a repository whose dev is published to a bare origin (or not, with `remote: false`). */
function office(t: TestContext, { remote = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-landing-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const origin = join(dir, "origin.git");
  if (remote) { git(dir, "init", "--bare", "-q", origin); git(root, "remote", "add", "origin", origin); git(root, "push", "-q", "origin", "dev"); }
  git(root, "checkout", "-q", "-b", "wave");
  const commit = (text: string) => { writeFileSync(join(root, "src.ts"), `export const value = ${JSON.stringify(text)};\n`); git(root, "commit", "-qam", text); return git(root, "rev-parse", "HEAD"); };
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const base = remote ? "origin/dev" : "dev";
  const start = () => p.start(lead, { clientId: `wave-${Math.random()}`, base });
  const done = (run: PipelineRun) => p.done(lead, { runId: run.id, clientId: `done-${Math.random()}`, expectedRevision: run.revision, nodeId: "checks", notes: "Verified", evidence: [{ kind: "check", summary: "passed", command: "npm test", exitCode: 0 }] });
  const gate = (run: PipelineRun) => p.gate(lead, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head, operation: "push", repo: root, ref: "refs/heads/dev" });
  const push = (sha: string) => git(root, "push", "-q", "origin", `${sha}:dev`);
  const step = (run: PipelineRun, id: string) => run.steps.find(s => s.nodeId === id)!;
  return { dir, root, origin, db, p, lead, state, commit, start, done, gate, push, step };
}

test("a dev run is delivered only once its exact candidate is on origin/dev, not when the gate allows", t => {
  const o = office(t);
  const head = o.commit("wave"); const run = o.done(o.start());
  assert.equal(o.gate(run).allowed, true);
  assert.equal(o.p.get(run.id).state, "open", "a gate allow is preflight, never a publication receipt");

  // Landed on the local dev but not pushed: in a repository with a remote only the published ref counts.
  git(o.root, "checkout", "-q", "dev"); git(o.root, "merge", "-q", "--ff-only", head);
  assert.equal(o.p.get(run.id).state, "open");

  o.push(head);
  // The checkout moves on with the next wave; the pinned evidence still describes the published commit.
  git(o.root, "checkout", "-q", "wave"); o.commit("next wave");
  const delivered = o.p.get(run.id);
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.landed?.ref, "refs/remotes/origin/dev");
  assert.equal(delivered.landed?.tip, head);
  assert.deepEqual(delivered.steps.map(s => s.state), ["done", "done"], "the dev step reads done, and the evidence is not stale");
  assert.equal(delivered.revision, run.revision + 1);
  const event = o.db.prepare("SELECT actor, detail FROM events WHERE kind = 'pipeline.landed'").all();
  assert.equal(event.length, 1); assert.equal(event[0]!.actor, "office");
  assert.equal(JSON.parse(String(event[0]!.detail)).candidate, head);

  // Delivered is terminal and persisted: no second delivery, edit or closure; later reads change nothing.
  assert.match(o.gate(delivered).reasons.join(), /already delivered/);
  assert.throws(() => o.p.abandon(o.lead, { runId: run.id, clientId: "late", notes: "too late" }), { status: 409 });
  assert.throws(() => o.done(delivered), { status: 409 });
  assert.equal(o.p.get(run.id).revision, delivered.revision);
  assert.equal(new Pipelines(o.db, () => o.state, { evidenceDir: join(o.dir, "copies") }).get(run.id).state, "delivered");
  assert.match(o.p.brief("authors", o.lead.id, o.p.get(run.id)), /delivered: on origin\/dev at /);
});

test("a refused push leaves the run open", t => {
  const o = office(t);
  const hook = join(o.origin, "hooks", "pre-receive"); writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  const head = o.commit("wave"); const run = o.done(o.start());
  assert.equal(o.gate(run).allowed, true);
  assert.throws(() => o.push(head));
  assert.equal(o.p.get(run.id).state, "open");
  assert.equal(o.step(o.p.get(run.id), "dev").state, "ready");
});

test("in a repository with no remote, the local dev branch is where delivery is published, unless the candidate's checkout works on it", t => {
  const o = office(t, { remote: false });
  const head = o.commit("wave"); const run = o.done(o.start());
  assert.equal(o.p.get(run.id).state, "open");
  // Committing on dev in the candidate's own checkout is its work in progress, not a delivery.
  git(o.root, "checkout", "-q", "dev"); git(o.root, "merge", "-q", "--ff-only", head);
  assert.equal(o.p.get(run.id).state, "open");
  git(o.root, "checkout", "-q", "wave");
  const delivered = o.p.get(run.id);
  assert.equal(delivered.state, "delivered"); assert.equal(delivered.landed?.ref, "refs/heads/dev");
});

test("a candidate that reached dev another way leaves an unfinished run open, saying so", t => {
  const o = office(t);
  const head = o.commit("wave"); const run = o.start();
  o.push(head); // a waiver, another run or a bypass; this run's checks were never done
  const open = o.p.get(run.id);
  assert.equal(open.state, "open");
  assert.match(o.step(open, "dev").problems?.join() ?? "", /already on origin\/dev, but this run's steps are not all done/);
  assert.equal(o.p.abandon(o.lead, { runId: run.id, clientId: "close", notes: "Landed through the founder's waiver" }).state, "abandoned");
  assert.equal(o.p.get(run.id).state, "abandoned", "an abandoned run stays abandoned");
});

test("only the run's current candidate counts: an earlier round, a pin before the work, or a dirty pin never closes it", t => {
  const o = office(t);
  // Pinned before any work: nothing past its base, though that commit is on dev.
  const early = o.done(o.p.start(o.lead, { clientId: "early", base: "origin/dev" }));
  assert.equal(o.p.get(early.id).state, "open"); assert.equal(o.step(o.p.get(early.id), "dev").problems, undefined);

  const first = o.commit("first"); const run = o.done(o.start());
  const second = o.commit("second");
  const repinned = o.p.branch(o.lead, { runId: run.id, clientId: "repin", expectedRevision: run.revision, selections: {}, rationale: "second round", candidate: second });
  assert.equal(repinned.round, 2);
  o.push(first);
  assert.equal(o.p.get(run.id).state, "open", "the earlier round's commit on dev is not this run's candidate");

  // A pin that included uncommitted bytes is not what its commit holds.
  const dirty = o.commit("third"); writeFileSync(join(o.root, "notes.md"), "not committed\n");
  const pinned = o.done(o.p.start(o.lead, { clientId: "dirty", base: "origin/dev" }));
  assert.equal(pinned.candidate.head, dirty);
  o.push(dirty);
  assert.equal(o.p.get(pinned.id).state, "open");
});

test("an archived run is kept as recorded even when its candidate lands", t => {
  const o = office(t);
  const head = o.commit("wave"); const run = o.done(o.start());
  o.p.archiveTeam("authors", { reason: "deleted", teamName: "Authors" });
  o.push(head);
  const kept = o.p.get(run.id);
  assert.equal(kept.state, "open"); assert.equal(kept.archived?.reason, "deleted"); assert.equal(kept.landed, undefined);
});
