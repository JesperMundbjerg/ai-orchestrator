import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Pipelines } from "../src/server/pipelines/store.ts";
import { telemetryQuery, telemetryReportSchema } from "../src/server/pipelines/protocol.ts";
import { PipelineTelemetry } from "../src/server/pipelines/telemetry.ts";
import type { PipelineGraph, PipelineRun, PipelineTelemetryEvent } from "../src/shared/pipeline.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

const graph: PipelineGraph = { version: 1, id: "wave", label: "Bounded delivery", entry: "checks", fields: [],
  nodes: [{ id: "checks", label: "Verify candidate", kind: "step", source: "builtin:check", evidence: ["check"] }, { id: "dev", label: "Deliver to dev", kind: "delivery", delivery: "dev" }],
  edges: [{ id: "finish", from: "checks", to: "dev" }] };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A team on a feature branch of a repository whose dev is published to a bare origin. */
function office(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pipeline-telemetry-"))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo"); mkdirSync(root); git(root, "init", "-q", "-b", "dev");
  writeFileSync(join(root, "src.ts"), "export const value = 1;\n"); writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ project: "test", integrationBranch: "dev", pipeline: graph }));
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const origin = join(dir, "origin.git"); git(dir, "init", "--bare", "-q", origin); git(root, "remote", "add", "origin", origin); git(root, "push", "-q", "origin", "dev");
  git(root, "checkout", "-q", "-b", "wave");
  const commit = (text: string) => { writeFileSync(join(root, "src.ts"), `export const value = ${JSON.stringify(text)};\n`); git(root, "commit", "-qam", text); return git(root, "rev-parse", "HEAD"); };
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: root, teamId: "authors", role: "lead", paneId: null, status: "offline", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as WorldAgent;
  const crew = { ...lead, id: "deckhand", name: "deckhand", identity: "deckhand", role: "member" } as WorldAgent;
  const state = { agents: [lead, crew], teams: [{ id: "authors", name: "Authors", purpose: "", standing: true, path: null, branch: null, worktrees: [root], handsTo: null, createdAt: "now" }], repositories: [], work: [], messages: [], withFounder: [], herdr: "unavailable" } as unknown as WorldState;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('authors', 'Authors', 1, 'now')").run();
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('captain', 'captain', 'captain', 'authors', 'lead', 'now')").run();
  let clock = Date.parse("2026-10-03T10:00:00Z");
  const tick = (ms: number) => { clock += ms; };
  const p = new Pipelines(db, () => state, { evidenceDir: join(dir, "copies"), now: () => new Date(clock) });
  const start = () => p.start(lead, { clientId: `wave-${Math.random()}`, base: "origin/dev" });
  const done = (run: PipelineRun) => p.done(lead, { runId: run.id, clientId: `done-${Math.random()}`, expectedRevision: run.revision, nodeId: "checks", notes: "Verified", evidence: [{ kind: "check", summary: "passed", command: "npm test", exitCode: 0 }] });
  const gate = (run: PipelineRun, who = lead) => p.gate(who, { runId: run.id, delivery: "dev", round: run.round, candidate: run.candidate.head, operation: "push", repo: root, ref: "refs/heads/dev" });
  const events = (kind?: PipelineTelemetryEvent["kind"]) => { p.telemetry.flush(); return p.telemetry.read({ kind }).events.reverse(); };
  return { dir, root, db, p, lead, crew, commit, start, done, gate, events, tick, push: (sha: string) => git(root, "push", "-q", "origin", `${sha}:dev`) };
}

test("every gate result is recorded with reason codes, ordinary refusals included", t => {
  const o = office(t);
  o.commit("wave"); const run = o.start();
  assert.equal(o.gate(run).allowed, false);
  assert.throws(() => o.gate(run, o.crew), /first mate/);
  const done = o.done(run);
  assert.equal(o.gate(done).allowed, true);

  const gates = o.events("gate");
  assert.deepEqual(gates.map(g => g.detail.outcome), ["refused", "refused", "allowed"]);
  assert.deepEqual(gates[0]!.detail.reasons, [{ code: "step_ready", node: "checks" }]);
  assert.equal(gates[0]!.runId, run.id); assert.equal(gates[0]!.teamId, "authors");
  assert.deepEqual(gates[1]!.detail.reasons, [{ code: "pipeline_lead_required" }], "a thrown refusal is a gate result too");
  assert.equal(gates[1]!.detail.agentId, "deckhand");
  assert.deepEqual(gates[2]!.detail.reasons, []);
});

