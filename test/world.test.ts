import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

function setup() {
  const db = openDatabase(":memory:");
  let live: LiveAgent[] = [];
  // Presence the way herdr gives it: a task's session found running in a pane.
  const presence: PresenceSource = {
    available: () => true,
    forSession: (harness, sessionId) => {
      const a = live.find((x) => x.harness === harness && x.sessionId === sessionId);
      return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null;
    },
    resolvePane: () => null,
  };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "world-test-")), "files"), presence);
  const prompts: Array<{ pane: string; text: string }> = [];
  const notices: string[] = [];
  let refuse: string | null = null;
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    read: async (pane) => `screen of ${pane}`,
    focus: async () => {},
    prompt: async (pane, text) => {
      if (refuse) throw new Error(refuse);
      prompts.push({ pane, text });
    },
    notify: async (title) => void notices.push(title),
  };
  const world = new World(db, source, () => inbox.state());
  return { inbox, world, prompts, notices, setLive: (next: LiveAgent[]) => void (live = next), refuse: (why: string | null) => void (refuse = why) };
}

/** A team with the given agents seated in it; the first is the lead of a dispatch team. */
function seat(world: World, structure: "dispatch" | "circle", cwds: string[]) {
  const team = world.createTeam({ name: "Mission Control", structure });
  const agents = cwds.map((cwd) => world.state().agents.find((a) => a.cwd === cwd)!);
  agents.forEach((a, i) => world.updateAgent(a.id, { teamId: team.id, role: structure === "dispatch" && i === 0 ? "lead" : "member" }));
  return { team, agents };
}

const lane = (paneId: string, cwd: string, sessionId: string, status: LiveAgent["status"] = "idle"): LiveAgent =>
  ({ paneId, harness: "pi", sessionId, cwd, status, title: null });

test("an agent keeps its name when its session restarts in the same checkout", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/repo-einstein", "session-1")]);
  const before = world.state().agents[0]!;
  setLive([lane("p7", "/repo-einstein", "session-2", "working")]);
  const after = world.state().agents[0]!;
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.equal(after.status, "working");
  assert.equal(after.paneId, "p7");
});

test("every agent gets its own name, and two agents in one checkout are two people", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/a", "s2"), ...Array.from({ length: 30 }, (_, i) => lane(`q${i}`, `/c${i}`, `t${i}`))]);
  const agents = world.state().agents;
  assert.equal(agents.length, 32);
  assert.equal(new Set(agents.map((a) => a.id)).size, 32);
  assert.equal(new Set(agents.map((a) => a.name)).size, 32);
});

test("a team member who stops running keeps a desk; someone in the lounge just leaves", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/idle", "s2")]);
  const [lead] = world.state().agents.filter((a) => a.cwd === "/lead");
  const team = world.createTeam({ name: "Mission Control", structure: "dispatch" });
  world.updateAgent(lead!.id, { teamId: team.id, role: "lead" });
  setLive([]);
  const agents = world.state().agents;
  assert.deepEqual(agents.map((a) => [a.cwd, a.status, a.teamId, a.role]), [["/lead", "offline", team.id, "lead"]]);
});

test("a team has one lead, leaving drops the role, and disbanding sends everyone to the lounge", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/b", "s2")]);
  const [a, b] = world.state().agents;
  const team = world.createTeam({ name: "Crew", structure: "dispatch" });
  world.updateAgent(a!.id, { teamId: team.id, role: "lead" });
  world.updateAgent(b!.id, { teamId: team.id, role: "lead" });
  assert.equal(world.agent(a!.id).role, "member");
  assert.equal(world.agent(b!.id).role, "lead");
  assert.equal(world.updateAgent(b!.id, { teamId: null }).role, "member");
  world.updateAgent(b!.id, { teamId: team.id });
  world.deleteTeam(team.id);
  assert.deepEqual(world.state().agents.map((x) => x.teamId), [null, null]);
  assert.throws(() => world.createTeam({ name: "  " }), /needs a name/);
  assert.throws(() => world.createTeam({ name: "X", structure: "hierarchy" }), /structure/);
});

test("an agent known only from the inbox appears offline with its project and its tasks", () => {
  const { inbox, world } = setup();
  const { taskId } = inbox.submit({
    session: { harness: "codex", sessionId: "thread-1" },
    project: { name: "Accounts", root: "/demo/accounts" },
    item: { type: "milestone", title: "Import works" },
  });
  const [agent] = world.state().agents;
  assert.equal(agent?.status, "offline");
  assert.equal(agent?.project, "Accounts");
  assert.deepEqual(agent?.taskIds, [taskId]);
});

test("a terminal is read through the agent source, and only for a running agent", async () => {
  const { inbox, world, setLive } = setup();
  setLive([lane("w1:p4", "/einstein", "s1")]);
  inbox.submit({ session: { harness: "manual", sessionId: "m1" }, item: { type: "milestone", title: "Done" } });
  const [running, offline] = [...world.state().agents].sort((x) => (x.paneId ? -1 : 1));
  assert.equal((await world.screen(running!.id)).text, "screen of w1:p4");
  await assert.rejects(world.screen(offline!.id), /not running in herdr/);
});

