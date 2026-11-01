import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as reservePort } from "node:net";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { Messages } from "../src/server/messages.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { patchIdentity } from "../src/server/pipelines/candidate.ts";
import type { World } from "../src/server/world.ts";
import type { PipelineGraph, PipelineRun } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Rebase first (the founder's decision): a dev candidate behind origin/dev is refused before it can land as a
// different commit; the lead re-bases and moves the run; checks run again; the founder's approval carries over
// only when the change is identical.
const graph: PipelineGraph = { version: 1, id: "wave", label: "Approved delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] },
    { id: "approve", label: "Founder approves", kind: "approval", source: "builtin:founder-approval", evidence: ["approval"] },
    { id: "dev", label: "Deliver to dev", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "checked", from: "checks", to: "approve" }, { id: "finish", from: "approve", to: "dev" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.editor=true", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const lines = (edits: Record<number, string> = {}) => Array.from({ length: 12 }, (_, i) => edits[i + 1] ?? `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";
const short = (sha: string) => sha.slice(0, 10);

/** A team on branch `wave` of a repository whose dev is published to a bare origin, which another clone also pushes to. */
async function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-rebase-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), lines()); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const origin = join(dir, "origin.git"); git(dir, "init", "--bare", "-q", origin); git(root, "remote", "add", "origin", origin); git(root, "push", "-q", "origin", "dev");
  const upstream = join(dir, "upstream"); git(dir, "clone", "-q", "-b", "dev", origin, upstream);
  git(root, "checkout", "-q", "-b", "wave");
  const edit = (cwd: string, edits: Record<number, string>, message: string) => { writeFileSync(join(cwd, "src.ts"), lines(edits)); git(cwd, "commit", "-qam", message); return git(cwd, "rev-parse", "HEAD"); };
  /** Someone else's work reaches origin/dev, and this checkout fetches it. */
  const advance = (edits: Record<number, string>) => { const sha = edit(upstream, edits, "upstream"); git(upstream, "push", "-q", "origin", "dev"); git(root, "fetch", "-q", "origin"); return sha; };

  const db = openDatabase(join(dir, "office.sqlite"));
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies") });
  const m = new Messages(db, null, () => state, () => new Date(), () => {}); m.pipelines = p;
  const inbox = new Inbox(db, join(dir, "inbox-files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = { pipelines: p, messages: m, state: () => state, onChange: () => {}, react: async () => {}, resolve: (s: { sessionId?: string }) => state.agents.find(a => a.id === s.sessionId)! } as unknown as World;
  const probe = reservePort(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.notEqual(port, 4870);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world }); server.listen(port, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  // A fresh connection per request: git work between requests can outlast the server's keep-alive under load,
  // and a reused socket the server already closed would fail the request (ECONNRESET), not the behavior under test.
  const request = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = method !== "GET" ? JSON.stringify(body ?? {}) : undefined;
    const req = httpRequest({ host: "127.0.0.1", port, path, method, agent: false, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); } catch (err) { reject(err); } });
    });
    req.on("error", reject); req.end(payload);
  });

  let n = 0;
  const start = () => p.start(lead, { clientId: `start-${++n}`, base: "origin/dev" });
  const check = (run: PipelineRun) => p.done(lead, { runId: run.id, clientId: `check-${++n}`, expectedRevision: p.get(run.id).revision, nodeId: "checks", notes: "Verified", evidence: [{ kind: "check", summary: "passed", command: "npm test", exitCode: 0 }] });
  /** The founder is shown the run's current candidate and accepts it; the lead records the acceptance. */
  const approve = async (run: PipelineRun) => {
    const presented = await request("POST", "/api/agent/items", { session: { harness: "manual", sessionId: lead.id, cwd: root }, pipeline: { runId: run.id }, item: { type: "milestone", fixed: "Fixed.", key: `present-${++n}`, title: "Wave ready", context: "Pinned candidate" } });
    assert.equal(presented.status, 200, JSON.stringify(presented.body));
    const item = { itemId: presented.body.itemId as string, revision: presented.body.revision as number };
    assert.equal((await request("POST", `/api/items/${item.itemId}/replies`, { revision: item.revision, action: "accept", text: "" })).status, 200);
    return p.done(lead, { runId: run.id, clientId: `approve-${++n}`, expectedRevision: p.get(run.id).revision, nodeId: "approve", notes: "Founder accepted", evidence: [{ kind: "approval", summary: "Explicit acceptance", approval: item }] });
  };
  /** What FysikLab's land/publish hook asks before it updates dev. */
  const gate = (run: PipelineRun, operation: "land" | "push" = "land") => p.gate(lead, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head, operation, repo: root, ref: "refs/heads/dev" });
  const rebase = (run: PipelineRun) => p.branch(lead, { runId: run.id, clientId: `rebase-${++n}`, selections: {}, rationale: "rebased onto origin/dev", base: "origin/dev", candidate: "HEAD" });
  const step = (run: PipelineRun, id: string) => p.get(run.id).steps.find(s => s.nodeId === id)!;
  const events = (kind: string) => db.prepare("SELECT detail FROM events WHERE kind = ?").all(kind).map(r => JSON.parse(String(r.detail)));
  const codes = () => { p.telemetry.flush(); return db.prepare("SELECT detail FROM events WHERE kind = 'pipeline.telemetry.gate' ORDER BY id").all().map(r => JSON.parse(String(r.detail)).reasons.map((c: { code: string }) => c.code)); };
  return { dir, root, origin, upstream, db, p, lead, state, git, edit, advance, start, check, approve, gate, rebase, step, events, codes };
}

