import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { herdrName, projectQueue } from "../src/server/queue.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

/** FysikLab's shape: a main checkout on `dev` with standing lane worktrees under .claude/worktrees, and its adapter. */
function fysiklab(adapter: object = {
  project: "fysiklab",
  lanes: [
    { name: "einstein", worktree: ".claude/worktrees/einstein", harness: "pi" },
    { name: "heisenberg", worktree: ".claude/worktrees/heisenberg", model: "openai-codex/gpt-6-astra" },
    { name: "mission-control", agent: "dispatch-mission-control", role: "router" },
  ],
}) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "queue-"))), "space-shuttle");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(root, ".claude/worktrees"), { recursive: true });
  for (const lane of ["einstein", "heisenberg"]) git(root, "worktree", "add", "-q", "-b", `worktree-${lane}`, join(root, ".claude/worktrees", lane));
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify(adapter));
  let live: LiveAgent[] = [];
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(root, "..", "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, { available: () => true, live: () => live } as unknown as AgentSource, () => inbox.state());
  const agent = (pane: string, cwd: string, status: LiveAgent["status"], name: string | null = null, harness: LiveAgent["harness"] = "pi"): LiveAgent =>
    ({ paneId: pane, harness, sessionId: `s-${pane}`, cwd, status, title: `${pane} title`, name });
  return { root, db, world, inbox, agent, setLive: (next: LiveAgent[]) => void (live = next) };
}

test("herdr's name for an agent is read from the end of its identity", () => {
  assert.equal(herdrName("claude:/repo@dispatch-einstein"), "dispatch-einstein");
  assert.equal(herdrName("claude:/repo@tests#2"), "tests");
  assert.equal(herdrName("pi:/repo/.claude/worktrees/einstein"), null);
});

test("a project's lanes are its adapter's names joined to the agents in the office", () => {
  const { root, world, agent, setLive } = fysiklab();
  const einstein = join(root, ".claude/worktrees/einstein");
  setLive([
    agent("p1", einstein, "working"),
    agent("p2", root, "idle", "dispatch-mission-control", "claude"),
    agent("p3", root, "idle", null, "claude"), // someone else in the main checkout is not Mission Control
  ]);
  const queue = projectQueue(world.state(), "fysiklab");
  assert.equal(queue.project, "fysiklab");
  assert.deepEqual(queue.counts, { waiting: 0, assigned: 0, working: 0, held: 0, fixed: 0 });
  assert.deepEqual(queue.held, []);
  const [e, h, mc] = queue.lanes;
  const office = world.state().agents;
  assert.deepEqual(
    { name: e!.name, agent: e!.agentName, state: e!.state, doing: e!.doing, branch: e!.branch, harness: e!.harness, carrying: e!.carrying, why: e!.why },
    { name: "einstein", agent: office.find((a) => a.paneId === "p1")!.name, state: "working", doing: "p1 title", branch: "worktree-einstein", harness: "pi", carrying: [], why: null },
  );
  // Nobody runs in heisenberg's worktree: the lane is there, offline, with what the adapter says it runs.
  assert.deepEqual({ agent: h!.agentId, state: h!.state, model: h!.model, why: h!.why }, { agent: null, state: "offline", model: "openai-codex/gpt-6-astra", why: `nobody runs in ${join(root, ".claude/worktrees/heisenberg")}` });
  assert.deepEqual({ agent: mc!.agentId, role: mc!.role, state: mc!.state }, { agent: office.find((a) => a.paneId === "p2")!.id, role: "router", state: "idle" });
});

test("a lane whose agent is stuck at a prompt says who, and one that stopped keeps its name", () => {
  const { root, world, agent, setLive } = fysiklab();
  const einstein = join(root, ".claude/worktrees/einstein");
  setLive([agent("p1", einstein, "blocked")]);
  const stuck = projectQueue(world.state(), "fysiklab").lanes[0]!;
  assert.equal(stuck.state, "blocked");
  assert.match(stuck.why!, /is stuck at a prompt/);
  setLive([]);
  // The project's lead keeps a desk while offline, so the lane still names who it was.
  const lane = projectQueue(world.state(), "fysiklab").lanes[0]!;
  assert.equal(lane.state, "offline");
  assert.equal(lane.doing, null);
  assert.ok(lane.agentName);
  assert.equal(lane.why, `${lane.agentName} is not running in ${einstein}`);
});

