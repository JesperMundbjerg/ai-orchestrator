import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { Unlanded, type UnlandedDeps } from "../src/server/unlanded.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const MIN = 60_000;
const T0 = Date.parse("2026-03-01T10:00:00Z");

/**
 * A repository on `main` that lands work on `dev` (published to a bare origin), a project worktree
 * `repo-atoms` for the lead and a lane `repo-lane` where a crew member works, both from dev.
 */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unlanded-repo-")));
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ integrationBranch: "dev" }));
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "worktree-sync.md"), "Run `land <checkout> <sha>` from the main checkout.\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "branch", "dev");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main", "dev");
  const atoms = join(dir, "repo-atoms");
  git(root, "worktree", "add", "-q", "-b", "worktree-atoms", atoms, "dev");
  const lane = join(dir, "repo-lane");
  git(root, "worktree", "add", "-q", "-b", "lane-b", lane, "dev");
  return { root, atoms, lane, origin };
}

type Status = LiveAgent["status"];

/** An office on a clock the test sets, whose herdr is faked: panes are what `setLive` says. */
function office(db: DatabaseSync = openDatabase(":memory:"), clock = { now: T0 }) {
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "unlanded-test-")), "files"), presence);
  const none = async () => { throw new Error("not used"); };
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async () => {},
    notify: async () => {},
    createWorktree: none,
    startAgent: none,
    closePane: async () => {},
    removeWorktree: none,
  };
  const world = new World(db, source, () => inbox.state(), () => new Date(clock.now));
  return { db, world, clock, setLive: (next: LiveAgent[]) => void (live = next), live: () => live };
}

const pane = (paneId: string, cwd: string, sessionId: string, status: Status = "idle"): LiveAgent =>
  ({ paneId, harness: "pi", sessionId, cwd, status, title: null, name: null });

/** The lead idles in the project's worktree; a crew member works in a lane. */
async function scene() {
  const repo = repository();
  const o = office();
  o.setLive([pane("p1", repo.atoms, "s1")]);
  const team = o.world.state().teams[0]!;
  o.world.addWorktree(team.id, repo.lane);
  o.setLive([pane("p1", repo.atoms, "s1"), pane("p2", repo.lane, "s2")]);
  const [a, b] = o.world.state().agents;
  const lead = a!.cwd === repo.atoms ? a! : b!;
  const crew = a!.cwd === repo.lane ? a! : b!;
  o.world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  o.world.updateAgent(crew.id, { teamId: team.id, role: "member" });
  const set = (status: Status, which: "p1" | "p2" = "p2") => o.setLive(o.live().map((l) => (l.paneId === which ? { ...l, status } : l)));
  /** Moves the clock and lets the office react, as its regular poll does. */
  const at = async (minutes: number) => { o.clock.now = T0 + minutes * MIN; await o.world.react(); };
  const said = (pattern: RegExp = /^Unlanded work: you/) => o.world.messages.list().filter((m) => m.fromOffice && pattern.test(m.text));
  const toFounder = () => o.world.messages.withFounder().filter((m) => m.toFounder && m.fromOffice && /left unlanded work/.test(m.text));
  return { ...repo, ...o, team, lead, crew, set, at, said, toFounder };
}

const ids = (m: { deliveries: Array<{ agentId: string }> }) => m.deliveries.map((d) => d.agentId);

test("an idle agent with uncommitted changes is told once, after five minutes", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(4);
  assert.equal(s.said().length, 0, "not before five minutes of idleness");
  await s.at(5);
  const [nudge, ...more] = s.said();
  assert.equal(more.length, 0);
  assert.deepEqual(ids(nudge!), [s.crew.id], "only the agent whose checkout it is");
  assert.match(nudge!.text, /1 uncommitted file/);
  assert.ok(nudge!.text.includes(s.lane), "names the checkout");
  assert.match(nudge!.text, /branch lane-b/);
  assert.match(nudge!.text, /not on dev/);
  assert.match(nudge!.text, /the way your team lands work/, "without a merge instruction");
  await s.at(8);
  await s.at(12);
  assert.equal(s.said().length, 1, "never again for the same state");
});

test("an idle agent with commits not on the landing branch is told, even when the main checkout has them", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  git(s.lane, "add", ".");
  git(s.lane, "commit", "-qm", "b");
  // In the main checkout and the local dev, but not published on origin/dev: not landed.
  git(s.root, "branch", "-f", "dev", "lane-b");
  await s.at(0);
  await s.at(5);
  const [nudge] = s.said();
  assert.ok(nudge, "told");
  assert.match(nudge!.text, /1 commit not on dev/);
  assert.doesNotMatch(nudge!.text, /uncommitted/);
});

