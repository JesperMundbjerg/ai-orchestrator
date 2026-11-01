import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { Unlanded } from "../src/server/unlanded.ts";
import { checkoutOf, landingRef } from "../src/server/worktrees.ts";
import { configureGit, isGitPending, resetGitCache, type GitRunner } from "../src/server/gitcache.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// The office never waits on a git process: in the non-blocking office (main.ts) every git read of a request or
// a watch is asynchronous, and a git that takes seconds (a loaded machine) delays answers, never the event loop.
// git is made slow here by an injected runner that waits before running the real git asynchronously.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const graph: PipelineGraph = { version: 1, id: "wave", label: "Wave", entry: "work", fields: [],
  nodes: [{ id: "work", label: "Work", kind: "step", source: "builtin:work", evidence: ["report"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "work", to: "deliver" }] } as PipelineGraph;

/** A git that takes `slow.ms` to start, then runs for real, off the event loop. Counts what it ran. */
function slowGit(t: TestContext) {
  const slow = { ms: 2000, runs: 0 };
  const runner: GitRunner = (call) => new Promise((resolve, reject) => {
    setTimeout(() => {
      slow.runs++;
      const child = execFile("git", call.args, { cwd: call.cwd, encoding: "utf8", maxBuffer: call.maxBuffer ?? 16 * 1024 * 1024 }, (err, stdout) => err ? reject(Object.assign(err, { stdout })) : resolve(String(stdout)));
      child.stdin?.end(call.input ?? "");
    }, slow.ms);
  });
  configureGit({ nonblocking: true, runner, waitMs: 150 });
  t.after(() => { configureGit({ nonblocking: false, runner: null, waitMs: 150, changed: null }); resetGitCache(); });
  return slow;
}

/** How long the event loop was held at most while `fn` ran. */
async function loopHeld<T>(fn: () => Promise<T>): Promise<{ value: T; maxMs: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
  try { const value = await fn(); return { value, maxMs: h.max / 1e6 }; } finally { h.disable(); }
}
const until = async (check: () => boolean | Promise<boolean>, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 200)); }
};

/** A protected team with one run whose only step is done: its gate allows on a clean checkout. Built with git blocking, as before. */
async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-gitcache-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "authors"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "authors", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "branch", "baseline");
  writeFileSync(join(root, "src.ts"), "export const value = 2;\n"); git(root, "commit", "-qam", "wave");
  const report = join(dir, "report.md"); writeFileSync(report, "# Done\n");
  const db = openDatabase(join(dir, "office.sqlite"));
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false } as unknown as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const run = p.start(lead, { clientId: "start", base: "baseline" });
  p.done(lead, { runId: run.id, clientId: "done", expectedRevision: p.get(run.id).revision, nodeId: "work", notes: "Done", evidence: [{ kind: "report", summary: "done", path: report }] });
  const gateInput = { runId: run.id, delivery: "dev" as const, round: run.round, candidate: run.candidate.head };
  assert.equal(p.gate(lead, gateInput).allowed, true, "with git blocking, as before, the gate allows");
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  // The office's world also shows the team's pipeline briefing, as world.state() does.
  const world = { pipelines: p, state: () => ({ ...state, brief: p.brief("authors") }), onChange: () => {}, react: async () => {}, resolve: () => lead } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown>, ms: Date.now() - started };
  };
  const session = { harness: "manual", sessionId: "captain", cwd: root };
  return { root, dir, db, p, lead, run, gateInput, http, session };
}

test("while git is slow, office requests answer at once and the event loop is never held", async (t) => {
  const o = await office(t);
  const slow = slowGit(t);
  const { value: [status, gate, world], maxMs } = await loopHeld(async () => [
    await o.http("POST", "/api/agent/pipeline/status", { session: o.session, runId: o.run.id }),
    await o.http("POST", "/api/agent/pipeline/gate", { session: o.session, ...o.gateInput }),
    await o.http("GET", "/api/world"),
  ]);
  for (const r of [status, gate, world]) assert.ok(r.ms < 1000, `answered in ${r.ms} ms, not after git's 2 s`);
  assert.ok(maxMs < 1000, `the event loop was held at most ${Math.round(maxMs)} ms`);
  assert.equal(slow.runs, 0, "no git had run yet: none of the answers waited for one");
  assert.equal(status.status, 200, "status answers with what it knows");
  assert.match(String(status.body.text), /still being read/, "and says that some of it is still being read");
  assert.equal(gate.status, 503, "the gate cannot vouch for the checkout yet");
  assert.equal(gate.body.code, "git_pending", "so it refuses retryably");
  assert.notEqual(gate.body.allowed, true);
  assert.equal(world.status, 200);
});

