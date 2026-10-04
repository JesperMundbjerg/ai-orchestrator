import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { GONE_MS, Leases, type LeaseOffice } from "../src/server/leases.ts";
import { leaseSchemas } from "../src/server/leases-protocol.ts";
import { PipelineTelemetry } from "../src/server/pipelines/telemetry.ts";
import { leaseLine } from "../src/shared/leases.ts";
import type { Team, WorldAgent } from "../src/shared/types.ts";

const GRANTED = "Capture lease granted: go ahead; release with inbox lease release capture";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** Two repositories: A with a linked worktree (a Mission Control lane), and B. */
function repos() {
  const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
  const make = (name: string) => {
    const root = join(dir, name);
    execFileSync("git", ["init", "-q", root]);
    git(root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    return root;
  };
  const a = make("fysiklab");
  const lane = join(dir, "fysiklab-lane");
  git(a, "worktree", "add", "-q", "-b", "lane", lane);
  return { dir, a, lane, b: make("other") };
}

function office(paths: ReturnType<typeof repos>) {
  const agent = (id: string, name: string, cwd: string, teamId: string | null, role: "lead" | "member" = "member") =>
    ({ id, name, cwd, teamId, role, paneId: `p-${id}`, status: "idle" }) as unknown as WorldAgent;
  const agents = [
    agent("jens", "Jens", paths.lane, "mc", "lead"),
    agent("ada", "Ada", paths.a, "mc"),
    agent("bo", "Bo", paths.lane, "mc"),
    agent("cy", "Cy", paths.a, "mc"),
    agent("dee", "Dee", paths.b, "other"),
  ];
  const teams = [
    { id: "mc", name: "Mission Control", purpose: "", handsTo: null, path: null, branch: null, standing: true, worktrees: [paths.lane], createdAt: "" },
    { id: "other", name: "Other", purpose: "", handsTo: null, path: paths.b, branch: null, standing: false, worktrees: [], createdAt: "" },
  ] as Team[];
  const notices: Array<{ to: string; text: string }> = [];
  const notes: Array<{ runId: string | null; teamId: string | null; detail: Record<string, unknown> }> = [];
  const o = {
    agents, teams, notices, notes, presence: true,
    state: () => ({ agents: o.agents, teams: o.teams }),
    notify: (to: string, text: string) => { notices.push({ to, text }); },
    telemetry: { note: (_kind: "lease", runId: string | null, teamId: string | null, detail: Record<string, unknown>) => { notes.push({ runId, teamId, detail }); } } as LeaseOffice["telemetry"],
  };
  const port: LeaseOffice = { state: () => o.state(), notify: (a, t) => o.notify(a, t), presence: () => o.presence, get telemetry() { return o.telemetry; } };
  return { o, port, who: (id: string) => o.agents.find((a) => a.id === id)! };
}

function setup(file = ":memory:") {
  const paths = repos();
  const db = openDatabase(file === ":memory:" ? file : join(paths.dir, file));
  let t = Date.parse("2026-10-04T10:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const { o, port, who } = office(paths);
  const leases = new Leases(db, port, clock.now);
  const capture = { resource: "capture" as const };
  const done = () => { try { db.close(); } catch { /* closed */ } rmSync(paths.dir, { recursive: true, force: true }); };
  return { paths, db, clock, o, port, who, leases, capture, done };
}

test("the lease passes on in FIFO order, and each next holder is told it is theirs", () => {
  const s = setup();
  try {
    assert.equal(s.leases.acquire(s.who("ada"), s.capture).you.state, "held");
    const bo = s.leases.acquire(s.who("bo"), { ...s.capture, reason: "take captures" });
    assert.deepEqual(bo.you, { state: "queued", position: 1, leaseId: bo.you.leaseId });
    assert.equal(s.leases.acquire(s.who("cy"), s.capture).you.position, 2);
    assert.match(bo.text, /Ada holds fysiklab's capture lease.*You are #1 in line/);
    assert.equal(s.o.notices.length, 0, "an immediate grant needs no notice");

    s.clock.advance(5 * 60_000);
    const after = s.leases.release(s.who("ada"), s.capture);
    assert.equal(after.holder?.name, "Bo");
    assert.equal(after.holder?.leaseId, bo.you.leaseId, "the queue entry's id becomes the lease id");
    assert.deepEqual(after.queue.map((w) => [w.name, w.position]), [["Cy", 1]]);
    assert.equal(s.o.notices.length, 1);
    assert.equal(s.o.notices[0]!.to, "bo");
    assert.ok(s.o.notices[0]!.text.startsWith(GRANTED));

    s.leases.release(s.who("bo"), s.capture);
    assert.deepEqual(s.o.notices.map((n) => n.to), ["bo", "cy"]);
    const grants = s.o.notes.filter((n) => n.detail.action === "grant");
    assert.deepEqual(grants.map((g) => g.detail.holder), ["Ada", "Bo", "Cy"]);
    assert.equal(grants[1]!.detail.waitMs, 5 * 60_000, "waitMs runs from queue join to grant");
    assert.deepEqual(s.o.notes.map((n) => n.detail.action), ["grant", "join", "join", "release", "grant", "release", "grant"]);
    assert.equal(s.leases.release(s.who("cy"), s.capture).holder, null);
  } finally { s.done(); }
});

test("acquiring again while holding, or queuing twice, changes nothing", () => {
  const s = setup();
  try {
    const first = s.leases.acquire(s.who("ada"), s.capture);
    const again = s.leases.acquire(s.who("ada"), s.capture);
    assert.equal(again.you.state, "held");
    assert.equal(again.holder?.leaseId, first.holder?.leaseId);
    assert.equal(again.holder?.since, first.holder?.since);
    const queued = s.leases.acquire(s.who("bo"), s.capture);
    const twice = s.leases.acquire(s.who("bo"), s.capture);
    assert.deepEqual(twice.you, queued.you);
    assert.equal(twice.queue.length, 1);
    assert.equal(s.o.notes.length, 2, "one grant and one join, nothing for the repeats");
  } finally { s.done(); }
});

test("only the holder can release or renew; a waiter leaves the queue instead", () => {
  const s = setup();
  try {
    s.leases.acquire(s.who("ada"), s.capture);
    s.leases.acquire(s.who("bo"), s.capture);
    for (const act of ["release", "renew"] as const) {
      assert.throws(() => s.leases[act](s.who("bo"), s.capture), (err: Error & { status?: number; code?: string }) => {
        assert.equal(err.status, 403);
        assert.equal(err.code, "lease_not_holder");
        assert.match(err.message, /Ada holds it; you are #1 in line/);
        return true;
      });
    }
    assert.throws(() => s.leases.release(s.who("cy"), s.capture), /only the holder/);
    assert.equal(s.leases.status(s.who("cy"), s.capture).holder?.name, "Ada", "a refused release changes nothing");
    assert.equal(s.leases.leave(s.who("bo"), s.capture).queue.length, 0);
    assert.equal(s.o.notes.at(-1)!.detail.action, "leave");
  } finally { s.done(); }
});

test("an expired hold tells the holder and the project's lead and goes to the next in line; renew extends it", () => {
  const s = setup();
  try {
    s.leases.acquire(s.who("ada"), s.capture);
    s.leases.acquire(s.who("bo"), s.capture);
    s.clock.advance(25 * 60_000);
    const renewed = s.leases.renew(s.who("ada"), s.capture);
    assert.equal(renewed.holder?.expiresAt, "2026-10-04T10:55:00.000Z");
    s.clock.advance(29 * 60_000);
    s.leases.sweep();
    assert.equal(s.leases.status(s.who("jens"), s.capture).holder?.name, "Ada", "not yet expired");
    s.clock.advance(2 * 60_000);
    s.leases.sweep();
    const now = s.leases.status(s.who("jens"), s.capture);
    assert.equal(now.holder?.name, "Bo");
    const to = (id: string) => s.o.notices.filter((n) => n.to === id).map((n) => n.text);
    assert.match(to("ada").join(), /expired after 56 min .*passed to Bo/);
    assert.match(to("jens").join(), /Ada's hold on fysiklab expired/);
    assert.ok(to("bo")[0]!.startsWith(GRANTED));
    assert.ok(s.o.notes.some((n) => n.detail.action === "expire" && n.detail.holder === "Ada"));
  } finally { s.done(); }
});

test("a holder or waiter whose pane is gone for good loses its place; a brief absence or herdr outage does not", () => {
  const s = setup();
  try {
    s.leases.acquire(s.who("ada"), s.capture);
    s.leases.acquire(s.who("cy"), s.capture);
    s.leases.acquire(s.who("bo"), s.capture);
    s.o.agents = s.o.agents.filter((a) => a.id !== "ada" && a.id !== "cy");
    s.leases.sweep();
    s.clock.advance(GONE_MS - 1000);
    s.leases.sweep();
    assert.equal(s.leases.status(s.who("bo"), s.capture).holder?.name, "Ada", "within the grace period");
    s.o.presence = false;
    s.clock.advance(10 * 60_000);
    s.leases.sweep();
    assert.equal(s.leases.status(s.who("bo"), s.capture).holder?.name, "Ada", "herdr down: nobody can be judged gone");
    s.o.presence = true;
    s.leases.sweep();
    s.clock.advance(GONE_MS);
    s.leases.sweep();
    const now = s.leases.status(s.who("bo"), s.capture);
    assert.equal(now.holder?.name, "Bo");
    assert.equal(now.queue.length, 0, "the gone waiter's entry is removed");
    assert.ok(s.o.notes.some((n) => n.detail.action === "release" && n.detail.reason === "gone" && n.detail.holder === "Ada"));
    assert.ok(s.o.notes.some((n) => n.detail.action === "leave" && n.detail.reason === "gone" && n.detail.holder === "Cy"));
  } finally { s.done(); }
});

test("only the project's lead can revoke; holder and queue are told and the next is granted", () => {
  const s = setup();
  try {
    s.leases.acquire(s.who("ada"), s.capture);
    s.leases.acquire(s.who("bo"), s.capture);
    s.leases.acquire(s.who("cy"), s.capture);
    for (const id of ["bo", "ada", "dee"]) {
      assert.throws(() => s.leases.revoke(s.who(id), { ...s.capture, path: s.paths.a, reason: "stuck" }), (err: Error & { code?: string }) => err.code === "lease_lead_required" && /only Jens/.test(err.message));
    }
    assert.throws(() => s.leases.limit(s.who("ada"), { ...s.capture, minutes: 60 }), /only Jens/);
    const after = s.leases.revoke(s.who("jens"), { ...s.capture, reason: "hung capture" });
    assert.equal(after.holder?.name, "Bo");
    const to = (id: string) => s.o.notices.filter((n) => n.to === id).map((n) => n.text).join("\n");
    assert.match(to("ada"), /Jens revoked your capture lease on fysiklab: hung capture/);
    assert.ok(to("bo").startsWith(GRANTED));
    assert.match(to("cy"), /Jens revoked Ada's capture lease .*Bo has it now; you are #1 in line/);
    assert.ok(s.o.notes.some((n) => n.detail.action === "revoke" && n.detail.reason === "hung capture" && n.detail.by === "Jens"));
    assert.equal(s.leases.limit(s.who("jens"), { ...s.capture, minutes: 45 }).holdMinutes, 45);
  } finally { s.done(); }
});

test("--run must name an existing run of the caller's own team, and is recorded with the lease", () => {
  const s = setup();
  try {
    for (const [id, name] of [["mc", "Mission Control"], ["other", "Other"]] as const) s.db.prepare("INSERT INTO teams (id, name, created_at) VALUES (?, ?, 'now')").run(id, name);
    for (const [run, team] of [["run-mc", "mc"], ["run-other", "other"]] as const) s.db.prepare("INSERT INTO pipeline_runs (id, team_id, ledger_team_id, snapshot, created_at) VALUES (?, ?, ?, ?, 'now')").run(run, team, team, JSON.stringify({ teamId: team }));
    assert.throws(() => s.leases.acquire(s.who("ada"), { ...s.capture, run: "run-missing" }), (err: Error & { status?: number }) => err.status === 404);
    assert.throws(() => s.leases.acquire(s.who("ada"), { ...s.capture, run: "run-other" }), (err: Error & { status?: number; code?: string }) => err.status === 403 && err.code === "lease_run_other_team");
    assert.equal(s.leases.status(s.who("ada"), s.capture).holder, null, "a refused acquire takes nothing");
    const held = s.leases.acquire(s.who("ada"), { ...s.capture, run: "run-mc" });
    assert.equal(held.holder?.runId, "run-mc");
    assert.deepEqual([s.o.notes[0]!.runId, s.o.notes[0]!.teamId], ["run-mc", "mc"]);
  } finally { s.done(); }
});

test("an office restart keeps the holder and the queue", () => {
  const s = setup("inbox.sqlite");
  try {
    s.leases.acquire(s.who("ada"), { ...s.capture, reason: "probe" });
    s.leases.acquire(s.who("bo"), s.capture);
    s.leases.acquire(s.who("cy"), s.capture);
    const before = s.leases.status(s.who("jens"), s.capture);
    s.db.close();
    const db = openDatabase(join(s.paths.dir, "inbox.sqlite"));
    try {
      const reopened = new Leases(db, s.port, s.clock.now);
      const after = reopened.status(s.who("jens"), s.capture);
      assert.deepEqual(after.holder, before.holder);
      assert.deepEqual(after.queue, before.queue);
      assert.equal(reopened.release(s.who("ada"), s.capture).holder?.name, "Bo");
    } finally { db.close(); }
  } finally { s.done(); }
});

test("a throwing telemetry write leaves every lease result unchanged", () => {
  const s = setup();
  try {
    s.o.telemetry = { note: () => { throw new Error("telemetry down"); } };
    assert.equal(s.leases.acquire(s.who("ada"), s.capture).you.state, "held");
    assert.equal(s.leases.acquire(s.who("bo"), s.capture).you.position, 1);
    const after = s.leases.release(s.who("ada"), s.capture);
    assert.equal(after.holder?.name, "Bo");
    assert.ok(s.o.notices[0]!.text.startsWith(GRANTED), "the hand-off notice still goes out");
  } finally { s.done(); }
});

test("lease events land in the pipeline lease telemetry with lease id, holder and wait", () => {
  const s = setup();
  try {
    const telemetry = new PipelineTelemetry(s.db, s.clock.now);
    s.o.telemetry = telemetry;
    s.leases.acquire(s.who("ada"), s.capture);
    const bo = s.leases.acquire(s.who("bo"), s.capture);
    s.clock.advance(7 * 60_000);
    s.leases.release(s.who("ada"), s.capture);
    telemetry.flush();
    const events = telemetry.read({ kind: "lease" }).events.reverse();
    assert.deepEqual(events.map((e) => [e.detail.action, e.detail.holder]), [["grant", "Ada"], ["join", "Bo"], ["release", "Ada"], ["grant", "Bo"]]);
    const grant = events.at(-1)!;
    assert.equal(grant.detail.lease, bo.you.leaseId);
    assert.equal(grant.detail.waitMs, 7 * 60_000);
    assert.equal(grant.detail.source, "office");
  } finally { s.done(); }
});

test("every checkout of one repository shares a lease, and another repository has its own", () => {
  const s = setup();
  try {
    const ada = s.leases.acquire(s.who("ada"), s.capture);
    const bo = s.leases.acquire(s.who("bo"), s.capture);
    assert.equal(bo.you.state, "queued", "the lane worktree waits on the main checkout's holder");
    assert.equal(bo.repo, ada.repo);
    const viaPath = s.leases.status(s.who("dee"), { ...s.capture, path: s.paths.lane });
    assert.equal(viaPath.holder?.name, "Ada", "--repo names the repository from any of its checkouts");
    const dee = s.leases.acquire(s.who("dee"), s.capture);
    assert.equal(dee.you.state, "held");
    assert.notEqual(dee.repo, ada.repo);
    assert.equal(leaseLine(s.leases.forTeam("mc")), "Capture: Ada · 1 waiting");
    assert.equal(leaseLine(s.leases.forTeam("other")), "Capture: Dee");
  } finally { s.done(); }
});

test("lease requests are strictly decoded", () => {
  const session = { harness: "claude", sessionId: "s" };
  assert.deepEqual(leaseSchemas.acquire.parse({ session, resource: "capture", run: "r1" }), { session, resource: "capture", run: "r1" });
  assert.throws(() => leaseSchemas.acquire.parse({ session, resource: "port" }), /resource/);
  assert.throws(() => leaseSchemas.release.parse({ session, resource: "capture", run: "r1" }), /run/);
  assert.throws(() => leaseSchemas.revoke.parse({ session, resource: "capture" }), /reason/);
});
