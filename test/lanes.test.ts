import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

// A team owns worktrees besides its own (lanes): Mission Control's crew work in theirs, and a
// project made for one of them by mistake can be merged in without anything on disk changing.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository with worktrees `repo-galilei` and `repo-heisenberg` beside it, as Mission Control's crew have. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lanes-repo-")));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const galilei = join(dir, "repo-galilei");
  const heisenberg = join(dir, "repo-heisenberg");
  git(root, "worktree", "add", "-q", "-b", "worktree-galilei", galilei);
  git(root, "worktree", "add", "-q", "-b", "worktree-heisenberg", heisenberg);
  return { dir, root, galilei, heisenberg };
}

function setup(file = ":memory:") {
  const db = openDatabase(file);
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "lanes-test-")), "files"), presence);
  const closed: string[] = [];
  const removed: string[] = [];
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async () => {},
    notify: async () => {},
    createWorktree: async () => ({ paneId: "w" }),
    startAgent: async () => {},
    closePane: async (pane) => void closed.push(pane),
    removeWorktree: async (repoRoot, path) => {
      removed.push(path);
      git(repoRoot, "worktree", "remove", path);
    },
  };
  const world = new World(db, source, () => inbox.state());
  return { db, world, closed, removed, setLive: (next: LiveAgent[]) => void (live = next) };
}

const agent = (paneId: string, cwd: string, sessionId: string, status: LiveAgent["status"] = "idle"): LiveAgent =>
  ({ paneId, harness: "claude", sessionId, cwd, status, title: null, name: null });

/** Mission Control, standing, led by an agent working outside the repository's worktrees. */
async function missionControl(world: World, setLive: (l: LiveAgent[]) => void, crew: LiveAgent[] = []) {
  setLive([agent("lead", "/clara", "s-lead"), ...crew]);
  const mc = await world.createTeam({ name: "Mission Control", standing: true });
  const clara = world.state().agents.find((a) => a.cwd === "/clara")!;
  world.updateAgent(clara.id, { teamId: mc.id, role: "lead" });
  return { mc, clara };
}

test("an agent in a worktree a team owns joins it as a member, and no project is made for that worktree", async () => {
  const { galilei } = repository();
  const { world, setLive } = setup();
  const { mc, clara } = await missionControl(world, setLive);
  world.addWorktree(mc.id, galilei);

  setLive([agent("lead", "/clara", "s-lead"), agent("p1", galilei, "s1")]);
  const { teams, agents } = world.state();
  assert.deepEqual(teams.map((t) => t.name), ["Mission Control"], "no project Galilei");
  assert.deepEqual(teams[0]!.worktrees, [galilei]);
  const nora = agents.find((a) => a.paneId === "p1")!;
  assert.deepEqual([nora.teamId, nora.role], [mc.id, "member"]);
  assert.equal(agents.find((a) => a.id === clara.id)!.role, "lead", "the lead stays the lead");

  // A replacement session in the same worktree is placed the same way.
  setLive([agent("lead", "/clara", "s-lead"), agent("p2", galilei, "s2"), { ...agent("p3", galilei, "s3"), name: "tests" }]);
  const placed = world.state().agents.filter((a) => a.cwd === galilei);
  assert.deepEqual(placed.map((a) => [a.teamId, a.role]), [[mc.id, "member"], [mc.id, "member"]]);
  assert.equal(world.state().teams.length, 1);
});

test("someone working in a lane is never made lead by the office, only by you", async () => {
  const { galilei } = repository();
  const { world, setLive } = setup();
  setLive([agent("p1", galilei, "s1"), agent("p2", "/somewhere", "s2")]);
  const mc = await world.createTeam({ name: "Mission Control", standing: true });
  world.addWorktree(mc.id, galilei);
  const crew = world.state().agents.find((a) => a.cwd === galilei)!;
  assert.deepEqual([crew.teamId, crew.role], [mc.id, "member"], "alone on it, still crew");
  const other = world.state().agents.find((a) => a.cwd === "/somewhere")!;
  world.updateAgent(other.id, { teamId: mc.id });
  let agents = world.state().agents;
  assert.equal(agents.find((a) => a.cwd === "/somewhere")!.role, "lead");
  assert.equal(agents.find((a) => a.cwd === galilei)!.role, "member");
  world.updateAgent(crew.id, { role: "lead" });
  agents = world.state().agents;
  assert.deepEqual(agents.map((a) => [a.cwd, a.role]).sort(), [[galilei, "lead"], ["/somewhere", "member"]]);
});

