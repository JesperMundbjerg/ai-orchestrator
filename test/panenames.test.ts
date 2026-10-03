import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { laneTitle } from "../src/server/panenames.ts";
import { StandingLanes, type AttachRun } from "../src/server/standing.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

// Each pane in herdr carries its agent's office name, and a standing lane's session is called after the lane.

const ATTACH = ["node", "attach.mjs"];
const connected = (session: string): AttachRun => ({
  code: 0,
  stdout: JSON.stringify({ state: "connected", reason: "ok", registered: { session, pane: null }, companion: { pid: 1, fresh: true, log: null }, progressAt: null, changed: false }),
});

/** A fictional project, with standing lanes einstein and galilei (worktrees) and heisenberg (an attach command), and a fake herdr. */
async function office(opts: { failLabels?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "panenames-")));
  const root = join(dir, "lantern");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
  const lanes = { einstein: join(dir, "lantern-einstein"), galilei: join(dir, "lantern-galilei"), heisenberg: join(dir, "lantern-heisenberg") };
  for (const [lane, path] of Object.entries(lanes)) execFileSync("git", ["worktree", "add", "-q", "-b", `worktree-${lane}`, path], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({
    project: "lantern",
    lanes: [
      { name: "einstein", worktree: "../lantern-einstein" },
      { name: "galilei", worktree: "../lantern-galilei" },
      { name: "heisenberg", worktree: "../lantern-heisenberg", attach: ATTACH },
    ],
  }));
  let live: LiveAgent[] = [];
  const labels: Array<[string, string]> = [];
  const source = {
    available: () => true,
    live: () => live,
    prompt: async () => {},
    notify: async () => {},
    renamePane: async (pane: string, label: string) => {
      labels.push([pane, label]);
      if (opts.failLabels) throw new Error("herdr refused");
    },
  } as unknown as AgentSource;
  const db = openDatabase(":memory:");
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const world = new World(db, source, () => inbox.state());
  let status = connected("s-old");
  const standing = new StandingLanes(() => world.state(), source, { run: async () => status });
  world.messages.laneRegistration = standing.registered;
  // The lanes are a standing team's worktrees, as FysikLab's are Mission Control's.
  const team = await world.createTeam({ name: "Dispatch", standing: true });
  for (const path of Object.values(lanes)) world.addWorktree(team.id, path);
  let renames = 0;
  world.onChange = (reason) => { if (reason === "world") renames++; };
  /** One office reaction, and the labels it set reaching herdr. */
  const react = async () => {
    await world.react();
    await new Promise((done) => setImmediate(done));
  };
  const name = (pane: string) => world.state().agents.find((a) => a.paneId === pane)?.name;
  return {
    world, standing, labels, lanes, react, name,
    renames: () => renames,
    setLive: (next: LiveAgent[]) => void (live = next),
    setStatus: (next: AttachRun) => void (status = next),
  };
}

const agent = (paneId: string, cwd: string, extra: Partial<LiveAgent> = {}): LiveAgent =>
  ({ paneId, harness: "claude", sessionId: `s-${paneId}`, cwd, status: "idle", title: null, name: null, ...extra });

test("a lane's name is title-cased", () => {
  assert.equal(laneTitle("galilei"), "Galilei");
  assert.equal(laneTitle("mission-control"), "Mission Control");
});

test("a pane is labelled with its agent's office name once, and again after the agent is renamed", async () => {
  const o = await office();
  o.setLive([agent("p1", "/elsewhere")]);
  await o.react();
  const first = o.name("p1")!;
  assert.deepEqual(o.labels, [["p1", first]]);

  await o.react();
  await o.react();
  assert.equal(o.labels.length, 1, "an unchanged name is not set again");

  const id = o.world.state().agents.find((a) => a.paneId === "p1")!.id;
  o.world.updateAgent(id, { name: "Bob" });
  await o.react();
  assert.deepEqual(o.labels, [["p1", first], ["p1", "Bob"]]);

  o.setLive([]);
  await o.react();
  o.setLive([agent("p1", "/elsewhere")]);
  await o.react();
  assert.deepEqual(o.labels.at(-1), ["p1", "Bob"], "a pane that went and came back is labelled again");
});

