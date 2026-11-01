import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type DatabaseSync as Db } from "node:sqlite";
import type { WorldAgent } from "../src/shared/types.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, InboxError, type PresenceSource } from "../src/server/inbox.ts";
import { Unlanded } from "../src/server/unlanded.ts";
import { unlandedSchema } from "../src/server/request-validation.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const MIN = 60_000;
const T0 = Date.parse("2026-03-01T10:00:00Z");

/** A repository landing on `dev`, with a lead's worktree `repo-atoms`, a lane `repo-lane` and another team's `repo-other`. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unlanded-hold-")));
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify({ integrationBranch: "dev" }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "branch", "dev");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main", "dev");
  const wt = (name: string, branch: string) => { const p = join(dir, name); git(root, "worktree", "add", "-q", "-b", branch, p, "dev"); return p; };
  return { root, atoms: wt("repo-atoms", "worktree-atoms"), lane: wt("repo-lane", "lane-b"), other: wt("repo-other", "worktree-other") };
}

type Status = LiveAgent["status"];

function office(db: Db = openDatabase(":memory:"), clock = { now: T0 }) {
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "unlanded-hold-test-")), "files"), presence);
  const none = async () => { throw new Error("not used"); };
  const source: AgentSource = { available: () => true, live: () => live, prompt: async () => {}, notify: async () => {}, createWorktree: none, startAgent: none, closePane: async () => {}, removeWorktree: none };
  const world = new World(db, source, () => inbox.state(), () => new Date(clock.now));
  return { db, world, clock, setLive: (next: LiveAgent[]) => void (live = next), live: () => live };
}

const pane = (paneId: string, cwd: string, sessionId: string, status: Status = "idle"): LiveAgent =>
  ({ paneId, harness: "pi", sessionId, cwd, status, title: null, name: null });

/** Team Atoms: its lead idles in repo-atoms and a crew member in the lane. Another team works in repo-other. */
async function scene() {
  const repo = repository();
  const o = office();
  o.setLive([pane("p1", repo.atoms, "s1")]);
  const team = o.world.state().teams[0]!;
  o.world.addWorktree(team.id, repo.lane);
  o.setLive([pane("p1", repo.atoms, "s1"), pane("p2", repo.lane, "s2"), pane("p3", repo.other, "s3")]);
  const agentAt = (cwd: string) => o.world.state().agents.find((a) => a.cwd === cwd)!;
  const lead = agentAt(repo.atoms);
  const crew = agentAt(repo.lane);
  o.world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  o.world.updateAgent(crew.id, { teamId: team.id, role: "member" });
  const stranger = agentAt(repo.other);
  const them = o.world.state().teams.find((t) => t.id === stranger.teamId)!;
  assert.notEqual(them.id, team.id, "the stranger is on another team");
  const fresh = (a: WorldAgent) => o.world.state().agents.find((x) => x.id === a.id)!;
  const set = (status: Status, which: "p1" | "p2" | "p3" = "p2") => o.setLive(o.live().map((l) => (l.paneId === which ? { ...l, status } : l)));
  const at = async (minutes: number) => { o.clock.now = T0 + minutes * MIN; await o.world.react(); };
  const clockAt = (minutes: number) => T0 + minutes * MIN;
  const said = (pattern: RegExp = /^Unlanded work: you/) => o.world.messages.list().filter((m) => m.fromOffice && pattern.test(m.text));
  const toFounder = (pattern: RegExp = /unlanded/) => o.world.messages.withFounder().filter((m) => m.toFounder && m.fromOffice && pattern.test(m.text));
  const hold = (who: WorldAgent, reason: string, minutes: number, path?: string) => o.world.unlanded.hold(fresh(who), reason, path, clockAt(minutes));
  const release = (who: WorldAgent, minutes: number, path?: string) => o.world.unlanded.release(fresh(who), path, clockAt(minutes));
  return { ...repo, ...o, team, them, lead, crew, stranger, fresh, set, at, said, toFounder, hold, release };
}

const leadMsgs = /^Unlanded work on your team/;
const heldNotice = /held unlanded/;

