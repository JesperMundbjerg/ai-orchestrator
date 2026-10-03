import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

// `inbox pane --cwd DIR` by someone on a team: whoever first runs in that pane and is placed nowhere
// joins that team as a member, even when the pane's checkout is outside the team's worktrees.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository (main checkout `repo`) with project worktrees `repo-alpha` and `repo-beta`, and a main checkout `other` elsewhere. */
function repositories() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pane-team-")));
  const make = (name: string) => {
    const root = join(dir, name);
    execFileSync("git", ["init", "-q", "-b", "dev", root]);
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    return root;
  };
  const root = make("repo");
  const other = make("other");
  const alpha = join(dir, "repo-alpha");
  const beta = join(dir, "repo-beta");
  git(root, "worktree", "add", "-q", "-b", "worktree-alpha", alpha);
  git(root, "worktree", "add", "-q", "-b", "worktree-beta", beta);
  return { root, other, alpha, beta };
}

function setup(clock = { at: new Date("2026-10-02T10:00:00Z") }, file = ":memory:") {
  const db = openDatabase(file);
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "pane-team-test-")), "files"), presence);
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async () => {},
    notify: async () => {},
    createWorktree: async () => ({ paneId: "w" }),
    startAgent: async () => {},
    closePane: async () => {},
    removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state(), () => clock.at);
  return { db, inbox, source, world, clock, setLive: (next: LiveAgent[]) => void (live = next) };
}

const agent = (paneId: string, cwd: string, sessionId: string, status: LiveAgent["status"] = "idle"): LiveAgent =>
  ({ paneId, harness: "claude", sessionId, cwd, status, title: null, name: null });

/** The project made for `alpha`, whose first mate (pane p1, session s1) runs there. */
function project(alpha: string, setLive: (next: LiveAgent[]) => void, world: World) {
  setLive([agent("p1", alpha, "s1")]);
  const team = world.state().teams[0]!;
  const mate = world.state().agents.find((a) => a.paneId === "p1")!;
  return { team, mate };
}

const mateSession = (alpha: string) => ({ harness: "claude" as const, sessionId: "s1", cwd: alpha });

test("an agent that starts in a pane its first mate opened outside the worktree joins the project as a member", () => {
  const { alpha, other } = repositories();
  const { world, setLive } = setup();
  const { team, mate } = project(alpha, setLive, world);
  assert.equal(mate.role, "lead");

  assert.deepEqual(world.paneOpened(mateSession(alpha), "p9"), { recorded: true });
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9")]);
  const state = world.state();
  const crew = state.agents.find((a) => a.paneId === "p9")!;
  assert.deepEqual([crew.teamId, crew.role], [team.id, "member"], "on the first mate's project, never its lead");
  assert.equal(state.agents.find((a) => a.id === mate.id)!.role, "lead");
  assert.equal(state.teams.length, 1, "the checkout is no project");
  assert.deepEqual(state.teams[0]!.worktrees, [], "and no lane");
});

test("an agent that was a lead's crew is never made lead, even when it is the only one running there", () => {
  const { alpha, other } = repositories();
  const { world, setLive } = setup();
  const { team } = project(alpha, setLive, world);
  world.paneOpened(mateSession(alpha), "p9");
  // The first mate is gone for now; the crew member still is not appointed over its desk.
  setLive([agent("p9", other, "s9")]);
  const crew = world.state().agents.find((a) => a.paneId === "p9")!;
  assert.deepEqual([crew.teamId, crew.role], [team.id, "member"]);
  assert.equal(world.state().agents.find((a) => a.role === "lead")!.status, "offline", "the first mate keeps the lead");
});

test("the worktree rules come first: an agent in another project's worktree stays on that project", () => {
  const { alpha, beta } = repositories();
  const { world, setLive } = setup();
  const { team: first } = project(alpha, setLive, world);
  world.paneOpened(mateSession(alpha), "p9");
  setLive([agent("p1", alpha, "s1"), agent("p9", beta, "s9")]);
  const { teams, agents } = world.state();
  const second = teams.find((t) => t.path === beta)!;
  assert.notEqual(second.id, first.id);
  assert.equal(agents.find((a) => a.paneId === "p9")!.teamId, second.id);
});

test("an agent in one of the team's lanes stays on that team as before", () => {
  const { alpha, beta } = repositories();
  const { world, setLive } = setup();
  const { team } = project(alpha, setLive, world);
  world.addWorktree(team.id, beta);
  world.paneOpened(mateSession(alpha), "p9");
  setLive([agent("p1", alpha, "s1"), agent("p9", beta, "s9")]);
  const { teams, agents } = world.state();
  assert.equal(teams.length, 1);
  assert.deepEqual([agents.find((a) => a.paneId === "p9")!.teamId, agents.find((a) => a.paneId === "p9")!.role], [team.id, "member"]);
});