test("the gate allows only on git facts read since it was asked: retryable refusals until then, and a stale read never allows", async (t) => {
  const o = await office(t);
  const slow = slowGit(t);
  slow.ms = 150;
  // Asked again and again, as an agent retries: refused retryably until the checkout is read, then answered.
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  await until(async () => { const r = await o.http("POST", "/api/agent/pipeline/gate", { session: o.session, ...o.gateInput }); answers.push(r); return r.status !== 503; });
  assert.ok(answers.length > 1, "a slow git is first answered with a retryable refusal");
  for (const r of answers.slice(0, -1)) { assert.equal(r.body.code, "git_pending"); assert.notEqual(r.body.allowed, true); }
  assert.equal(answers.at(-1)!.status, 200);
  assert.equal(answers.at(-1)!.body.allowed, true, "read since it was asked, the clean candidate is allowed");

  // The checkout changes: a file the candidate never touched. What was read before says "clean"; the gate does not use it.
  writeFileSync(join(o.root, "unrelated.ts"), "export const dirt = true;\n");
  let pending: unknown;
  try { o.p.gate(o.lead, o.gateInput); } catch (err) { pending = err; }
  assert.ok(isGitPending(pending), "a new question reads the checkout again instead of trusting the last read");
  await (pending as { settled: Promise<void> }).settled;
  const after = o.p.gate(o.lead, o.gateInput);
  assert.equal(after.allowed, false, "read again, the dirty checkout is refused");
  assert.ok(after.reasons.some((r) => /stale candidate/.test(r)), after.reasons.join("; "));
});

test("the unlanded watch never waits on git: a tick returns at once, and the sample arrives later", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-gitcache-unlanded-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "a.txt"), "a\n"); git(root, "add", "."); git(root, "commit", "-qm", "base");
  const lane = join(dir, "repo-lane"); git(root, "worktree", "add", "-q", "-b", "lane", lane);
  writeFileSync(join(lane, "b.txt"), "b\n");
  const checkout = checkoutOf(lane)!;
  assert.ok(checkout.linked);
  const db = openDatabase(join(dir, "office.sqlite"));
  t.after(() => db.close());
  const crew = { id: "crew", name: "Crew", teamId: "t1", role: "member", paneId: "p1", cwd: lane, status: "idle", waitingOnYou: false } as unknown as WorldAgent;
  const state = { agents: [crew], teams: [{ id: "t1", name: "Atoms" }], unlanded: [] } as unknown as WorldState;
  const told: string[] = [];
  const watch = new Unlanded(db, {
    state: () => state, checkout: () => checkout, landing: (c) => landingRef(c.repoRoot, "dev"), merge: () => null, runs: () => [],
    switching: () => new Set<string>(), tell: (_id, text) => { told.push(text); }, tellFounder: () => {},
  });
  const slow = slowGit(t);
  const T0 = Date.now();
  const { value: first, maxMs } = await loopHeld(async () => { const started = Date.now(); watch.tick(state, T0); watch.tick(state, T0 + 6 * 60_000); return Date.now() - started; });
  assert.ok(first < 500, `two ticks took ${first} ms, not git's seconds`);
  assert.ok(maxMs < 1000, `the event loop was held at most ${Math.round(maxMs)} ms`);
  assert.deepEqual(watch.list(), [], "nothing is known yet, so nothing is listed or said");
  assert.deepEqual(told, []);
  slow.ms = 50;
  // Once git has answered (in the background), the next tick lists the work.
  await until(() => { watch.tick(state, T0 + 7 * 60_000); return watch.list().length > 0; }, 60_000);
  assert.equal(watch.list()[0]!.uncommitted, 1);
});

test("an edit that waits for git keeps nothing from its background reruns: one run, one copied file, one answer", async (t) => {
  const o = await office(t);
  const slow = slowGit(t);
  slow.ms = 100;
  const retried = async (path: string, body: unknown) => {
    for (let i = 0; i < 200; i++) {
      const r = await o.http("POST", path, { session: o.session, ...body as object });
      if (r.status !== 503) return r;
      assert.equal(r.body.code, "git_pending");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("never answered");
  };
  const started = await retried("/api/agent/pipeline/start", { clientId: "second", base: "baseline" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const runs = () => Number(o.db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs").get()!.n);
  assert.equal(runs(), 2, "the setup's run and this one: no rerun started another");
  const id = String(started.body.id);
  const report = join(o.dir, "second.md"); writeFileSync(report, "# Second\n");
  const done = await retried("/api/agent/pipeline/done", { runId: id, clientId: "second-done", expectedRevision: o.p.get(id).revision, nodeId: "work", notes: "Done", evidence: [{ kind: "report", summary: "done", path: report }] });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(readdirSync(join(o.dir, "copies")).length, 2, "one copied file per completed step, none left by a rerun");
  assert.equal(o.p.get(id).steps.find((s) => s.nodeId === "work")!.evidence.length, 1);
  assert.equal(Number(o.db.prepare("SELECT COUNT(*) AS n FROM pipeline_requests WHERE client_id IN ('second', 'second-done')").get()!.n), 2);
});