test("a hold stops the agent, lead and founder stages for that state, and the founder hears the reason once", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  const answer = s.hold(s.crew, "  a snapshot\n that lands from the main checkout ", 1);
  assert.equal(answer.held!.reason, "a snapshot that lands from the main checkout", "one line");
  assert.equal(answer.held!.by, s.crew.name);
  assert.equal(answer.checkout, s.lane);
  for (const m of [5, 20, 65, 300, 1000]) await s.at(m);
  assert.equal(s.said().length, 0, "the agent is not told");
  assert.equal(s.said(leadMsgs).length, 0, "nor its lead");
  assert.equal(s.toFounder(/left unlanded work/).length, 0, "nor the founder, by the hour");
  const [notice, ...more] = s.toFounder(heldNotice);
  assert.equal(more.length, 0, "the reason once");
  assert.equal(notice!.text, `${s.team.name}: ${s.lane} held unlanded: a snapshot that lands from the main checkout`);
  assert.ok(!notice!.text.includes("\n"), "one line");
  assert.equal(s.world.state().unlanded![0]!.held!.reason, "a snapshot that lands from the main checkout");
});

test("a hold placed after the agent was told also stops the lead and the founder", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  s.hold(s.crew, "must not land", 6);
  await s.at(21);
  await s.at(70);
  await s.at(400);
  assert.equal(s.said(leadMsgs).length, 0);
  assert.equal(s.toFounder(/left unlanded work/).length, 0);
  assert.equal(s.said().length, 1, "no second nudge either");
});

test("holding again with the same reason says nothing more; another reason is told as the new reason", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  s.hold(s.crew, "snapshot", 1);
  s.hold(s.crew, "snapshot", 2);
  s.hold(s.lead, "snapshot", 3, s.lane);
  assert.equal(s.toFounder(heldNotice).length, 1);
  s.hold(s.lead, "a different reason", 4, s.lane);
  assert.equal(s.toFounder(heldNotice).length, 2);
  assert.ok(s.toFounder(heldNotice).some((m) => /held unlanded: a different reason$/.test(m.text)), "the new reason is told");
});

test("any change to the state ends the hold and the clocks start over", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  s.hold(s.crew, "snapshot", 1);
  await s.at(30);
  assert.equal(s.said().length, 0);
  // An edit is a new state: the hold is gone and the agent is told about it as usual.
  writeFileSync(join(s.lane, "b.txt"), "b changed\n");
  await s.at(31);
  assert.equal(s.world.state().unlanded![0]!.held, undefined, "not held any more");
  assert.equal(s.said().length, 1, "told about the new state");
  assert.equal(s.said(leadMsgs).length, 0);
  await s.at(45);
  assert.equal(s.said(leadMsgs).length, 0, "the lead's clock runs from the new nudge");
  await s.at(46);
  assert.equal(s.said(leadMsgs).length, 1);
  assert.equal(s.toFounder(heldNotice).length, 1, "the old reason is not repeated");
  // A new commit ends a hold just as well.
  s.hold(s.crew, "again", 50);
  assert.equal(s.toFounder(heldNotice).length, 2);
  git(s.lane, "add", ".");
  git(s.lane, "commit", "-qm", "b");
  await s.at(51);
  assert.equal(s.world.state().unlanded![0]!.held, undefined);
  assert.equal(s.said().length, 2);
  // Landing it clears the hold with everything else.
  s.hold(s.crew, "once more", 60);
  git(s.lane, "push", "-q", "origin", "HEAD:refs/heads/dev");
  await s.at(61);
  assert.deepEqual(s.world.state().unlanded, []);
  writeFileSync(join(s.lane, "d.txt"), "d\n");
  await s.at(62);
  assert.equal(s.world.state().unlanded![0]!.held, undefined, "the same files dirty again are a new episode, not held");
});