test("a lane's branch is what git says for its worktree, even when its agent is on a standing team with no path", async () => {
  const { root, db, world, agent, setLive } = fysiklab();
  const einstein = join(root, ".claude/worktrees/einstein");
  const heisenberg = join(root, ".claude/worktrees/heisenberg");
  setLive([agent("p1", einstein, "working"), agent("p2", heisenberg, "idle")]);
  const crew = await world.createTeam({ name: "Crew", standing: true });
  assert.equal(crew.path, null);
  for (const a of world.state().agents) world.updateAgent(a.id, { teamId: crew.id, role: "member" });
  db.exec("DELETE FROM teams WHERE standing = 0"); // the projects first made for the worktrees
  const state = world.state();
  assert.deepEqual(state.teams.map((t) => t.path), [null], "no team stands at the lane's worktree to be found by");
  assert.deepEqual(projectQueue(state, "fysiklab").lanes.slice(0, 2).map((l) => l.branch), ["worktree-einstein", "worktree-heisenberg"]);
  // Git is asked, not the branch a team was made with: a lane switched to another branch shows that one.
  git(heisenberg, "switch", "-q", "-c", "fix-heisenberg");
  setLive([agent("p1", einstein, "working"), agent("p2", join(heisenberg, "."), "idle")]);
  assert.equal(projectQueue(world.state(), "fysiklab").lanes[1]!.branch, "fix-heisenberg");
});

test("an unknown project is a 404, and a broken adapter says what is wrong", () => {
  const { root, world, agent, setLive } = fysiklab({ project: "fysiklab", lanes: "einstein" });
  setLive([agent("p1", root, "idle")]);
  assert.throws(() => projectQueue(world.state(), "nope"), (e: Error & { status?: number }) => e.status === 404 && /no project "nope"/.test(e.message));
  assert.throws(() => projectQueue(world.state(), "space-shuttle"), (e: Error & { status?: number }) => e.status === 422 && /lanes must be a list/.test(e.message));
});

test("GET /api/p/:project/queue answers the same over HTTP", async () => {
  const { root, world, inbox, agent, setLive } = fysiklab();
  setLive([agent("p1", join(root, ".claude/worktrees/einstein"), "idle")]);
  const port = 49_000 + Math.floor(Math.random() * 1000);
  const server = createInboxServer(inbox, null, { port, staticDir: null, world });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ok = await fetch(`${base}/api/p/fysiklab/queue`);
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).lanes.map((l: { name: string; state: string }) => `${l.name}:${l.state}`), ["einstein:idle", "heisenberg:offline", "mission-control:offline"]);
    const missing = await fetch(`${base}/api/p/nope/queue`);
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /no project "nope"/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("inbox say <lane> reaches the agent behind a project's lane by the name its tools use", () => {
  const { root, world, agent, setLive } = fysiklab();
  const einstein = join(root, ".claude/worktrees/einstein");
  setLive([agent("p1", einstein, "idle"), agent("p2", root, "idle", "dispatch-mission-control", "claude")]);
  const office = world.state().agents;
  const [lane, router] = ["p1", "p2"].map((p) => office.find((a) => a.paneId === p)!);
  // Einstein's worktree is also a project called Einstein, led by the lane's agent: either way it reaches it.
  assert.deepEqual(world.messages.say(router!, { to: "Einstein", text: "You have 2 comments" }).deliveries.map((d) => d.agentId), [lane!.id]);
  const toRouter = world.messages.say(lane!, { to: "mission-control", text: "done" });
  assert.deepEqual([toRouter.teamId, toRouter.deliveries.map((d) => d.agentId)], [null, [router!.id]], "a lane with no worktree, found by herdr's name");
  assert.throws(() => world.messages.say(router!, { to: "mission-control", text: "me?" }), /that is you/);
  assert.throws(() => world.messages.say(router!, { to: "heisenberg", text: "hi" }), /heisenberg is a lane of fysiklab, but nobody runs in .*heisenberg/);
  assert.throws(() => world.messages.say(router!, { to: "galilei", text: "hi" }), /nobody called galilei in the office/);
});

