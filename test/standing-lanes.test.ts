import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdapter } from "../src/server/adapter.ts";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { projectQueue } from "../src/server/queue.ts";
import { readReport, runAttach, StandingLanes, STATUS_TTL_MS, type AttachRun } from "../src/server/standing.ts";
import { Switches } from "../src/server/switch.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { AttachReport, StandingLane } from "../src/shared/types.ts";

const ATTACH = ["node", "space-app/scripts/lanes/attach-claude.mjs", "mission-control"];
const EXIT: Record<AttachReport["state"], number> = { connected: 0, disconnected: 3, busy: 4, unavailable: 5, refused: 6, failed: 7 };

/** What the project's attach command would print, with the exit code that goes with it. */
function answer(state: AttachReport["state"], more: Partial<AttachReport> = {}): AttachRun {
  return { code: EXIT[state], stdout: `log line\n${JSON.stringify({ state, reason: `${state} because`, registered: null, companion: null, progressAt: null, changed: false, ...more })}\n` };
}
/** Each fixture session's own pane, as the project would register it. */
const PANES: Record<string, string> = { "s-jens": "w1:pS", "s-ada": "w1:pX", "s-mo": "w1:pM" };
const connected = (session: string, more: Partial<AttachReport> = {}) =>
  answer("connected", { registered: { session, pane: PANES[session] ?? "w1:pR" }, companion: { pid: 84540, fresh: true, log: null }, ...more });

/** A fictional repository whose dispatcher lane declares an attach command, with Jens leading Dispatch in its main checkout. */
async function office() {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "standing-"))), "lantern");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({
    project: "lantern",
    lanes: [{ name: "mission-control", worktree: ".", agent: "dispatch-mission-control", role: "router", attach: ATTACH }, { name: "einstein", worktree: "elsewhere" }],
  }));
  let available = true;
  let live: LiveAgent[] = [
    { paneId: "w1:pS", harness: "claude", sessionId: "s-jens", cwd: root, status: "idle", title: "Jens", name: "lead-mission-control" },
    { paneId: "w1:pX", harness: "claude", sessionId: "s-ada", cwd: join(root, "elsewhere"), status: "idle", title: "Ada", name: null },
    { paneId: "w1:pM", harness: "claude", sessionId: "s-mo", cwd: root, status: "idle", title: "Mo", name: "mo" },
  ];
  const source = { available: () => available, live: () => live } as unknown as AgentSource;
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(root, "..", "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, source, () => inbox.state());
  const jensId = world.state().agents.find((a) => a.paneId === "w1:pS")!.id;
  const team = await world.createTeam({ name: "Dispatch", standing: true });
  world.updateAgent(jensId, { teamId: team.id, role: "lead" });
  const moId = world.state().agents.find((a) => a.paneId === "w1:pM")!.id;
  world.updateAgent(moId, { teamId: team.id, role: "member" });

  const calls: string[][] = [];
  const replies: Array<AttachRun | Promise<AttachRun>> = [];
  let status: AttachRun = connected("s-jens");
  let clock = Date.parse("2026-10-03T09:00:00Z");
  const standing = new StandingLanes(() => world.state(), source, {
    now: () => new Date(clock),
    run: async (argv, cwd, _timeout) => {
      assert.equal(cwd, root, "the command runs in the lane's own checkout");
      calls.push(argv.slice(ATTACH.length));
      if (argv.includes("--status")) return status;
      return replies.shift() ?? answer("failed");
    },
  });
  world.messages.laneRegistration = standing.registered;
  world.standingHolds = standing.holding;
  const jens = () => world.state().agents.find((a) => a.id === jensId)!;
  return {
    root, db, world, inbox, standing, calls, jens, moId,
    setStatus: (next: AttachRun) => void (status = next),
    reply: (next: AttachRun | Promise<AttachRun>) => void replies.push(next),
    setLive: (next: LiveAgent[]) => void (live = next),
    setAvailable: (next: boolean) => void (available = next),
    tick: (ms: number) => void (clock += ms),
    recovers: () => calls.filter((c) => c.includes("--recover")).length,
  };
}