test("releasing a hold restores the escalation, with the clocks starting again", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.equal(s.said().length, 1);
  s.hold(s.crew, "snapshot", 6);
  await s.at(100);
  assert.equal(s.said(leadMsgs).length, 0);
  s.release(s.crew, 100);
  assert.equal(s.world.state().unlanded![0]!.held, undefined);
  await s.at(101);
  await s.at(114);
  assert.equal(s.said(leadMsgs).length, 0, "fifteen minutes from the release");
  await s.at(115);
  assert.equal(s.said(leadMsgs).length, 1, "the lead is told");
  await s.at(159);
  assert.equal(s.toFounder(/left unlanded work/).length, 0);
  await s.at(160);
  assert.equal(s.toFounder(/left unlanded work/).length, 1, "and the founder after the hour");
  assert.equal(s.said().length, 1, "the agent is not told twice about one state");
});

test("a release before anyone was told starts the agent's five minutes from the release", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  s.hold(s.crew, "snapshot", 1);
  await s.at(60);
  s.release(s.crew, 60);
  await s.at(64);
  assert.equal(s.said().length, 0);
  await s.at(65);
  const [nudge] = s.said();
  assert.ok(nudge, "told");
  assert.match(nudge!.text, /idle for 65 minutes/, "how long it really has been idle");
  assert.throws(() => s.release(s.crew, 66), (e: unknown) => e instanceof InboxError && e.code === "unlanded_not_held");
});

test("the nudge tells the agent how to hold, and the lead's message does too", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  await s.at(5);
  assert.match(s.said()[0]!.text, /bin\/inbox unlanded hold "why"/);
  assert.match(s.said()[0]!.text, /the founder is told the reason once/i);
  await s.at(20);
  assert.ok(s.said(leadMsgs)[0]!.text.includes(`unlanded hold "why" --path ${s.lane}`));
});

test("a hold survives a restart of the service, and a working agent's held checkout is still listed", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  s.hold(s.crew, "snapshot", 1);
  s.set("working");
  await s.at(10);
  const [listed] = s.world.state().unlanded!;
  assert.equal(listed!.held!.reason, "snapshot", "a held state is listed while its agent works");
  const again = office(s.db, s.clock);
  again.setLive(s.live());
  for (const m of [200, 400]) { s.clock.now = T0 + m * MIN; await again.world.react(); }
  s.set("idle");
  again.setLive(s.live());
  for (const m of [401, 410, 500]) { s.clock.now = T0 + m * MIN; await again.world.react(); }
  assert.equal(again.world.messages.list().filter((m) => m.fromOffice && /^Unlanded work/.test(m.text)).length, 0);
  assert.equal(again.world.state().unlanded![0]!.held!.reason, "snapshot");
});

test("who may hold: an agent working there, or the lead of the team whose worktree it is; nobody else", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  await s.at(0);
  const refused = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof InboxError && e.status === 403 && e.code === "unlanded_not_yours");
  // Another team's member, even its lead, may not.
  refused(() => s.hold(s.stranger, "not mine", 1, s.lane));
  s.world.updateAgent(s.stranger.id, { role: "lead" });
  refused(() => s.hold(s.stranger, "not mine", 1, s.lane));
  refused(() => s.release(s.stranger, 1, s.lane));
  assert.equal(s.toFounder(heldNotice).length, 0, "a refusal says nothing");
  // A member of the team who does not work there may not either: only its lead.
  writeFileSync(join(s.other, "x.txt"), "x\n");
  refused(() => s.hold(s.crew, "not mine", 1, s.other));
  refused(() => s.hold(s.crew, "not mine", 1, s.atoms));
  // The team's lead may hold its lane without working in it; the agent working there may hold its own.
  s.hold(s.lead, "by the lead", 2, s.lane);
  assert.equal(s.fresh(s.crew).cwd, s.lane);
  s.release(s.crew, 3);
  s.hold(s.crew, "by the agent", 4);
  assert.equal(s.toFounder(heldNotice).length, 2);
  // An agent that works in a worktree may hold it, whatever team it is on.
  s.hold(s.stranger, "my own", 5, s.other);
  assert.ok(s.toFounder(heldNotice).some((m) => m.text === `${s.them.name}: ${s.other} held unlanded: my own`), "named for the team whose worktree it is");
});