test("repeating the same gate result bumps one row instead of adding rows", t => {
  const o = office(t);
  o.commit("wave"); const run = o.start();
  for (let i = 0; i < 5; i++) { o.gate(run); o.tick(1000); }
  const gates = o.events("gate");
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.detail.repeats, 5);
  o.tick(11 * 60_000); o.gate(run);
  assert.equal(o.events("gate").length, 2, "after the repeat window a fresh row starts");
});

test("a failing or throwing log write never changes, delays or throws into a gate", t => {
  const o = office(t);
  o.commit("wave"); const run = o.done(o.start());
  const before = o.gate(run); o.p.telemetry.flush();
  o.db.exec("CREATE TRIGGER no_telemetry BEFORE INSERT ON events WHEN NEW.kind LIKE 'pipeline.telemetry.%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  o.db.exec("CREATE TRIGGER no_telemetry_update BEFORE UPDATE ON events WHEN NEW.kind LIKE 'pipeline.telemetry.%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
  const dropped = o.p.telemetry.dropped;
  assert.deepEqual(o.gate(run), before, "the gate's result is unchanged while every write fails");
  assert.doesNotThrow(() => o.p.telemetry.flush());
  assert.ok(o.p.telemetry.dropped > dropped, "the failed write is counted, not raised");

  // A refusal while the log throws synchronously is still the same refusal, raised as before.
  o.p.telemetry.note = () => { throw new Error("telemetry exploded"); };
  assert.deepEqual(o.gate(run), before);
  assert.throws(() => o.gate(run, o.crew), /first mate/);
});

test("telemetry is written after the caller's transaction, so a refusal survives its rollback and never aborts it", t => {
  const o = office(t);
  o.commit("wave"); const run = o.start();
  // Messages calls requireDelivery inside its own transaction and rolls back on refusal.
  o.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => o.p.requireDelivery(o.lead, "handoff", { runId: run.id, delivery: "handoff", round: run.round, candidate: run.candidate.head }), /delivery refused/);
  o.p.telemetry.flush();
  assert.equal(o.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind LIKE 'pipeline.telemetry.%'").get()!.n, 0, "nothing is written inside the caller's transaction");
  o.db.exec("ROLLBACK");
  const gates = o.events("gate");
  assert.equal(gates.length, 1);
  assert.deepEqual(gates[0]!.detail.reasons, [{ code: "no_boundary" }, { code: "step_ready", node: "checks" }]);

  o.db.exec("BEGIN IMMEDIATE");
  assert.throws(() => o.p.requireDelivery(o.lead, "handoff"), /needs a pipeline run/);
  o.db.exec("ROLLBACK");
  assert.deepEqual(o.events("gate").at(-1)!.detail.reasons, [{ code: "gate_required" }]);
});

test("a re-pin is an integration event; a publication stays pending until it lands", t => {
  const o = office(t);
  o.commit("first"); let run = o.done(o.start());
  assert.equal(o.gate(run).allowed, true); o.gate(run);
  let publications = o.events("publication");
  assert.deepEqual(publications.map(p => [p.detail.state, p.detail.candidate]), [["pending", run.candidate.head]], "one pending publication per candidate, however often the gate allows it");

  const second = o.commit("second");
  run = o.p.branch(o.lead, { runId: run.id, clientId: "repin", expectedRevision: run.revision, selections: {}, rationale: "next commit", candidate: second });
  o.p.branch(o.lead, { runId: run.id, clientId: "repin", expectedRevision: run.revision - 1, selections: {}, rationale: "next commit", candidate: second });
  const integration = o.events("integration");
  assert.equal(integration.length, 1, "a replayed request changed nothing and records nothing");
  assert.deepEqual(integration[0]!.detail.changes, ["repin"]);
  assert.equal(integration[0]!.detail.roundBumped, true);
  publications = o.events("publication");
  assert.equal(publications.at(-1)!.detail.how, "superseded");

  run = o.done(run); o.tick(90_000); o.gate(run); o.tick(30_000);
  o.push(second);
  assert.equal(o.p.get(run.id).state, "delivered");
  const landed = o.events("publication").at(-1)!;
  assert.equal(landed.detail.state, "resolved"); assert.equal(landed.detail.how, "landed");
  assert.equal(landed.detail.candidate, second); assert.equal(landed.detail.waitMs, 30_000);
  o.p.get(run.id); o.p.get(run.id);
  assert.equal(o.events("publication").length, 4, "reading a delivered run again records nothing");
});

test("a re-base onto newer published dev is an integration event", t => {
  const o = office(t);
  o.commit("wave"); let run = o.start();
  git(o.root, "checkout", "-q", "dev"); writeFileSync(join(o.root, "other.ts"), "export const other = 1;\n"); git(o.root, "add", "."); git(o.root, "commit", "-qm", "other");
  git(o.root, "push", "-q", "origin", "dev"); git(o.root, "checkout", "-q", "wave"); git(o.root, "rebase", "-q", "dev");
  const base = git(o.root, "rev-parse", "origin/dev");
  run = o.p.branch(o.lead, { runId: run.id, clientId: "rebase", selections: {}, rationale: "dev moved", base, candidate: git(o.root, "rev-parse", "HEAD") });
  const [event] = o.events("integration");
  assert.deepEqual(event!.detail.changes, ["rebase", "repin"]);
  assert.equal(event!.detail.newBase, base);
  assert.equal(event!.detail.roundBumped, false, "unchanged intended bytes keep the round");
});

test("decision waits run from the item revision to the founder's first Accept or Needs changes, per step", t => {
  const o = office(t);
  o.commit("wave"); const run = o.done(o.start());
  o.db.exec("PRAGMA foreign_keys = OFF");
  const item = (id: string, revision: number, created: string) => {
    o.db.prepare("INSERT OR IGNORE INTO items (id, task_id, key, type, revision, title, request, context, recommendation, options, check_text, blocking, content_hash, state, created_at, updated_at) VALUES (?, 't', ?, 'milestone', ?, 'Look', '', '', '', '[]', '', 1, '', 'needs_attention', ?, ?)").run(id, id, revision, created, created);
    o.db.prepare("INSERT INTO item_revisions (item_id, revision, snapshot, created_at) VALUES (?, ?, '{}', ?)").run(id, revision, created);
    o.db.prepare("INSERT INTO pipeline_item_bindings (item_id, revision, run_id, fingerprint) VALUES (?, ?, ?, ?)").run(id, revision, run.id, run.candidate.fingerprint);
  };
  const reply = (id: string, itemId: string, revision: number, action: string, at: string) => o.db.prepare("INSERT INTO replies (id, item_id, revision, action, text, state, created_at) VALUES (?, ?, ?, ?, '', 'delivered', ?)").run(id, itemId, revision, action, at);
  item("answered", 1, "2026-10-03T10:00:00.000Z");
  reply("r0", "answered", 1, "discuss", "2026-10-03T10:00:05.000Z");
  reply("r1", "answered", 1, "accept", "2026-10-03T10:00:23.000Z");
  reply("r2", "answered", 1, "request_changes", "2026-10-03T10:05:00.000Z");
  item("waiting", 1, "2026-10-03T11:00:00.000Z");
  // The step that endorses an approval is read from the stored run.
  const stored = JSON.parse(String(o.db.prepare("SELECT snapshot FROM pipeline_runs WHERE id = ?").get(run.id)!.snapshot)) as PipelineRun;
  stored.steps.find(s => s.nodeId === "checks")!.evidence.push({ kind: "approval", summary: "accepted", id: "e", byAgentId: "captain", fingerprint: "f", round: 1, createdAt: "now", approval: { itemId: "answered", revision: 1 } });
  o.db.prepare("UPDATE pipeline_runs SET snapshot = ? WHERE id = ?").run(JSON.stringify(stored), run.id);

  const waits = o.p.telemetry.read({ runId: run.id }).decisionWaits;
  const answered = waits.find(w => w.itemId === "answered")!; const waiting = waits.find(w => w.itemId === "waiting")!;
  assert.equal(answered.waitMs, 23_000, "a discussion message is not an answer");
  assert.equal(answered.action, "accept"); assert.equal(answered.stepId, "checks"); assert.equal(answered.blocking, true);
  assert.equal(waiting.answeredAt, null); assert.equal(waiting.waitMs, null); assert.equal(waiting.stepId, null);
  assert.equal(o.p.telemetry.read({ teamId: "authors" }).decisionWaits.length, 2);
  assert.equal(o.p.telemetry.read({ teamId: "others" }).decisionWaits.length, 0);
});

test("the log is bounded: a full queue drops notes instead of holding anything up", t => {
  const o = office(t); o.p.telemetry.flush();
  for (let i = 0; i < 600; i++) o.p.telemetry.note("gate", null, null, { i });
  assert.equal(o.p.telemetry.dropped, 100);
  o.p.telemetry.flush();
  assert.equal(o.p.telemetry.read({ limit: 1000 }).events.length, 500);
});

test("coverage starts with one marker, written once and kept, so earlier time reads as not measured", t => {
  const o = office(t);
  o.tick(60_000);
  const again = new Pipelines(o.db, () => ({ agents: [], teams: [] }) as unknown as WorldState, { now: () => new Date("2026-10-04T00:00:00Z") });
  o.p.telemetry.flush(); again.telemetry.flush();
  const markers = o.db.prepare("SELECT at, detail FROM events WHERE kind = 'pipeline.telemetry.started'").all();
  assert.equal(markers.length, 1, "a restart does not move coverage start");
  const view = again.telemetry.read({});
  assert.equal(view.coverageStartedAt, "2026-10-03T10:00:00.000Z");
  assert.equal(view.coverageSchemaVersion, 1); assert.equal(view.schemaVersion, 1);
  assert.equal(view.events.length, 0, "the marker is not an event row of any kind");
});

test("pruning to the row cap keeps the coverage marker", t => {
  const o = office(t); o.p.telemetry.flush();
  const small = new PipelineTelemetry(o.db, () => new Date("2026-10-05T00:00:00Z"), { keep: 3 });
  for (let i = 0; i < 10; i++) small.note("integration", null, null, { i });
  small.flush();
  assert.deepEqual(small.read({}).events.map(e => e.detail.i), [9, 8, 7], "only the newest rows are kept");
  assert.equal(o.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'pipeline.telemetry.started'").get()!.n, 1);
  assert.equal(small.read({}).coverageStartedAt, "2026-10-03T10:00:00.000Z");
});

const session = { harness: "claude" as const, sessionId: "s", cwd: "/" };
const report = (body: Record<string, unknown>) => telemetryReportSchema.parse({ session, ...body });

test("capture lease and attempt reports are strictly validated", () => {
  assert.deepEqual(report({ kind: "lease", action: "grant", lease: "gpu-1", holder: "Jens", resource: "GPU 0", at: "2026-10-03T10:00:00Z" }),
    { session, kind: "lease", action: "grant", lease: "gpu-1", holder: "Jens", resource: "GPU 0", at: "2026-10-03T10:00:00Z" });
  assert.equal(report({ kind: "attempt", attempt: "a-1", lease: "gpu-1", outcome: "failed", reason: "timeout" }).kind, "attempt");
  for (const [bad, field] of [
    [{ kind: "lease", action: "renew", lease: "gpu-1", holder: "Jens" }, /action/],
    [{ kind: "lease", action: "grant", lease: "gpu-1" }, /holder/],
    [{ kind: "lease", action: "grant", lease: "gpu 1", holder: "Jens" }, /lease/],
    [{ kind: "lease", action: "grant", lease: "gpu-1", holder: "Jens", outcome: "failed" }, /outcome.*not a field/],
    [{ kind: "attempt", attempt: "a-1", outcome: "failed", reason: "Timed Out" }, /reason/],
    [{ kind: "attempt", attempt: "a-1", outcome: "done" }, /outcome/],
    [{ kind: "attempt", attempt: "a-1", outcome: "started", at: "yesterday" }, /at/],
    [{ kind: "gate", attempt: "a-1", outcome: "started" }, /kind/],
  ] as const) assert.throws(() => report(bad), field);
});

test("reported leases and attempts are recorded beside the reporter and never change a gate", t => {
  const o = office(t);
  o.commit("wave"); const run = o.done(o.start());
  const before = o.gate(run);
  o.p.reportTelemetry(o.crew, report({ kind: "lease", action: "grant", lease: "gpu-1", holder: "Jens", run: run.id, at: "2026-10-03T09:59:00+02:00" }) as never);
  o.p.reportTelemetry(o.crew, report({ kind: "attempt", attempt: "a-1", lease: "gpu-1", run: run.id, outcome: "failed", reason: "gpu_busy" }) as never);
  o.p.reportTelemetry(o.crew, report({ kind: "lease", action: "release", lease: "gpu-1", holder: "Jens" }) as never);
  assert.deepEqual(o.gate(run), before, "the gate's answer is identical with capture events present");
  assert.throws(() => o.p.reportTelemetry(o.crew, report({ kind: "lease", action: "grant", lease: "x", holder: "y", run: "nope" }) as never), /no pipeline run/);

  const leases = o.events("lease");
  assert.deepEqual(leases.map(l => l.detail.action), ["grant", "release"]);
  assert.deepEqual({ ...leases[0], id: 0 }, { id: 0, at: "2026-10-03T10:00:00.000Z", kind: "lease", runId: run.id, teamId: "authors",
    detail: { action: "grant", lease: "gpu-1", holder: "Jens", reportedAt: "2026-10-03T07:59:00.000Z", agentId: "deckhand", agentTeamId: "authors", repeats: 1 } });
  assert.equal(leases[1]!.runId, null);
  const [attempt] = o.events("attempt");
  assert.deepEqual([attempt!.detail.outcome, attempt!.detail.reason, attempt!.detail.lease], ["failed", "gpu_busy", "gpu-1"]);
});

/** Runs the real CLI against `url`, returning its exit code, stderr and how long it took. */
async function cli(url: string, args: string[]): Promise<{ code: number | null; stderr: string; ms: number }> {
  const started = Date.now();
  const home = mkdtempSync(join(tmpdir(), "telemetry-cli-"));
  try {
    return await new Promise((done, failed) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, "..", "bin", "inbox"), "pipeline", "telemetry", "log", ...args],
        { env: { PATH: process.env.PATH, HOME: home, INBOX_URL: url, CLAUDE_CODE_SESSION_ID: "capture-tool" }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr.on("data", d => { stderr += d; });
      child.on("error", failed); child.on("close", code => done({ code, stderr, ms: Date.now() - started }));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("the log CLI exits 0 when the office is down, hangs, refuses or the flags are wrong", async t => {
  const lease = ["--kind", "lease", "--action", "grant", "--lease", "gpu-1", "--holder", "Jens"];
  const closed = await new Promise<number>(r => { const s = createServer().listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; s.close(() => r(port)); }); });
  const down = await cli(`http://127.0.0.1:${closed}`, lease);
  assert.equal(down.code, 0); assert.match(down.stderr, /telemetry not recorded/);

  const hanging = createHttpServer(() => { /* never answers */ }); t.after(() => { hanging.closeAllConnections(); hanging.close(); });
  await new Promise<void>(r => hanging.listen(0, "127.0.0.1", r));
  const slow = await cli(`http://127.0.0.1:${(hanging.address() as AddressInfo).port}`, lease);
  assert.equal(slow.code, 0); assert.match(slow.stderr, /telemetry not recorded/);
  assert.ok(slow.ms < 2000 + 3000, `gave up after ~2 s plus startup (took ${slow.ms} ms)`);

  const refusing = createHttpServer((_q, res) => { res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "action: must be one of grant, release, expire" })); });
  t.after(() => refusing.close()); await new Promise<void>(r => refusing.listen(0, "127.0.0.1", r));
  const refused = await cli(`http://127.0.0.1:${(refusing.address() as AddressInfo).port}`, lease);
  assert.equal(refused.code, 0); assert.match(refused.stderr, /must be one of/);

  const typo = await cli(`http://127.0.0.1:${closed}`, ["--kind", "lease", "--holdr", "Jens"]);
  assert.equal(typo.code, 0); assert.match(typo.stderr, /telemetry not recorded.*holdr/);
});

test("the read query accepts only known kinds, ISO times and bounded limits", () => {
  assert.deepEqual(telemetryQuery(new URLSearchParams("run=r&team=t&kind=gate&since=2026-10-03T10:00:00Z&limit=5")),
    { runId: "r", teamId: "t", kind: "gate", since: "2026-10-03T10:00:00.000Z", limit: 5 });
  assert.throws(() => telemetryQuery(new URLSearchParams("kind=leases")), /kind/);
  assert.throws(() => telemetryQuery(new URLSearchParams("since=yesterday")), /since/);
  assert.throws(() => telemetryQuery(new URLSearchParams("limit=100000")), /limit/);
});