test("an attach command is argv in the adapter, never a shell line", () => {
  const read = (attach: unknown) => parseAdapter(JSON.stringify({ project: "lantern", lanes: [{ name: "mc", attach }] }), "/repo", "lantern");
  assert.deepEqual(read(["node", "attach.mjs", "mc"]).adapter?.lanes[0]?.attach, ["node", "attach.mjs", "mc"]);
  assert.equal(parseAdapter(JSON.stringify({ lanes: [{ name: "mc" }] }), "/repo", "lantern").adapter?.lanes[0]?.attach, null);
  assert.match(read("node attach.mjs").problems.join(), /lanes\[0\]\.attach must be a list of strings/);
  assert.match(read([]).problems.join(), /lanes\[0\]\.attach must name a command/);
});

test("the lane joins the session the project registered, not a herdr name, so attaching needs no rename", async () => {
  const o = await office();
  const before = o.jens();
  // Before any status the old rule applies: nobody is called dispatch-mission-control.
  assert.equal(projectQueue(o.world.state(), "lantern").lanes[0]!.agentId, null);
  await o.standing.check("lantern", "mission-control");
  const lane = projectQueue(o.world.state(), "lantern", o.standing.registered).lanes[0]!;
  assert.equal(lane.agentId, before.id);
  // `inbox say mission-control` reaches the registered session, and nothing about Jens changed.
  const ada = o.world.state().agents.find((a) => a.paneId === "w1:pX")!;
  const message = o.world.messages.say(ada, { to: "mission-control", text: "board ready?" });
  assert.deepEqual(message.deliveries.map((d) => d.agentId), [before.id]);
  const after = o.jens();
  assert.deepEqual([after.id, after.name, after.teamId, after.role], [before.id, before.name, before.teamId, before.role]);
});

test("a stale registration never looks connected, even when the project says it is", async () => {
  const o = await office();
  // The old pane is gone but its companion still claims the lane.
  o.setStatus(connected("s-old", { registered: { session: "s-old", pane: "w1:pR" } }));
  let lane = await o.standing.check("lantern", "mission-control");
  assert.equal(lane.state, "disconnected");
  assert.match(lane.reason!, /session s-old in pane w1:pR is not running/);
  assert.equal(lane.registered?.running, false);
  assert.equal(projectQueue(o.world.state(), "lantern", o.standing.registered).lanes[0]!.agentId, null, "no stand-in by folder or name");
  // A live session whose companion is not fresh is not connected either.
  o.setStatus(connected("s-jens", { companion: { pid: 80882, fresh: false, log: null } }));
  o.tick(STATUS_TTL_MS);
  lane = await o.standing.check("lantern", "mission-control");
  assert.equal(lane.state, "disconnected");
  // The lane shows while Jens, Dispatch's lead, is online: it is not a leadwatch stall.
  assert.equal(o.jens().status, "idle");
  assert.equal(o.world.state().teams.find((t) => t.name === "Dispatch")!.stalled ?? null, null);
  assert.deepEqual(lane.candidates.map((c) => [c.name, c.role]), [[o.jens().name, "lead"]], "only who runs in the lane's checkout");
});

test("transport errors are unknown, never disconnected, and an ambiguous session joins nobody", async () => {
  const o = await office();
  const cases: AttachRun[] = [
    answer("unavailable", { reason: "herdr did not answer" }),
    { code: 1, stdout: "Error: boom" },
    { code: 0, stdout: "not json" },
    { code: 3, stdout: JSON.stringify({ state: "connected" }) },
    { code: null, stdout: "", error: "did not finish within 20 s" },
  ];
  for (const run of cases) {
    o.setStatus(run);
    o.tick(STATUS_TTL_MS);
    const lane = await o.standing.check("lantern", "mission-control");
    assert.equal(lane.state, "unknown", JSON.stringify(run));
  }
  assert.ok("transport" in readReport({ code: 0, stdout: JSON.stringify({ state: "busy" }) }));
  // herdr not visible: the office cannot confirm the session, so it does not say connected.
  o.setStatus(connected("s-jens"));
  o.setAvailable(false);
  o.tick(STATUS_TTL_MS);
  assert.equal((await o.standing.check("lantern", "mission-control")).state, "unknown");
  o.setAvailable(true);
  o.setLive([
    { paneId: "w1:pS", harness: "claude", sessionId: "s-jens", cwd: o.root, status: "idle", title: null, name: null },
    { paneId: "w1:pZ", harness: "claude", sessionId: "s-jens", cwd: o.root, status: "idle", title: null, name: null },
  ]);
  // Two panes in the checkout report the session and the project names no pane to tell them apart.
  o.setStatus(connected("s-jens", { registered: { session: "s-jens", pane: null } }));
  o.tick(STATUS_TTL_MS);
  const lane = await o.standing.check("lantern", "mission-control");
  assert.equal(lane.state, "unknown");
  assert.match(lane.reason!, /2 running agents report session s-jens/);
  assert.equal(projectQueue(o.world.state(), "lantern", o.standing.registered).lanes[0]!.agentId, null);
});