test("only unlanded work in a watched worktree can be held, with a reason", async () => {
  const s = await scene();
  const code = (fn: () => unknown, status: number, c: string) => assert.throws(fn, (e: unknown) => e instanceof InboxError && e.status === status && e.code === c);
  code(() => s.hold(s.crew, "nothing here", 1), 409, "unlanded_nothing");
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  code(() => s.hold(s.crew, "   ", 1), 400, "unlanded_reason");
  code(() => s.hold(s.crew, "x".repeat(301), 1), 400, "unlanded_reason");
  code(() => s.hold(s.crew, "relative", 1, "repo-lane"), 400, "unlanded_path");
  code(() => s.hold(s.crew, "gone", 1, join(s.lane, "nope")), 404, "unlanded_path");
  s.set("idle", "p2");
  s.setLive([...s.live(), pane("p4", s.root, "s4")]);
  const main = s.world.state().agents.find((a) => a.cwd === s.root)!;
  writeFileSync(join(s.root, "scratch.txt"), "x\n");
  code(() => s.hold(main, "main checkout", 1), 409, "unlanded_main");
  assert.equal(s.toFounder(heldNotice).length, 0);
});

test("the list is the caller's team's: watched and held entries, with how far each has been told", async () => {
  const s = await scene();
  writeFileSync(join(s.lane, "b.txt"), "b\n");
  writeFileSync(join(s.other, "x.txt"), "x\n");
  await s.at(0);
  await s.at(5);
  const mine = s.world.unlanded.answer(s.fresh(s.crew));
  assert.deepEqual(mine.items.map((i) => [i.checkout, i.stage]), [[s.lane, "agent"]], "the other team's is not listed");
  s.hold(s.crew, "snapshot", 6);
  const held = s.world.unlanded.answer(s.fresh(s.lead));
  assert.equal(held.items[0]!.held!.reason, "snapshot");
  assert.equal(held.items[0]!.stage, "agent", "how far it had got is kept");
  assert.deepEqual(s.world.unlanded.answer(s.fresh(s.stranger)).items.map((i) => i.checkout), [s.other]);
});

test("the hold's columns are added to an existing table once, and nothing else migrates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE unlanded_watch (checkout TEXT PRIMARY KEY, state_key TEXT NOT NULL, first_seen INTEGER NOT NULL, agent_at INTEGER, lead_at INTEGER, founder_at INTEGER)`);
  db.prepare("INSERT INTO unlanded_watch (checkout, state_key, first_seen, agent_at) VALUES ('/x', 'k', 1, 2)").run();
  const deps = { state: () => ({ agents: [], teams: [] }), checkout: () => null, landing: () => ({ ref: "r", name: "dev" }), merge: () => null, runs: () => [], switching: () => new Set<string>(), tell: () => {}, tellFounder: () => {} };
  new Unlanded(db, deps as never);
  new Unlanded(db, deps as never);
  const columns = (db.prepare("PRAGMA table_info(unlanded_watch)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["hold_reason", "hold_by", "held_at", "resume_at"]) assert.equal(columns.filter((n) => n === c).length, 1, c);
  const row = db.prepare("SELECT * FROM unlanded_watch").get() as Record<string, unknown>;
  assert.equal(row.agent_at, 2, "what was latched is kept");
  assert.equal(row.hold_reason, null);
});

test("the request: hold needs a reason and a session; list and release do not", () => {
  const session = { harness: "pi", sessionId: "s", cwd: "/x" };
  assert.throws(() => unlandedSchema.parse({ session, action: "hold" }), /reason/);
  assert.throws(() => unlandedSchema.parse({ session, action: "hold", reason: "  " }), /reason/);
  assert.throws(() => unlandedSchema.parse({ session, action: "pause" }));
  assert.throws(() => unlandedSchema.parse({ action: "list" }));
  assert.equal(unlandedSchema.parse({ session, action: "hold", reason: "why", path: "/x" }).path, "/x");
  assert.equal(unlandedSchema.parse({ session, action: "release" }).action, "release");
  assert.equal(unlandedSchema.parse({ session, action: "list" }).action, "list");
});