test("a candidate behind origin/dev is refused before it lands, telling the lead to rebase and move the run", async t => {
  const o = await office(t);
  o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = await o.approve(o.check(o.start()));
  assert.equal(o.gate(run).allowed, true, "on top of origin/dev it may land");

  const tip = o.advance({ 11: "export const line11 = 'upstream';" });
  const refused = o.gate(run);
  assert.equal(refused.allowed, false);
  const text = refused.reasons.join("\n");
  assert.match(text, new RegExp(`candidate ${short(run.candidate.head)} is behind origin/dev \\(now at ${short(tip)}\\)`));
  assert.match(text, /git fetch origin dev && git rebase origin\/dev/);
  assert.match(text, new RegExp(`pipeline branch ${run.id} --base origin/dev --candidate HEAD --notes "rebased onto origin/dev"`));
  assert.match(text, /re-run its checks/);
  assert.deepEqual(o.codes().at(-1), ["candidate_behind"], "the refusal is counted under its own code, and nothing else is wrong with the run");
  assert.equal(o.gate(run, "push").allowed, false, "a push of the old candidate is refused the same way");
  assert.equal(o.p.gate(o.lead, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head }).allowed, true, "a readiness preflight names no Git delivery, so it is not refused for this");
});

test("a re-base with the identical change carries the founder's approval over, recorded, while the checks run again", async t => {
  const o = await office(t);
  // Two commits: the change is judged whole, however it is split.
  o.edit(o.root, { 2: "export const line2 = 'wave';" }, "first half");
  const old = o.edit(o.root, { 2: "export const line2 = 'wave';", 3: "export const line3 = 'wave';" }, "second half");
  const run = await o.approve(o.check(o.start()));
  // Upstream changes the same file elsewhere, so the intended bytes differ and the round moves on.
  const tip = o.advance({ 11: "export const line11 = 'upstream';" });
  o.git(o.root, "rebase", "-q", "origin/dev");

  const moved = o.rebase(run);
  assert.notEqual(moved.candidate.head, old);
  assert.equal(moved.candidate.base, tip);
  assert.equal(moved.round, run.round + 1, "new intended bytes are a new round");
  assert.equal(o.step(moved, "checks").state, "stale", "the checks ran on the old candidate and must run again");
  const approval = o.step(moved, "approve");
  assert.equal(approval.state, "done", "the founder is not asked again for the same change");
  assert.equal(approval.evidence.length, 1);
  assert.equal(approval.evidence[0]!.summary, `approval carried over from ${short(old)}: same change, rebased onto ${short(tip)} (Explicit acceptance)`);
  assert.equal(approval.evidence[0]!.round, moved.round);

  // Visible in the run's history and the office's record.
  const record = moved.rebases?.at(-1) as { approval?: { carried: boolean; text: string } };
  assert.deepEqual([record.approval?.carried, record.approval?.text], [true, `approval carried over from ${short(old)}: same change, rebased onto ${short(tip)}`]);
  assert.match(o.p.brief("authors", o.lead.id, o.p.get(run.id)), new RegExp(`Approval carried over from ${short(old)}: same change, rebased onto ${short(tip)}\\.`));
  const [carried] = o.events("pipeline.approval.carried");
  assert.deepEqual([carried.runId, carried.from, carried.to, carried.base], [run.id, old, moved.candidate.head, tip]);
  assert.equal(carried.patch.before, carried.patch.after);

  const waiting = o.gate(moved);
  assert.equal(waiting.allowed, false);
  assert.deepEqual(o.codes().at(-1), ["step_stale"], "only the checks hold it back: not the approval, and not the base");

  const checked = o.check(moved);
  assert.equal(o.gate(checked).allowed, true);
  o.git(o.root, "push", "-q", "origin", `${checked.candidate.head}:dev`);
  const delivered = o.p.get(run.id);
  assert.equal(delivered.state, "delivered", "the exact rebased candidate on origin/dev delivers the run");
  assert.equal(delivered.landed?.tip, checked.candidate.head);
});