test("reading lanes checks each at most every 30 s, and concurrent reads share one run", async () => {
  const o = await office();
  o.standing.list();
  o.standing.list();
  await Promise.all([o.standing.check("lantern", "mission-control"), o.standing.check("lantern", "mission-control")]);
  assert.equal(o.calls.length, 1);
  o.tick(STATUS_TTL_MS - 1);
  o.standing.list();
  assert.equal(o.calls.length, 1);
  o.tick(1);
  o.standing.list();
  assert.equal(o.calls.length, 2);
  assert.deepEqual(o.calls[0], ["--status", "--json"]);
});

test("an explicit recovery runs once at a time and is confirmed by a fresh check, claiming no more than connected", async () => {
  const o = await office();
  o.setStatus(answer("disconnected", { reason: "registered session 90f6 is gone", registered: { session: "s-old", pane: "w1:pR" } }));
  const before = o.jens();
  let release!: (run: AttachRun) => void;
  o.reply(new Promise<AttachRun>((r) => (release = r)));
  const first = o.standing.recover("lantern", "mission-control", before.id);
  await assert.rejects(o.standing.recover("lantern", "mission-control", before.id), (e: Error & { status?: number }) => e.status === 409 && /already being recovered onto/.test(e.message));
  assert.equal(o.standing.list()[0]!.recovery?.state, "running");
  o.setStatus(connected("s-jens"));
  release(connected("s-jens", { changed: true }));
  const lane = await first;
  assert.equal(o.recovers(), 1);
  assert.deepEqual(o.calls.find((c) => c.includes("--recover")), ["--recover", "--pane", "w1:pS", "--session", "s-jens", "--json"]);
  assert.deepEqual([lane.state, lane.recovery?.state, lane.recovery?.agentName, lane.registered?.agentId], ["connected", "attached", before.name, before.id]);
  assert.equal(lane.recovery?.pane, "w1:pS");
  // The project's progressAt is only the session's last completed turn: shown as that, never promoted to proof of work.
  o.tick(STATUS_TTL_MS);
  o.setStatus(connected("s-jens", { progressAt: "2026-10-03T09:05:00.000Z" }));
  const later = await o.standing.check("lantern", "mission-control");
  assert.equal(later.lastTurnAt, "2026-10-03T09:05:00.000Z");
  assert.equal(later.recovery?.state, "attached");
  assert.deepEqual(Object.keys(later.recovery!).sort(), ["agentId", "agentName", "at", "log", "pane", "reason", "session", "state"]);
  const after = o.jens();
  assert.deepEqual([after.id, after.name, after.teamId, after.role], [before.id, before.name, before.teamId, before.role]);
});

test("repeating the same recovery is the command's idempotent retry, after a restart too", async () => {
  const o = await office();
  const id = o.jens().id;
  o.reply(connected("s-jens", { changed: false }));
  const lane = await o.standing.recover("lantern", "mission-control", id);
  assert.equal(lane.recovery?.state, "attached");
  assert.match(lane.recovery!.reason!, /already attached to this session; nothing was started/);
  // A new service keeps nothing of the old one: the status is the truth, and the retry is the same command.
  const restarted = new StandingLanes(() => o.world.state(), { available: () => true, live: () => [{ paneId: "w1:pS", harness: "claude", sessionId: "s-jens", cwd: o.root, status: "idle", title: null, name: null }] }, {
    run: async (argv) => (argv.includes("--status") ? connected("s-jens") : connected("s-jens", { changed: false })),
  });
  assert.equal((await restarted.check("lantern", "mission-control")).recovery, null);
  assert.equal((await restarted.recover("lantern", "mission-control", id)).recovery?.state, "attached");
});