test("an agent that is working or has nothing unlanded is never told", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  s.set("working");
  await s.at(0);
  await s.at(90);
  assert.equal(s.said().length, 0, "working");
  s.set("idle");
  await s.at(91);
  await s.at(95);
  assert.equal(s.said().length, 0, "the idle clock started when it stopped working, not before");
  await s.at(96);
  assert.equal(s.said().length, 1, "five minutes after it went idle");

  const clean = await scene();
  await clean.at(0);
  await clean.at(120);
  assert.equal(clean.said().length, 0, "nothing unlanded");
  assert.deepEqual(clean.world.state().unlanded, []);
});

test("an agent seen working restarts the idle clocks but is not told again about the same state", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  s.set("working");
  await s.at(10);
  s.set("idle");
  await s.at(11);
  await s.at(14);
  assert.equal(s.said().length, 1, "same state, same stage: said once");
  await s.at(25);
  assert.equal(s.said(/^Unlanded work on your team/).length, 0, "the lead's fifteen minutes run from when it went idle again");
  await s.at(26);
  assert.equal(s.said(/^Unlanded work on your team/).length, 1);
});

test("unlanded work still there fifteen minutes after the nudge goes to the lead, and after an hour to the founder, once each", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  git(s.lane, "add", ".");
  git(s.lane, "commit", "-qm", "b");
  writeFileSync(join(s.lane, "c.txt"), "c\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  await s.at(19);
  assert.equal(s.said(/^Unlanded work on your team/).length, 0, "not before fifteen minutes after the nudge");
  await s.at(20);
  const [toLead, ...more] = s.said(/^Unlanded work on your team/);
  assert.equal(more.length, 0);
  assert.deepEqual(ids(toLead!), [s.lead.id]);
  assert.ok(toLead!.text.includes(s.crew.name), "names the agent");
  assert.ok(toLead!.text.includes(s.lane), "and the checkout");
  assert.match(toLead!.text, /1 uncommitted file and 1 commit not on dev/);
  assert.equal(s.toFounder().length, 0);
  await s.at(64);
  assert.equal(s.toFounder().length, 0, "the founder hears after an hour");
  await s.at(65);
  const [line, ...rest] = s.toFounder();
  assert.equal(rest.length, 0);
  assert.ok(!line!.text.includes("\n"), "one line");
  assert.ok(line!.text.includes(s.crew.name));
  assert.match(line!.text, /1 uncommitted file and 1 commit not on dev in repo-lane/);
  await s.at(200);
  assert.equal(s.said().length, 1);
  assert.equal(s.said(/^Unlanded work on your team/).length, 1);
  assert.equal(s.toFounder().length, 1, "never more than one message per stage per state");
  assert.equal(s.world.state().unlanded![0]!.stage, "founder");
});

test("any change to the state starts over: a new commit, landing it, cleaning it", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  // A new commit is a new state: its own nudge after five idle minutes, and the lead's clock starts over.
  git(s.lane, "add", ".");
  git(s.lane, "commit", "-qm", "b");
  await s.at(18);
  await s.at(20);
  assert.equal(s.said(/^Unlanded work on your team/).length, 0, "the old state's escalation does not carry over");
  await s.at(23);
  assert.equal(s.said().length, 2, "told about the new state");
  // More edits of an already dirty file are a change too.
  writeFileSync(join(s.lane, "b.txt"), "b changed\n");
  await s.at(30);
  await s.at(35);
  assert.equal(s.said().length, 3);
  // Landing it clears everything; the same files dirty again are a new episode.
  git(s.lane, "commit", "-qam", "more");
  git(s.lane, "push", "-q", "origin", "HEAD:refs/heads/dev");
  await s.at(40);
  assert.deepEqual(s.world.state().unlanded, [], "landed");
  writeFileSync(join(s.lane, "d.txt"), "d\n");
  await s.at(41);
  await s.at(46);
  assert.equal(s.said().length, 4);
});

test("what was said survives a restart: nothing is said twice, and escalation goes on", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  // The service restarts: a new office on the same database, which has to observe idleness afresh.
  const again = office(s.db, s.clock);
  again.setLive(s.live());
  const watch = async (minutes: number) => { s.clock.now = T0 + minutes * MIN; await again.world.react(); };
  await watch(6);
  await watch(12);
  assert.equal(again.world.messages.list().filter((m) => m.fromOffice && /^Unlanded work/.test(m.text)).length, 1, "no second nudge");
  await watch(21);
  assert.equal(again.world.messages.list().filter((m) => /^Unlanded work on your team/.test(m.text)).length, 1, "the lead, fifteen minutes after the restart began watching");
  // A second restart repeats neither.
  const third = office(s.db, s.clock);
  third.setLive(s.live());
  s.clock.now = T0 + 22 * MIN;
  await third.world.react();
  assert.equal(third.world.messages.list().filter((m) => m.fromOffice && /Unlanded work/.test(m.text)).length, 2);
});