test("a re-base whose change differs (a conflict resolved by an edit) asks the founder again", async t => {
  const o = await office(t);
  const old = o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = await o.approve(o.check(o.start()));
  o.advance({ 2: "export const line2 = 'upstream';" });
  assert.throws(() => o.git(o.root, "rebase", "-q", "origin/dev"), "the same line conflicts");
  writeFileSync(join(o.root, "src.ts"), lines({ 2: "export const line2 = 'wave and upstream';" }));
  o.git(o.root, "add", "src.ts"); o.git(o.root, "rebase", "--continue");

  const moved = o.rebase(run);
  const approval = o.step(moved, "approve");
  assert.notEqual(approval.state, "done");
  assert.match(approval.problems?.join() ?? "", /recorded for an earlier round, selection scope or intended bytes/);
  const record = moved.rebases?.at(-1) as { approval?: { carried: boolean; text: string } };
  assert.equal(record.approval?.carried, false);
  assert.equal(record.approval?.text, `approval asked again: the change differs from what the founder accepted at ${short(old)}; present the rebased candidate ${short(moved.candidate.head)}`);
  assert.equal(o.events("pipeline.approval.carried").length, 0);
  assert.equal(o.events("pipeline.approval.reasked").length, 1);
  assert.equal(o.gate(o.check(moved)).allowed, false, "checked again, it still needs the founder");

  const approved = await o.approve(moved);
  assert.equal(o.gate(approved).allowed, true, "accepted again for the new change, it may land");
});

test("a candidate already on top of origin/dev is unaffected: no refusal and no carry-over on an ordinary re-pin", async t => {
  const o = await office(t);
  o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = await o.approve(o.check(o.start()));
  assert.equal(o.gate(run).allowed, true);
  assert.equal(o.gate(run, "push").allowed, true);

  // A further commit, re-pinned as before: a new round, and the approval goes stale as it always did.
  o.edit(o.root, { 2: "export const line2 = 'wave';", 5: "export const line5 = 'more';" }, "more");
  const repinned = o.p.branch(o.lead, { runId: run.id, clientId: "repin", expectedRevision: o.p.get(run.id).revision, selections: {}, rationale: "more work", candidate: "HEAD" });
  assert.equal(repinned.round, run.round + 1);
  assert.notEqual(o.step(repinned, "approve").state, "done");
  assert.equal(repinned.rebases, undefined);
  assert.equal(o.events("pipeline.approval.carried").length + o.events("pipeline.approval.reasked").length, 0);
});