test("busy, refused and failed recoveries say exactly why, and change nothing the office shows", async () => {
  const o = await office();
  o.setStatus(answer("disconnected", { registered: { session: "s-old", pane: "w1:pR" } }));
  const id = o.jens().id;
  const said: Array<[AttachRun, string]> = [
    [answer("busy", { reason: "the old session is working; wait for it to finish its turn" }), "busy"],
    [answer("refused", { reason: "pid 80882 is not a verified companion; it was not signalled" }), "refused"],
    [answer("unavailable", { reason: "herdr did not answer; nothing changed" }), "unavailable"],
    [answer("failed", { reason: "the companion exited before its heartbeat", companion: { pid: 9, fresh: false, log: "/q/mission-control.json.companion.log" } }), "failed"],
    [{ code: 1, stdout: "" }, "failed"],
  ];
  for (const [run, state] of said) {
    o.reply(run);
    const lane = await o.standing.recover("lantern", "mission-control", id);
    assert.equal(lane.recovery?.state, state);
    if (run.stdout) assert.equal(lane.recovery?.reason, JSON.parse(run.stdout.trim().split("\n").pop()!).reason);
    assert.equal(lane.recovery?.log, run.stdout.includes("companion.log") ? "/q/mission-control.json.companion.log" : null);
    assert.equal(lane.state, "disconnected");
  }
  // The command said connected but a fresh check disagrees: that is a failure, not a success.
  o.reply(connected("s-jens", { changed: true }));
  const lane = await o.standing.recover("lantern", "mission-control", id);
  assert.equal(lane.recovery?.state, "failed");
  assert.match(lane.recovery!.reason!, /said connected, but a fresh check says/);
});

test("a recovery names someone running in the lane's checkout, or nothing runs", async () => {
  const o = await office();
  const ada = o.world.state().agents.find((a) => a.paneId === "w1:pX")!;
  await assert.rejects(o.standing.recover("lantern", "mission-control", ada.id), (e: Error & { status?: number }) => e.status === 409 && /is not a team lead running in/.test(e.message));
  await assert.rejects(o.standing.recover("lantern", "einstein", ada.id), (e: Error & { status?: number }) => e.status === 409 && /declares no attach command/.test(e.message));
  assert.equal(o.recovers(), 0);
});

test("GET /api/lanes and POST recover answer over HTTP", async () => {
  const o = await office();
  const inbox = new Inbox(openDatabase(":memory:"), join(o.root, "..", "files2"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const port = 49_000 + Math.floor(Math.random() * 1000);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world: o.world, standing: o.standing });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  try {
    await o.standing.check("lantern", "mission-control");
    const got = await fetch(`${base}/api/lanes`);
    const lanes = (await got.json()) as StandingLane[];
    assert.equal(got.status, 200, JSON.stringify(lanes));
    assert.deepEqual(lanes.map((l) => [l.project, l.lane, l.state]), [["lantern", "mission-control", "connected"]]);
    o.reply(connected("s-jens", { changed: false }));
    const res = await fetch(`${base}/api/p/lantern/lanes/mission-control/recover`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ agentId: o.jens().id }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as StandingLane).recovery?.state, "attached");
    const bad = await fetch(`${base}/api/p/lantern/lanes/mission-control/recover`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("the runner runs argv without a shell and reads the exit code, the last line and a timeout", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "attach-run-")));
  writeFileSync(join(dir, "attach.mjs"), [
    "if (process.argv.includes('--slow')) setTimeout(() => {}, 10_000);",
    "else { console.log('noise; $(touch should-not-exist)'); console.log(JSON.stringify({ state: 'disconnected', reason: process.cwd() })); process.exitCode = 3; }",
  ].join("\n"));
  const run = await runAttach(["node", "attach.mjs", "mission-control", "--status", "--json"], dir, 5000);
  assert.equal(run.code, 3);
  const read = readReport(run);
  assert.ok("report" in read && read.report.state === "disconnected" && read.report.reason === dir);
  const slow = await runAttach(["node", "attach.mjs", "--slow"], dir, 200);
  assert.ok("transport" in readReport(slow) && /did not finish within/.test(slow.error!));
  const missing = await runAttach(["/nonexistent/attach"], dir, 1000);
  assert.ok("transport" in readReport(missing));
});