test("someone already placed is left alone", async () => {
  const { alpha, other } = repositories();
  const { world, setLive } = setup();
  const { mate } = project(alpha, setLive, world);
  const standing = await world.createTeam({ name: "Mission Control", standing: true });
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9")]);
  const placed = world.state().agents.find((a) => a.paneId === "p9")!;
  world.updateAgent(placed.id, { teamId: standing.id });
  world.paneOpened(mateSession(alpha), "p9");
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, standing.id);
  assert.equal(world.state().agents.find((a) => a.id === mate.id)!.teamId, world.state().teams.find((t) => t.path)!.id);
});

test("nothing is recorded for a caller on no team, and an unknown caller is refused", () => {
  const { other } = repositories();
  const { world, setLive, db } = setup();
  setLive([agent("p1", other, "s1")]);
  assert.deepEqual(world.paneOpened({ harness: "claude", sessionId: "s1", cwd: other }, "p9"), { recorded: false });
  assert.equal((db.prepare("SELECT count(*) AS n FROM pane_teams").get() as { n: number }).n, 0);
  setLive([agent("p9", other, "s9")]);
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, null, "still in the lounge");
  assert.throws(() => world.paneOpened({ harness: "claude", sessionId: "nobody", cwd: "/nowhere" }, "p9"), /does not know this session/);
  assert.throws(() => world.paneOpened(mateSession(other), ""), /needs the new pane's id/);
});

test("the record is used once: a later agent in the same pane id is not placed, and a member the founder moves stays moved", () => {
  const { alpha, other } = repositories();
  const { world, setLive } = setup();
  const { team } = project(alpha, setLive, world);
  world.paneOpened(mateSession(alpha), "p9");
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9")]);
  const crew = world.state().agents.find((a) => a.paneId === "p9")!;
  assert.equal(crew.teamId, team.id);
  world.updateAgent(crew.id, { teamId: null });
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, null, "taken off the team, not put back");
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s10")]);
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, null, "a different agent in the reused pane id is not placed either");
});

test("a pane nobody started anything in is forgotten after a day", () => {
  const { alpha, other } = repositories();
  const { world, setLive, clock, db } = setup();
  project(alpha, setLive, world);
  world.paneOpened(mateSession(alpha), "p9");
  clock.at = new Date(clock.at.getTime() + 23 * 60 * 60 * 1000);
  setLive([agent("p1", alpha, "s1")]);
  world.state();
  assert.equal((db.prepare("SELECT count(*) AS n FROM pane_teams").get() as { n: number }).n, 1, "still held after 23 hours");
  clock.at = new Date(clock.at.getTime() + 2 * 60 * 60 * 1000);
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9")]);
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, null);
  assert.equal((db.prepare("SELECT count(*) AS n FROM pane_teams").get() as { n: number }).n, 0);
});

for (const { title, ageHours, survives } of [
  { title: "the record survives a restart of the service", ageHours: 23, survives: true },
  { title: "a restart does not renew an unused pane record's one-day lifetime", ageHours: 25, survives: false },
]) {
  test(title, (t) => {
    const { alpha, other } = repositories();
    const dir = mkdtempSync(join(tmpdir(), "pane-team-restart-"));
    const file = join(dir, "inbox.sqlite");
    let service = setup(undefined, file);
    t.after(() => {
      if (service.db.isOpen) service.db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const { world, setLive, clock } = service;
    const { team } = project(alpha, setLive, world);
    world.paneOpened(mateSession(alpha), "p9");
    service.db.close();

    // Keep the injected clock across restart: wall time would expire this fixed-date fixture.
    clock.at = new Date(clock.at.getTime() + ageHours * 60 * 60 * 1000);
    service = setup(clock, file);
    service.setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9")]);
    const crew = service.world.state().agents.find((a) => a.paneId === "p9")!;
    assert.equal(crew.teamId, survives ? team.id : null);
    assert.equal(crew.role, "member", "restarting never appoints the crew member lead");
  });
}

test("an agent still waiting in its pane is placed once it is running, not before", () => {
  const { alpha, other } = repositories();
  const { world, setLive } = setup();
  const { team } = project(alpha, setLive, world);
  world.paneOpened(mateSession(alpha), "p9");
  setLive([agent("p1", alpha, "s1")]);
  assert.equal(world.state().agents.some((a) => a.paneId === "p9"), false);
  setLive([agent("p1", alpha, "s1"), agent("p9", other, "s9", "working")]);
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, team.id);
});