test("a cherry-picked copy on origin/dev never delivers the run: only the exact candidate does", async t => {
  const o = await office(t);
  const head = o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = await o.approve(o.check(o.start()));
  o.advance({ 11: "export const line11 = 'upstream';" });
  // What a land step that cherry-picks does: the same change as a new commit on dev.
  o.git(o.upstream, "pull", "-q", "--ff-only", "origin", "dev"); o.git(o.upstream, "fetch", "-q", o.root, "wave"); o.git(o.upstream, "cherry-pick", head); o.git(o.upstream, "push", "-q", "origin", "dev"); o.git(o.root, "fetch", "-q", "origin");
  const open = o.p.get(run.id);
  assert.equal(open.state, "open"); assert.equal(open.landed, undefined);
  assert.equal(o.gate(open).allowed, false);
  assert.deepEqual(o.codes().at(-1), ["candidate_behind"]);
});

test("in a repository with no remote, a behind candidate is told to re-pin without a published base", async t => {
  const o = await office(t);
  o.git(o.root, "remote", "remove", "origin");
  o.edit(o.root, { 2: "export const line2 = 'wave';" }, "wave");
  const run = o.check(o.p.start(o.lead, { clientId: "local", base: "dev" }));
  o.git(o.root, "checkout", "-q", "dev"); o.edit(o.root, { 11: "export const line11 = 'local';" }, "local dev"); o.git(o.root, "checkout", "-q", "wave");
  const text = o.gate(run).reasons.join("\n");
  assert.match(text, /is behind dev/);
  assert.match(text, new RegExp(`pipeline branch ${run.id} --candidate HEAD --notes "rebased onto dev"`));
});

test("a change's identity ignores how it is split into commits and where it sits, but not whitespace or modes", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-patch-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); mkdirSync(repo); git(repo, "init", "-q", "-b", "dev");
  const write = (body: string, message: string) => { writeFileSync(join(repo, "src.ts"), body); git(repo, "add", "."); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); };
  const base = write(lines(), "base");
  write(lines({ 2: "a" }), "one"); const split = write(lines({ 2: "a", 3: "b" }), "two");
  git(repo, "checkout", "-q", "-b", "whole", base); const whole = write(lines({ 2: "a", 3: "b" }), "whole");
  git(repo, "checkout", "-q", "-b", "moved", base); const moved = write(lines({ 11: "c" }), "upstream"); const onMoved = write(lines({ 2: "a", 3: "b", 11: "c" }), "rebased");
  git(repo, "checkout", "-q", "-b", "spaced", base); const spaced = write(lines({ 2: "a ", 3: "b" }), "spaced");
  git(repo, "checkout", "-q", "-b", "mode", base); write(lines({ 2: "a", 3: "b" }), "content"); chmodSync(join(repo, "src.ts"), 0o755); git(repo, "add", "."); git(repo, "commit", "-qm", "mode"); const mode = git(repo, "rev-parse", "HEAD");

  const id = patchIdentity(repo, base, split);
  assert.ok(id);
  assert.equal(patchIdentity(repo, base, whole), id, "two commits or one, the same change");
  assert.equal(patchIdentity(repo, moved, onMoved), id, "re-based onto another base, the same change");
  assert.notEqual(patchIdentity(repo, base, spaced), id, "a whitespace edit is a different change");
  assert.notEqual(patchIdentity(repo, base, mode), id, "a mode change is a different change");
  assert.equal(patchIdentity(repo, base, base), null, "no change is nothing to carry");
  assert.equal(patchIdentity(repo, base, "no-such-ref"), null, "what Git cannot read is never the same");
});