test("the main checkout is not watched", async () => {
  const s = await scene();
  writeFileSync(join(s.root, "scratch.txt"), "x\n");
  s.setLive([pane("p1", s.atoms, "s1"), pane("p2", s.lane, "s2"), pane("p3", s.root, "s3")]);
  await s.at(0);
  await s.at(30);
  assert.equal(s.said().length, 0);
  assert.deepEqual(s.world.state().unlanded, []);
});

test("an idle agent sharing a checkout with a working one is not told: the dirt may be theirs", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  s.setLive([pane("p1", s.atoms, "s1"), pane("p2", s.lane, "s2", "idle"), pane("p4", join(s.lane, "src"), "s4", "working")]);
  mkdirSync(join(s.lane, "src"), { recursive: true });
  await s.at(0);
  await s.at(30);
  assert.equal(s.said().length, 0);
});

test("the team's merge instruction, text and file, is in the nudge and in every brief", async () => {
  const s = await scene();
  s.world.updateTeam(s.team.id, { mergeInstruction: "Land with land <checkout> <sha>.", mergeInstructionPath: ".claude/commands/worktree-sync.md" });
  assert.equal(s.world.state().teams[0]!.mergeInstructionProblem, null);
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  const [nudge] = s.said();
  assert.match(nudge!.text, /merge instruction:\nLand with land <checkout> <sha>\./);
  assert.match(nudge!.text, /--- begin merge instruction ---\nRun `land <checkout> <sha>` from the main checkout\.\n--- end merge instruction ---/);
  assert.ok(!/the way your team lands work/.test(nudge!.text));

  const crew = s.world.brief({ harness: "pi", sessionId: "s2", cwd: s.lane });
  assert.match(crew.text, /When your work is done, land it on dev with .*merge instruction, then say it has landed:\nLand with land <checkout> <sha>\./);
  assert.match(crew.text, /Run `land <checkout> <sha>` from the main checkout\./);
  const lead = s.world.brief({ harness: "pi", sessionId: "s1", cwd: s.atoms });
  assert.match(lead.text, /When your work is done, land it on dev with .*merge instruction/);
  assert.match(lead.text, /Give it to every crew member you assign work/);
  assert.match(s.world.leadStartFor(s.lead.id)!, /Land with land <checkout> <sha>\./, "the takeover and made-lead brief");

  // Edited file reaches the next nudge; a missing file is said, not skipped.
  writeFileSync(join(s.atoms, ".claude-note"), "x");
  s.world.updateTeam(s.team.id, { mergeInstruction: "", mergeInstructionPath: "nope/missing.md" });
  assert.match(s.world.state().teams[0]!.mergeInstructionProblem!, /was not found/);
  assert.match(s.world.brief({ harness: "pi", sessionId: "s2", cwd: s.lane }).text, /could not give you .*merge file nope\/missing\.md/);
  s.world.updateTeam(s.team.id, { mergeInstruction: "", mergeInstructionPath: "" });
  assert.doesNotMatch(s.world.brief({ harness: "pi", sessionId: "s2", cwd: s.lane }).text, /merge instruction/, "no setting, no line in the brief");
  assert.throws(() => s.world.updateTeam(s.team.id, { mergeInstruction: "x".repeat(8001) }), /at most 8000 characters/);
  assert.throws(() => s.world.updateTeam(s.team.id, { mergeInstructionPath: "a\nb" }), /one path/);
});

test("the office lists agents with unlanded work for the team panel", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  git(s.lane, "add", ".");
  git(s.lane, "commit", "-qm", "b");
  writeFileSync(join(s.lane, "c.txt"), "c\n");
  await s.at(1);
  assert.deepEqual(s.world.state().unlanded, [{
    agentId: s.crew.id, agentName: s.crew.name, teamId: s.team.id, checkout: s.lane, branch: "lane-b", landing: "dev",
    uncommitted: 1, ahead: 1, since: new Date(T0 + MIN).toISOString(), stage: "watching",
  }]);
  await s.at(6);
  assert.equal(s.world.state().unlanded![0]!.stage, "agent");
  assert.equal(s.world.state().unlanded![0]!.since, new Date(T0 + MIN).toISOString(), "since the state was first seen");
});