test("a worktree is owned once: another project's own worktree is merged, not added; a main checkout is no lane", async () => {
  const { root, galilei, heisenberg } = repository();
  const { world, setLive } = setup();
  const { mc } = await missionControl(world, setLive, [agent("p1", galilei, "s1")]);
  const project = world.state().teams.find((t) => t.name === "Galilei")!;
  assert.throws(() => world.addWorktree(mc.id, galilei), /Galilei's own worktree\. To make it Mission Control's, merge Galilei into Mission Control/);
  assert.throws(() => world.addWorktree(mc.id, root), /main checkout, not a worktree/);
  assert.throws(() => world.addWorktree(mc.id, "relative/path"), /full path/);
  world.addWorktree(mc.id, heisenberg);
  assert.throws(() => world.addWorktree(mc.id, heisenberg), /already works in/);
  assert.throws(() => world.addWorktree(project.id, heisenberg), /already one of Mission Control's worktrees/);
  assert.deepEqual(world.worktrees(mc.id), { worktrees: [heisenberg], available: [] }, "galilei is Galilei's, heisenberg Mission Control's");

  // Another repository is refused once the team works in one.
  const elsewhere = repository();
  assert.throws(() => world.addWorktree(mc.id, elsewhere.galilei), /another repository/);
});

test("removing a lane only lets it go: the folder stays", async () => {
  const { galilei } = repository();
  const { world, setLive } = setup();
  const { mc } = await missionControl(world, setLive);
  world.addWorktree(mc.id, galilei);
  assert.equal(world.worktrees(mc.id).available.length, 1, "heisenberg can be added");
  world.removeWorktree(mc.id, galilei);
  assert.deepEqual(world.state().teams.find((t) => t.id === mc.id)!.worktrees, []);
  assert.ok(existsSync(galilei));
  assert.throws(() => world.removeWorktree(mc.id, galilei), /has no worktree/);
});

test("merging a project made for a crew worktree keeps the worktree on disk and moves its agents as members", async () => {
  const { root, galilei } = repository();
  const { world, setLive, closed, removed, db } = setup();
  const { mc, clara } = await missionControl(world, setLive, [agent("p1", galilei, "s1")]);
  const project = world.state().teams.find((t) => t.name === "Galilei")!;
  const nora = world.state().agents.find((a) => a.paneId === "p1")!;
  assert.deepEqual([nora.teamId, nora.role], [project.id, "lead"], "what went wrong: the new session made its own project");
  world.messages.instruct(project.id, { text: "Check the docking test" });

  const { note, team } = world.mergeTeam(project.id, mc.id);
  assert.match(note, /Galilei is merged into Mission Control\. .*repo-galilei is now Mission Control's, left on disk as it was\. \w+ joins Mission Control as a member\./);
  assert.deepEqual(team.worktrees, [galilei]);
  const { teams, agents } = world.state();
  assert.deepEqual(teams.map((t) => t.name), ["Mission Control"]);
  assert.deepEqual([agents.find((a) => a.id === nora.id)!.teamId, agents.find((a) => a.id === nora.id)!.role], [mc.id, "member"]);
  assert.equal(agents.find((a) => a.id === clara.id)!.role, "lead");
  // Nothing on disk or in herdr was touched.
  assert.ok(existsSync(galilei));
  assert.match(git(root, "branch", "--list", "worktree-galilei"), /worktree-galilei$/);
  assert.deepEqual([closed, removed], [[], []]);
  // What was said to Galilei is now Mission Control's history.
  assert.equal((db.prepare("SELECT team_id FROM messages").get() as { team_id: string }).team_id, mc.id);

  // A new session there later joins Mission Control; no project comes back.
  setLive([agent("lead", "/clara", "s-lead"), agent("p9", galilei, "s9")]);
  assert.deepEqual(world.state().teams.map((t) => t.name), ["Mission Control"]);
  assert.equal(world.state().agents.find((a) => a.paneId === "p9")!.teamId, mc.id);
});

test("merging is refused while work waits for the project's review, for a standing team with lanes, and into itself", async () => {
  const { galilei, heisenberg } = repository();
  const { world, setLive } = setup();
  const { mc } = await missionControl(world, setLive, [agent("p1", galilei, "s1"), agent("p2", "/dev", "s2")]);
  const project = world.state().teams.find((t) => t.name === "Galilei")!;
  const dev = await world.createTeam({ name: "Dev", standing: true, handsTo: project.id });
  world.updateAgent(world.state().agents.find((a) => a.cwd === "/dev")!.id, { teamId: dev.id });
  world.messages.handoff(world.resolve({ harness: "claude", sessionId: "s2", cwd: "/dev" }), { title: "Login page", summary: "done" });

  assert.throws(() => world.mergeTeam(project.id, mc.id), /Galilei still has work to review \("Login page"\)\. .*review it first, then merge/);
  assert.throws(() => world.mergeTeam(project.id, project.id), /cannot be merged into itself/);
  assert.throws(() => world.mergeTeam(project.id, ""), /pick the project/);

  world.addWorktree(mc.id, heisenberg);
  assert.throws(() => world.mergeTeam(mc.id, dev.id), /Mission Control is a standing team with worktrees of its own .*repo-heisenberg.*so none is left without a team/);
  assert.equal(world.state().teams.length, 3, "nothing changed");
});

test("finishing a project removes only its own worktree, never one it owns besides", async () => {
  const { galilei, heisenberg } = repository();
  const { world, setLive, removed, closed } = setup();
  setLive([agent("p1", galilei, "s1"), agent("p2", heisenberg, "s2")]);
  const project = world.state().teams.find((t) => t.name === "Galilei")!;
  const other = world.state().teams.find((t) => t.name === "Heisenberg")!;
  world.mergeTeam(other.id, project.id);
  assert.deepEqual(world.state().teams.find((t) => t.id === project.id)!.worktrees, [heisenberg]);

  const { note } = await world.deleteTeam(project.id);
  assert.match(note, /Galilei is finished and .*repo-galilei removed/);
  assert.deepEqual(removed, [galilei]);
  assert.deepEqual(closed, ["p1"], "only the panes in its own worktree are closed");
  assert.ok(existsSync(heisenberg), "the extra worktree stays");
  assert.equal(existsSync(galilei), false);
});

test("a team's worktrees survive a restart", async () => {
  const { galilei } = repository();
  const file = join(mkdtempSync(join(tmpdir(), "lanes-db-")), "inbox.db");
  const first = setup(file);
  const { mc } = await missionControl(first.world, first.setLive);
  first.world.addWorktree(mc.id, galilei);
  first.db.close();

  const second = setup(file);
  second.setLive([agent("lead", "/clara", "s-lead"), agent("p1", galilei, "s1")]);
  const { teams, agents } = second.world.state();
  assert.deepEqual(teams.map((t) => [t.name, t.worktrees]), [["Mission Control", [galilei]]]);
  assert.equal(agents.find((a) => a.paneId === "p1")!.teamId, mc.id);
  second.db.close();
});
