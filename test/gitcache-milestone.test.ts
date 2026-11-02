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
import { configureGit, defaultRunner, isGitPending, resetGitCache, type GitRunner } from "../src/server/gitcache.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// A decision the office answers with 503 git_pending must converge once git has been read: an agent that
// retries is answered. A milestone bound to a run (`inbox milestone --run`) once never was: its binding
// decided under a key holding the item id the submit had just made, which is new on every try.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const graph: PipelineGraph = { version: 1, id: "wave", label: "Wave", entry: "work", fields: [],
  nodes: [{ id: "work", label: "Work", kind: "step", source: "builtin:work", evidence: ["report"] }, { id: "deliver", label: "Deliver", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "work", to: "deliver" }] } as PipelineGraph;

/** git that waits `slow.ms` before running for real, off the event loop; `hang` makes chosen reads never answer. */
function slowGit(t: TestContext, options: { pendingLimitMs?: number } = {}) {
  const slow = { ms: 150, hang: (_args: string[]) => false };
  const runner: GitRunner = (call) => new Promise((resolve, reject) => {
    if (slow.hang(call.args)) return;
    setTimeout(() => {
      defaultRunner(call).then(resolve, reject);
    }, slow.ms);
  });
  configureGit({ nonblocking: true, runner, waitMs: 150, ...options });
  t.after(() => { configureGit({ nonblocking: false, runner: null, waitMs: 150, changed: null, pendingLimitMs: 60_000 }); resetGitCache(); });
  return slow;
}

async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "office-gitcache-milestone-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "authors"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "authors", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "branch", "baseline");
  writeFileSync(join(root, "src.ts"), "export const value = 2;\n"); git(root, "commit", "-qam", "wave");
  const db = openDatabase(join(dir, "office.sqlite"));
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false } as unknown as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const run = p.start(lead, { clientId: "start", base: "baseline" });
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: p, state: () => ({ ...state, brief: p.brief("authors") }), onChange: () => {}, react: async () => {}, resolve: () => lead } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  const http = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { root, db, p, lead, run, http, session: { harness: "manual", sessionId: "captain", cwd: root } };
}

test("a milestone bound to a run is answered once git is read: retrying converges instead of git_pending forever", async (t) => {
  const o = await office(t);
  slowGit(t);
  const milestone = { session: o.session, pipeline: { runId: o.run.id }, item: { type: "milestone", key: "wave-ready", title: "Wave ready", context: "The pinned candidate.", fixed: "The wave." } };
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const end = Date.now() + 15_000;
  for (;;) {
    const r = await o.http("/api/agent/items", milestone); answers.push(r);
    if (r.status !== 503 || Date.now() > end) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const r of answers.slice(0, -1)) assert.equal(r.body.code, "git_pending", "only retryable refusals before the answer");
  const last = answers.at(-1)!;
  assert.equal(last.status, 200, `answered after ${answers.length} tries, not git_pending for good: ${JSON.stringify(last.body)}`);
  assert.ok(answers.length <= 30, `converged within a bounded number of tries (took ${answers.length})`);
  const bound = o.db.prepare("SELECT run_id, fingerprint FROM pipeline_item_bindings WHERE item_id = ?").get(String(last.body.itemId)) as { run_id: string; fingerprint: string } | undefined;
  assert.equal(bound?.run_id, o.run.id, "the item is bound to the run");
  assert.equal(bound?.fingerprint, o.run.candidate.fingerprint, "with the run's exact candidate");
  assert.equal((o.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 1, "the refused tries kept no item");
});

test("a decision refused with git_pending for longer than the bound reads git synchronously instead of refusing forever", async (t) => {
  const o = await office(t);
  // A read that never comes back (a git wedged on a lock, say): the background never finds the fact.
  const slow = slowGit(t, { pendingLimitMs: 400 });
  slow.hang = (args) => args.includes("ls-files");
  const presentation = () => o.p.presentation(o.lead, o.run.id);
  let first: unknown;
  try { presentation(); } catch (err) { first = err; }
  assert.ok(isGitPending(first), "first refused retryably, as before");
  let answer: string | undefined;
  const started = Date.now();
  while (answer === undefined) {
    try { answer = presentation(); } catch (err) { assert.ok(isGitPending(err), String(err)); }
    assert.ok(Date.now() - started < 5_000, "answered within a bounded time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(Date.now() - started >= 300, "only after the bound: the office does not give up on reading off the loop at once");
  assert.match(answer, new RegExp(`candidate ${o.run.candidate.head}`), "answered from git read now, with the run's candidate");

  // A real Git failure in the synchronous read is a real refusal, not a git_pending.
  writeFileSync(join(o.root, "src.ts"), "export const value = 3;\n");
  let stale: unknown;
  const again = Date.now();
  for (;;) {
    try { presentation(); } catch (err) { stale = err; }
    if (!isGitPending(stale) || Date.now() - again > 5_000) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(!isGitPending(stale), "the safety net answers a changed checkout too");
  assert.match(String((stale as Error).message), /stale or closed candidate/, "read now, the edited checkout is refused");
});