test("the agent running a lane's worktree is named after the lane, its crew beside it keep their names", async () => {
  const o = await office();
  o.setLive([agent("pE", o.lanes.einstein), agent("pG", o.lanes.galilei)]);
  await o.react();
  assert.equal(o.name("pE"), "Einstein");
  assert.equal(o.name("pG"), "Galilei", "the lane's own name, not Galileo");
  await o.react();
  assert.deepEqual(o.labels.filter(([p]) => p === "pE"), [["pE", "Einstein"]], "the pane follows the lane name");

  o.setLive([agent("pE", o.lanes.einstein), agent("pG", o.lanes.galilei), agent("pC", o.lanes.einstein, { name: "crew-a" })]);
  await o.react();
  await o.react();
  assert.equal(o.name("pE"), "Einstein", "the lane session keeps its name");
  assert.ok(!["Einstein", "Galilei"].includes(o.name("pC")!), "crew keep an ordinary name");
});

test("a lane's name is taken back from another agent called that, who gets an ordinary name", async () => {
  const o = await office();
  o.setLive([agent("pX", "/elsewhere")]);
  await o.react();
  const other = o.world.state().agents.find((a) => a.paneId === "pX")!;
  o.world.updateAgent(other.id, { name: "Einstein" });

  o.setLive([agent("pX", "/elsewhere"), agent("pE", o.lanes.einstein)]);
  await o.react();
  assert.equal(o.name("pE"), "Einstein");
  const renamed = o.name("pX")!;
  assert.notEqual(renamed.toLowerCase(), "einstein");
  assert.ok(renamed.length > 0);
});

test("recovering a lane onto a replacement session moves the name, and the old session gets an ordinary name back", async () => {
  const o = await office();
  const { heisenberg } = o.lanes;
  o.setLive([agent("old", heisenberg, { sessionId: "s-old" }), agent("new", heisenberg, { sessionId: "s-new" })]);
  await o.standing.check("lantern", "heisenberg");
  await o.react();
  assert.equal(o.name("old"), "Heisenberg", "the registered session, not the other agent in the worktree");
  assert.notEqual(o.name("new"), "Heisenberg");

  o.setStatus(connected("s-new"));
  await o.standing.check("lantern", "heisenberg");
  await o.react();
  assert.equal(o.name("new"), "Heisenberg");
  assert.ok(o.name("old") && o.name("old") !== "Heisenberg", "the old session has a name of its own again");
  await o.react();
  assert.deepEqual(o.labels.filter(([p]) => p === "new").at(-1), ["new", "Heisenberg"], "the replacement's pane reads Heisenberg");
});

test("an attach lane whose status is not known yet moves no name", async () => {
  const o = await office();
  o.setLive([agent("old", o.lanes.heisenberg, { sessionId: "s-old" })]);
  await o.react();
  assert.notEqual(o.name("old"), "Heisenberg");
});

test("names and labels settle: repeated reactions rename nothing more, and a refused label is not retried at once", async () => {
  const o = await office({ failLabels: true });
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: string) => void logged.push(line);
  try {
    o.setLive([agent("pE", o.lanes.einstein), agent("pG", o.lanes.galilei), agent("pZ", "/elsewhere")]);
    for (let i = 0; i < 5; i++) await o.react();
    const renames = o.renames();
    const labels = o.labels.length;
    for (let i = 0; i < 10; i++) await o.react();
    assert.equal(o.renames(), renames, "no agent is renamed again");
    assert.equal(o.labels.length, labels, "a refused label waits before it is tried again");
    assert.equal(labels, 3, "each pane was tried once");
    assert.ok(logged.some((l) => /could not be labelled/.test(l)), "the failure is logged");
  } finally {
    console.error = error;
  }
});