test("only the registered session in the lane's checkout, pane and harness holds it, and only a team lead there can be recovered onto", async () => {
  const o = await office();
  const jens = { harness: "claude" as const, sessionId: "s-jens", status: "idle" as const, title: "Jens", name: "lead-mission-control" };
  // The same session id also shows in another checkout and pane (the reviewer's wrong-checkout case).
  o.setLive([{ ...jens, paneId: "w1:pS", cwd: o.root }, { ...jens, paneId: "w1:pW", cwd: join(o.root, "elsewhere") }]);
  const look = async (run: AttachRun) => {
    o.setStatus(run);
    o.tick(STATUS_TTL_MS);
    return o.standing.check("lantern", "mission-control");
  };
  let lane = await look(connected("s-jens", { registered: { session: "s-jens", pane: "w1:pW" } }));
  assert.equal(lane.state, "disconnected", "registered to the pane in the wrong checkout");
  assert.match(lane.reason!, /session s-jens in pane w1:pW is not running in /);
  assert.equal(projectQueue(o.world.state(), "lantern", o.standing.registered).lanes[0]!.agentId, null);
  assert.deepEqual(o.world.standingHolds(o.jens()), []);
  lane = await look(connected("s-jens", { registered: { session: "s-jens", pane: "w1:pQ" } }));
  assert.equal(lane.state, "disconnected", "the right session and checkout, but not the registered pane");
  lane = await look(connected("s-jens"));
  assert.deepEqual([lane.state, lane.registered?.agentId], ["connected", o.jens().id], "the other checkout's copy is neither the holder nor an ambiguity");
  // A lane that declares its harness is held only on that harness.
  const adapter = join(o.root, "orchestrator.json");
  writeFileSync(adapter, JSON.stringify({ project: "lantern", lanes: [{ name: "mission-control", worktree: ".", harness: "pi", attach: ATTACH }] }));
  lane = await look(connected("s-jens"));
  assert.equal(lane.state, "disconnected");
  assert.match(lane.reason!, /is not running pi in /);
  assert.deepEqual(lane.candidates, [], "a claude lead is not offered for a pi lane");
  writeFileSync(adapter, JSON.stringify({ project: "lantern", lanes: [{ name: "mission-control", worktree: ".", agent: "dispatch-mission-control", attach: ATTACH }] }));
  o.setLive([{ ...jens, paneId: "w1:pS", cwd: o.root }, { paneId: "w1:pM", harness: "claude", sessionId: "s-mo", cwd: o.root, status: "idle", title: "Mo", name: "mo" }]);
  // The same session id reported from another folder is not the lane's holder.
  lane = await look(connected("s-ada"));
  assert.equal(lane.state, "disconnected");
  // Mo, a member running in the checkout, is not offered and is refused: recovery never picks a lead.
  assert.deepEqual(lane.candidates.map((c) => c.agentId), [o.jens().id]);
  await assert.rejects(o.standing.recover("lantern", "mission-control", o.moId), (e: Error & { status?: number }) => e.status === 409 && /not a team lead running in .*founder's choice/.test(e.message));
  assert.equal(o.recovers(), 0);
});

test("a recovery is judged by a check that starts after it, not one already running from before", async () => {
  const o = await office();
  let release!: (run: AttachRun) => void;
  let statusRuns = 0;
  const herdrRead: string[] = [];
  const standing = new StandingLanes(() => o.world.state(), {
    available: () => true,
    live: () => [{ paneId: "w1:pS", harness: "claude", sessionId: "s-jens", cwd: o.root, status: "idle", title: null, name: null }],
    refresh: async () => void herdrRead.push("refresh"),
  }, {
    run: (argv) => {
      if (argv.includes("--recover")) return Promise.resolve(connected("s-jens", { changed: true }));
      statusRuns++;
      // The first check, from before the recovery, answers late with the old session.
      return statusRuns === 1 ? new Promise<AttachRun>((r) => (release = r)) : Promise.resolve(connected("s-jens"));
    },
  });
  let told = 0;
  standing.onChange = () => void told++;
  const before = standing.check("lantern", "mission-control");
  const recovering = standing.recover("lantern", "mission-control", o.jens().id);
  release(answer("disconnected", { registered: { session: "s-old", pane: "w1:pR" } }));
  await before;
  const lane = await recovering;
  assert.equal(statusRuns, 2);
  assert.deepEqual(herdrRead, ["refresh"], "herdr is read again before judging");
  assert.deepEqual([lane.state, lane.recovery?.state, lane.registered?.session], ["connected", "attached", "s-jens"]);
  assert.ok(told >= 2, "the board is told when it starts and when it is judged");
});

test("a status already in flight that says connected does not confirm a recovery; the fresh one decides", async () => {
  const o = await office();
  let releaseStale!: (run: AttachRun) => void;
  let releaseRecover!: (run: AttachRun) => void;
  let statusRuns = 0;
  const standing = new StandingLanes(() => o.world.state(), {
    available: () => true,
    live: () => [{ paneId: "w1:pS", harness: "claude", sessionId: "s-jens", cwd: o.root, status: "idle", title: null, name: null }],
    refresh: async () => {},
  }, {
    run: (argv) => {
      if (argv.includes("--recover")) return new Promise<AttachRun>((r) => (releaseRecover = r));
      statusRuns++;
      // Started while the command ran, so from before its outcome; the run after it finds the companion gone.
      return statusRuns === 1 ? new Promise<AttachRun>((r) => (releaseStale = r)) : Promise.resolve(connected("s-jens", { companion: { pid: 84540, fresh: false, log: null } }));
    },
  });
  const recovering = standing.recover("lantern", "mission-control", o.jens().id);
  const during = standing.check("lantern", "mission-control");
  releaseRecover(connected("s-jens", { changed: true }));
  await new Promise((r) => setImmediate(r));
  releaseStale(connected("s-jens"));
  await during;
  const lane = await recovering;
  assert.equal(statusRuns, 2, "the in-flight status is waited out and a new one taken");
  assert.deepEqual([lane.state, lane.recovery?.state], ["disconnected", "failed"]);
  assert.match(lane.recovery!.reason!, /said connected, but a fresh check says: its companion's heartbeat is not fresh/);
});

test("the agent holding a standing lane is marked where crews are listed, and closing it is refused until the lane is recovered elsewhere", async () => {
  const o = await office();
  await o.standing.check("lantern", "mission-control");
  const jens = o.jens();
  const mo = o.world.state().agents.find((a) => a.id === o.moId)!;
  o.world.messages.say(mo, { to: jens.name, text: "one for you" });
  // Mo's own briefing lists Jens as the standing session with what waits for them.
  const brief = o.world.brief({ harness: "claude", sessionId: "s-mo", cwd: o.root }).text;
  assert.match(brief, new RegExp(`${jens.name} \\(lead\\): idle, the standing lantern/mission-control session: do not close it; 1 message waits for it`));
  const guard = o.world.standingGuard(jens)!;
  assert.match(guard, /is the standing lantern\/mission-control session and 1 message waits for it; recover the lane onto its replacement first/);
  assert.throws(() => o.world.removeAgent(jens.id), (e: Error & { status?: number }) => e.status === 409 && /standing lantern\/mission-control/.test(e.message));
  const switches = new Switches(o.db, o.world, null, mkdtempSync(join(tmpdir(), "switch-")));
  assert.match(switches.view(o.world.state().agents).offers[jens.id]?.refused ?? "", /standing lantern\/mission-control session/);
  assert.equal(o.world.standingGuard(mo), null);
  // Once the lane is recovered onto a replacement, Jens no longer holds it.
  o.setStatus(connected("s-mo"));
  o.tick(STATUS_TTL_MS);
  await o.standing.check("lantern", "mission-control");
  assert.equal(o.world.standingGuard(jens), null);
});
