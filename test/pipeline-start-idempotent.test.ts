import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineGraph } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Under load, retried starts (each a new clientId) made 8 runs for one candidate in 3.5 minutes. A start for the same
// team, checkout, base, candidate and work round as an open, unarchived run returns that run instead.
const graph: PipelineGraph = { version: 1, id: "wave", label: "Delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "dev", label: "Deliver to dev", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "checks", to: "dev" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-start-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "a.txt"), "a\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base"); git(root, "checkout", "-q", "-b", "wave");
  const commit = (text: string) => { writeFileSync(join(root, "a.txt"), text); git(root, "commit", "-qam", text); return git(root, "rev-parse", "HEAD"); };
  const db = openDatabase(join(dir, "office.sqlite"));
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: p, state: () => state, onChange: () => {}, react: async () => {}, resolve: (s: { sessionId?: string }) => state.agents.find(a => a.id === s.sessionId)! } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const post = (path: string, body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch (err) { reject(err); } });
    });
    req.on("error", reject); req.end(payload);
  });
  const session = { harness: "manual", sessionId: lead.id, cwd: root };
  const runs = () => db.prepare("SELECT id FROM pipeline_runs").all().map(r => String(r.id));
  return { root, db, p, lead, commit, post, session, runs };
}

test("a retried start for the same checkout, base and candidate returns the open run, saying it was already started", async t => {
  const o = await office(t);
  o.commit("wave\n");
  const first = o.p.start(o.lead, { clientId: "start-1", base: "dev" });
  assert.equal(first.note, undefined, "a new run carries no note");
  const again = o.p.start(o.lead, { clientId: "start-2", base: "dev" });
  assert.equal(again.id, first.id);
  assert.match(again.note ?? "", new RegExp(`^already started: run ${first.id} is open`));
  assert.deepEqual(o.runs(), [first.id], "one run, not two");
  assert.equal((o.p.get(first.id) as { note?: string }).note, undefined, "the note is the answer's, never stored on the run");
  // The same clientId still replays its own receipt.
  assert.equal(o.p.start(o.lead, { clientId: "start-2", base: "dev" }).id, first.id);
});

test("concurrent retries over HTTP make one run between them, each answered 200 with that run", async t => {
  const o = await office(t);
  o.commit("wave\n");
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => o.post("/api/agent/pipeline/start", { session: o.session, clientId: `retry-${i}`, base: "dev" })));
  assert.deepEqual(answers.map(a => a.status), [200, 200, 200, 200, 200, 200], JSON.stringify(answers.map(a => a.body)));
  const ids = new Set(answers.map(a => a.body.id));
  assert.equal(ids.size, 1, "every retry got the same run");
  assert.deepEqual(o.runs(), [...ids]);
  assert.equal(answers.filter(a => /^already started/.test(a.body.note ?? "")).length, 5, "all but the first say so");
});

test("another candidate, another base, or a closed run starts a new run as before", async t => {
  const o = await office(t);
  const base = git(o.root, "rev-parse", "dev");
  o.commit("wave\n");
  const first = o.p.start(o.lead, { clientId: "s1", base: "dev" });
  const onHead = o.p.start(o.lead, { clientId: "s2", base: "HEAD" });
  assert.notEqual(onHead.id, first.id, "another base is another run");
  o.commit("more\n");
  const later = o.p.start(o.lead, { clientId: "s3", base });
  assert.notEqual(later.id, first.id, "another candidate commit is another run");
  assert.equal(later.note, undefined);
  o.p.abandon(o.lead, { runId: later.id, clientId: "drop", notes: "duplicate" });
  const restarted = o.p.start(o.lead, { clientId: "s4", base });
  assert.notEqual(restarted.id, later.id, "an abandoned run is never handed back");
  // Uncommitted intended bytes on the same commit are another candidate too.
  writeFileSync(join(o.root, "a.txt"), "more, edited\n");
  const dirty = o.p.start(o.lead, { clientId: "s5", base });
  assert.notEqual(dirty.id, restarted.id, "other intended bytes are another run");
  assert.equal(o.runs().length, 5);
});