test("an office name or team still wins over a lane with the same name", () => {
  const { world, agent, setLive, root } = fysiklab({ project: "fysiklab", lanes: [{ name: "einstein", worktree: ".claude/worktrees/einstein" }] });
  setLive([agent("p1", join(root, ".claude/worktrees/einstein"), "idle"), agent("p2", root, "idle", null, "claude")]);
  const office = world.state().agents;
  const [lane, other] = ["p1", "p2"].map((p) => office.find((a) => a.paneId === p)!);
  // The lane's agent is on its worktree's project, named after the folder: "Einstein".
  const project = world.state().teams.find((t) => t.path === join(root, ".claude/worktrees/einstein"))!;
  assert.equal(project.name, "Einstein");
  const said = world.messages.say(other!, { to: "einstein", text: "hi" });
  assert.equal(said.teamId, project.id, "the team called Einstein, whose lead is the lane's agent");
  assert.deepEqual(said.deliveries.map((d) => d.agentId), [lane!.id]);
});

test("a lane's agent can be the name a Pi session gave itself, matched exactly and never by folder", () => {
  const { root, world, agent, setLive } = fysiklab();
  // FysikLab's Mission Control: Pi in the main checkout, which herdr knows by no name; Claude Code works there too.
  setLive([agent("p1", root, "idle"), agent("p2", root, "working", null, "claude")]);
  const office = () => world.state().agents;
  const [pi, claude] = ["p1", "p2"].map((p) => office().find((a) => a.paneId === p)!);
  const lane = () => projectQueue(world.state(), "fysiklab").lanes.find((l) => l.name === "mission-control")!;

  // Before Pi says its name nobody stands behind the lane: not the Claude session working in the same folder.
  assert.deepEqual({ agent: lane().agentId, state: lane().state }, { agent: null, state: "offline" });
  assert.match(lane().why!, /whose herdr name or Pi session name is dispatch-mission-control/);
  assert.throws(() => world.messages.say(claude!, { to: "mission-control", text: "hi" }), /nobody runs whose herdr name or Pi session name is dispatch-mission-control/);

  // A name that is not exactly the lane's is no match either.
  world.report({ harness: "pi", sessionId: "s-p1", cwd: root, paneId: "p1" }, [{ kind: "session_name", sessionName: "dispatch-mission-control-2" }]);
  assert.equal(lane().agentId, null);

  world.report({ harness: "pi", sessionId: "s-p1", cwd: root, paneId: "p1" }, [{ kind: "session_name", sessionName: "dispatch-mission-control" }]);
  assert.equal(office().find((a) => a.id === pi!.id)!.sessionName, "dispatch-mission-control");
  assert.equal(office().find((a) => a.id === claude!.id)!.sessionName, null);
  assert.deepEqual({ agent: lane().agentId, state: lane().state, harness: lane().harness, why: lane().why }, { agent: pi!.id, state: "idle", harness: "pi", why: null });
  assert.deepEqual(world.messages.say(claude!, { to: "mission-control", text: "hi" }).deliveries.map((d) => d.agentId), [pi!.id]);

  // A new Pi session in the same checkout has not said it is Mission Control, and a cleared name is forgotten.
  setLive([{ ...agent("p1", root, "idle"), sessionId: "s-new" }, agent("p2", root, "working", null, "claude")]);
  assert.equal(lane().agentId, null);
  setLive([agent("p1", root, "idle"), agent("p2", root, "working", null, "claude")]);
  assert.equal(lane().agentId, pi!.id);
  world.report({ harness: "pi", sessionId: "s-p1", cwd: root, paneId: "p1" }, [{ kind: "session_name", sessionName: null }]);
  assert.equal(lane().agentId, null);
});