test("a team is blocked when its lead is stuck, or when someone is and nobody else is working", () => {
  const { world, setLive } = setup();
  const statusWith = (lead: LiveAgent["status"], crew: LiveAgent["status"]) => {
    setLive([lane("p1", "/lead", "s1", lead), lane("p2", "/crew", "s2", crew)]);
    return world.state().teams[0]!.status;
  };
  setLive([lane("p1", "/lead", "s1"), lane("p2", "/crew", "s2")]);
  seat(world, "dispatch", ["/lead", "/crew"]);
  assert.equal(statusWith("working", "blocked"), "working", "the lead handles a stuck crew member");
  assert.equal(statusWith("blocked", "working"), "blocked");
  assert.equal(statusWith("idle", "blocked"), "blocked", "nobody left working");
  assert.equal(statusWith("done", "idle"), "idle");
  setLive([]);
  assert.equal(world.state().teams[0]!.status, "offline");
});

test("a lead waiting on your answer in the inbox blocks the team", () => {
  const { inbox, world, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working"), lane("p2", "/crew", "s2", "working")]);
  seat(world, "dispatch", ["/lead", "/crew"]);
  inbox.submit({ session: { harness: "pi", sessionId: "s1" }, item: { type: "decide", title: "Which way?", options: ["A", "B"], blocking: true } });
  const { teams, agents } = world.state();
  assert.equal(teams[0]!.status, "blocked");
  assert.deepEqual(teams[0]!.blockedBy, [agents.find((a) => a.cwd === "/lead")!.id]);
});

test("a team is announced once when it becomes blocked, and not for how things stood at start", async () => {
  const { world, notices, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "blocked")]);
  seat(world, "dispatch", ["/lead"]);
  await world.react();
  assert.deepEqual(notices, [], "already blocked when the service started");
  setLive([lane("p1", "/lead", "s1", "working")]);
  await world.react();
  setLive([lane("p1", "/lead", "s1", "blocked")]);
  await world.react();
  await world.react();
  assert.deepEqual(notices, ["Mission Control is blocked"]);
});

test("an instruction to a lead-and-crew team goes to the lead once it is free, with its crew named", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/lead", "s1", "working"), lane("p2", "/crew", "s2", "idle")]);
  const { team, agents } = seat(world, "dispatch", ["/lead", "/crew"]);
  const order = world.instruct(team.id, { text: "Ship the login page", clientId: "c1" });
  assert.deepEqual(order.deliveries.map((d) => [d.agentId, d.state]), [[agents[0]!.id, "queued"]]);
  await world.react();
  assert.equal(prompts.length, 0, "the lead is busy");
  setLive([lane("p1", "/lead", "s1", "done"), lane("p2", "/crew", "s2", "idle")]);
  await Promise.all([world.react(), world.react()]);
  assert.equal(prompts.length, 1, "typed once, however many reactions race");
  assert.equal(prompts[0]!.pane, "p1");
  assert.match(prompts[0]!.text, /You lead Mission Control/);
  assert.match(prompts[0]!.text, new RegExp(agents[1]!.name));
  assert.match(prompts[0]!.text, /Ship the login page$/);
  assert.equal(world.state().teams[0]!.orders[0]!.deliveries[0]!.state, "delivered");
  assert.equal(world.instruct(team.id, { text: "Ship the login page", clientId: "c1" }).id, order.id, "a retried request is the same order");
});

test("peers each hear an instruction, one order at a time, and a failed delivery can be retried", async () => {
  const { world, prompts, setLive, refuse } = setup();
  setLive([lane("p1", "/a", "s1"), lane("p2", "/b", "s2")]);
  const { team, agents } = seat(world, "circle", ["/a", "/b"]);
  refuse("agent_blocked");
  const first = world.instruct(team.id, { text: "first" });
  world.instruct(team.id, { text: "second" });
  await world.react();
  const failed = world.state().teams[0]!.orders.find((o) => o.id === first.id)!;
  assert.deepEqual(failed.deliveries.map((d) => [d.state, d.error]), [["failed", "agent_blocked"], ["failed", "agent_blocked"]]);
  refuse(null);
  await world.react();
  assert.deepEqual(prompts.map((p) => p.text.split("\n\n")[1]), ["second", "second"], "a failed order does not hold up the next");
  world.retry(first.id, agents[0]!.id);
  await world.react();
  assert.deepEqual(prompts.map((p) => [p.pane, p.text.split("\n\n")[1]]).at(-1), ["p1", "first"]);
  assert.throws(() => world.retry(first.id, agents[0]!.id), /only a failed delivery/);
});

test("an instruction needs someone to hear it", () => {
  const { world, setLive } = setup();
  setLive([lane("p1", "/crew", "s1")]);
  const team = world.createTeam({ name: "Crew", structure: "dispatch" });
  world.updateAgent(world.state().agents[0]!.id, { teamId: team.id });
  assert.throws(() => world.instruct(team.id, { text: "go" }), /no lead/);
  assert.throws(() => world.instruct(team.id, { text: " " }), /needs some text/);
});

test("an agent hears its orders in the order they were given, even while another peer is still being told", async () => {
  const { world, prompts, setLive } = setup();
  setLive([lane("p1", "/a", "s1", "working"), lane("p2", "/b", "s2", "idle")]);
  const { team } = seat(world, "circle", ["/a", "/b"]);
  world.instruct(team.id, { text: "first" });
  world.instruct(team.id, { text: "second" });
  await world.react();
  assert.deepEqual(prompts.map((p) => [p.pane, p.text.split("\n\n")[1]]), [["p2", "first"]], "p1 is busy; p2 gets only the first order");
  await world.react();
  assert.deepEqual(prompts.map((p) => [p.pane, p.text.split("\n\n")[1]]).at(-1), ["p2", "second"]);
  assert.equal(prompts.filter((p) => p.pane === "p1").length, 0);
});