// The pieces the fake office cannot set up cheaply, with the watch driven directly.
function direct(over: Partial<UnlandedDeps> = {}) {
  const repo = repository();
  const db = openDatabase(":memory:");
  const told: Array<{ to: string; text: string }> = [];
  const founder: string[] = [];
  const agent = (id: string, status: WorldAgent["status"], extra: Partial<WorldAgent> = {}): WorldAgent =>
    ({ id, name: id.toUpperCase(), paneId: `p-${id}`, cwd: repo.lane, status, teamId: "t1", role: "member", waitingOnYou: false, ...extra }) as WorldAgent;
  let agents = [agent("ada", "idle"), agent("lee", "idle", { cwd: repo.atoms, role: "lead" })];
  const state = (): WorldState => ({ agents, teams: [{ id: "t1", name: "Atoms" }], unlanded: [] } as unknown as WorldState);
  const checkout = (cwd: string) => {
    const top = cwd.startsWith(repo.lane) ? repo.lane : cwd.startsWith(repo.atoms) ? repo.atoms : repo.root;
    return { top, repoName: "repo", repoRoot: repo.root, branch: "x", gitDir: join(repo.root, ".git", "worktrees", top === repo.lane ? "repo-lane" : "repo-atoms"), linked: top !== repo.root };
  };
  const deps: UnlandedDeps = {
    state,
    checkout,
    landing: () => ({ ref: "refs/remotes/origin/dev", name: "dev" }),
    merge: () => null,
    runs: () => [],
    switching: () => new Set(),
    tell: (to, text) => void told.push({ to, text }),
    tellFounder: (text) => void founder.push(text),
    ...over,
  };
  writeFileSync(join(repo.lane, "b.txt"), "b\n");
  const watch = new Unlanded(db, deps);
  return { ...repo, watch, told, founder, state, setAgents: (next: WorldAgent[]) => void (agents = next), agent, get agents() { return agents; } };
}

test("an open pipeline run is named in the nudge, with its next step", () => {
  const d = direct({ runs: () => [{ id: "run-7", head: "abcdef0123456789", next: "verify (ready)" }] });
  d.watch.tick(d.state(), T0);
  d.watch.tick(d.state(), T0 + 5 * MIN);
  const nudge = d.told.find((t) => t.to === "ada")!;
  assert.match(nudge.text, /Pipeline run run-7 \(candidate abcdef0; next step: verify \(ready\)\) is open with the candidate not delivered\./);
});

test("an agent being switched to another harness is left alone", () => {
  let switching = new Set(["ada"]);
  const d = direct({ switching: () => switching });
  d.watch.tick(d.state(), T0);
  d.watch.tick(d.state(), T0 + 30 * MIN);
  assert.deepEqual(d.told, []);
  switching = new Set();
  d.watch.tick(d.state(), T0 + 31 * MIN);
  d.watch.tick(d.state(), T0 + 36 * MIN);
  assert.equal(d.told.length, 1);
});

test("the state is read again before anything is said: an agent that started working in the window is not told", () => {
  let fresh: WorldAgent[] | null = null;
  const d = direct({ state: () => ({ agents: fresh ?? d.agents, teams: [{ id: "t1", name: "Atoms" }], unlanded: [] }) as unknown as WorldState });
  d.watch.tick(d.state(), T0);
  fresh = [d.agent("ada", "working"), d.agent("lee", "idle", { cwd: d.atoms, role: "lead" })];
  d.watch.tick({ agents: d.agents, teams: [{ id: "t1", name: "Atoms" }], unlanded: [] } as unknown as WorldState, T0 + 5 * MIN);
  assert.deepEqual(d.told, [], "the polled state said idle, the fresh one said working");
  fresh = null;
  d.watch.tick(d.state(), T0 + 6 * MIN);
  assert.equal(d.told.length, 1, "told once it is idle again");
});

test("when the unlanded agent is the lead, only the founder is escalated to", () => {
  const d = direct();
  d.setAgents([d.agent("lee", "idle", { cwd: d.lane, role: "lead" }), d.agent("ada", "working", { cwd: d.atoms })]);
  d.watch.tick(d.state(), T0);
  d.watch.tick(d.state(), T0 + 5 * MIN);
  assert.deepEqual(d.told.map((t) => t.to), ["lee"]);
  assert.match(d.told[0]!.text, /inbox say founder/, "a lead says why to the founder");
  d.watch.tick(d.state(), T0 + 20 * MIN);
  assert.equal(d.told.length, 1, "nobody else to tell");
  d.watch.tick(d.state(), T0 + 65 * MIN);
  assert.equal(d.founder.length, 1);
  assert.doesNotMatch(d.founder[0]!, /was told/);
});

test("an agent that waits on the founder's answer is not nagged", () => {
  const d = direct();
  d.setAgents([d.agent("ada", "idle", { waitingOnYou: true }), d.agent("lee", "idle", { cwd: d.atoms, role: "lead" })]);
  d.watch.tick(d.state(), T0);
  d.watch.tick(d.state(), T0 + 90 * MIN);
  assert.deepEqual(d.told, []);
  assert.deepEqual(d.founder, []);
});
