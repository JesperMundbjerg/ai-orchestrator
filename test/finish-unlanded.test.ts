import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * A repository whose main checkout is on `main` and whose orchestrator.json lands work on `dev`,
 * published to a bare `origin`, with a project worktree `repo-atoms` on `worktree-atoms` from dev.
 */
function repository(adapter: object | null = { integrationBranch: "dev" }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "finish-repo-")));
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  if (adapter) writeFileSync(join(root, "orchestrator.json"), JSON.stringify(adapter));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "branch", "dev");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main", "dev");
  const atoms = join(dir, "repo-atoms");
  git(root, "worktree", "add", "-q", "-b", "worktree-atoms", atoms, "dev");
  return { root, atoms };
}

/** An office whose herdr is faked: its panes are what `setLive` says, closing and removing are recorded. */
function office() {
  const db = openDatabase(":memory:");
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "finish-test-")), "files"), presence);
  const prompts: Array<{ pane: string; text: string }> = [];
  const closed: string[] = [];
  const removed: string[] = [];
  const none = async () => { throw new Error("not used"); };
  const source: AgentSource = {
    available: () => true,
    live: () => live,
    prompt: async (pane, text) => void prompts.push({ pane, text }),
    notify: async () => {},
    createWorktree: none,
    startAgent: none,
    closePane: async (pane) => void closed.push(pane),
    removeWorktree: async (repoRoot, path) => {
      removed.push(path);
      git(repoRoot, "worktree", "remove", path);
    },
  };
  const world = new World(db, source, () => inbox.state());
  return { world, prompts, closed, removed, setLive: (next: LiveAgent[]) => void (live = next) };
}

const pane = (paneId: string, cwd: string, sessionId: string): LiveAgent =>
  ({ paneId, harness: "pi", sessionId, cwd, status: "idle", title: null, name: null });

/** A project with a lead and a crew member working in its worktree. */
function project() {
  const repo = repository();
  const o = office();
  o.setLive([pane("p1", repo.atoms, "s1"), pane("p2", join(repo.atoms, "src"), "s2")]);
  const team = o.world.state().teams[0]!;
  const [lead, crew] = o.world.state().agents;
  o.world.updateAgent(lead!.id, { teamId: team.id, role: "lead" });
  o.world.updateAgent(crew!.id, { teamId: team.id, role: "member" });
  const fromOffice = () => o.world.messages.list().filter((m) => m.fromOffice);
  return { ...repo, ...o, team, lead: o.world.state().agents.find((a) => a.id === lead!.id)!, crew: crew!, fromOffice };
}

test("finishing refuses while anything is uncommitted, and tells the lead to land it", async () => {
  const p = project();
  writeFileSync(join(p.atoms, "b.txt"), "b\n");
  await assert.rejects(p.world.deleteTeam(p.team.id, { force: true }), (err: Error & { status?: number; code?: string }) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, "finish_uncommitted", "force never skips uncommitted changes");
    assert.match(err.message, /^Atoms is not finished: 1 uncommitted change in .*repo-atoms: commit and land it first\./);
    assert.match(err.message, new RegExp(`${p.lead.name} was told to land it on dev\\.$`));
    return true;
  });
  const [notice, ...more] = p.fromOffice();
  assert.equal(more.length, 0);
  assert.deepEqual(notice!.deliveries.map((d) => d.agentId), [p.lead.id], "only the lead is told");
  assert.match(notice!.text, /^The founder wants to finish Atoms, but its work has not landed: 1 uncommitted change in .*\. Commit and land it on dev the usual way \(through the project's pipeline\), then tell the founder it is ready to finish/);
  assert.deepEqual(p.closed, []);
  assert.ok(existsSync(p.atoms), "nothing is removed");
});

test("commits not on the published integration branch refuse finishing and tell the lead, even once the main checkout has them", async () => {
  const p = project();
  writeFileSync(join(p.atoms, "b.txt"), "b\n");
  git(p.atoms, "add", ".");
  git(p.atoms, "commit", "-qm", "b");
  // Landed locally and in the main checkout, but not on origin/dev: it is not landed yet.
  git(p.root, "merge", "-q", "--ff-only", "worktree-atoms");
  git(p.root, "branch", "-f", "dev", "worktree-atoms");
  await assert.rejects(p.world.deleteTeam(p.team.id), (err: Error & { code?: string }) => {
    assert.equal(err.code, "finish_unlanded");
    assert.match(err.message, /^Atoms is not finished: 1 commit not on dev: land it first, or finish anyway and keep the branch\./);
    assert.match(err.message, new RegExp(`${p.lead.name} was told`));
    return true;
  });
  assert.match(p.fromOffice()[0]!.text, /its work has not landed: 1 commit not on dev\. Commit and land it on dev/);
  assert.deepEqual(p.closed, [], "the agents who can land it are still there");

  git(p.root, "push", "-q", "origin", "dev");
  const { note } = await p.world.deleteTeam(p.team.id);
  assert.match(note, /^Atoms is finished and .*repo-atoms removed\./);
  assert.deepEqual(p.closed.sort(), ["p1", "p2"]);
  assert.match(note, /Branch worktree-atoms was merged and is deleted/);
  assert.equal(p.fromOffice().length, 1, "a finish that goes ahead tells nobody");
});

test("without an origin the local integration branch counts, and without one named the main checkout's branch", async () => {
  for (const adapter of [{ integrationBranch: "dev" }, null]) {
    const repo = repository(adapter);
    git(repo.root, "remote", "remove", "origin");
    const o = office();
    o.setLive([pane("p1", repo.atoms, "s1")]);
    const team = o.world.state().teams[0]!;
    writeFileSync(join(repo.atoms, "b.txt"), "b\n");
    git(repo.atoms, "add", ".");
    git(repo.atoms, "commit", "-qm", "b");
    const target = adapter ? "dev" : "main";
    await assert.rejects(o.world.deleteTeam(team.id), new RegExp(`1 commit not on ${target}:`));
    git(repo.root, "branch", "-f", target === "dev" ? "dev" : "main-landed", "worktree-atoms");
    if (target === "main") git(repo.root, "merge", "-q", "--ff-only", "main-landed");
    assert.match((await o.world.deleteTeam(team.id)).note, /is finished/);
  }
});

test("finish anyway closes the project but keeps its branch with the commits that have not landed", async () => {
  const p = project();
  writeFileSync(join(p.atoms, "b.txt"), "b\n");
  git(p.atoms, "add", ".");
  git(p.atoms, "commit", "-qm", "b");
  await assert.rejects(p.world.deleteTeam(p.team.id), /1 commit not on dev/);
  const { note } = await p.world.deleteTeam(p.team.id, { force: true });
  assert.match(note, /Branch worktree-atoms is kept: 1 commit is not on dev yet\./);
  assert.equal(git(p.root, "branch", "--list", "worktree-atoms"), "worktree-atoms");
  assert.equal(git(p.root, "log", "-1", "--format=%s", "worktree-atoms"), "b");
  assert.deepEqual(p.removed, [p.atoms]);
  assert.deepEqual(p.world.state().teams, []);
});

test("the lead is told once per attempt, never twice while the same notice waits, and again once it was delivered", async () => {
  const p = project();
  writeFileSync(join(p.atoms, "b.txt"), "b\n");
  git(p.atoms, "add", ".");
  git(p.atoms, "commit", "-qm", "b");
  p.setLive([]);
  await assert.rejects(p.world.deleteTeam(p.team.id), /was told/);
  await assert.rejects(p.world.deleteTeam(p.team.id), /was told/);
  assert.equal(p.fromOffice().length, 1, "the same notice still waits for the lead");

  p.setLive([pane("p1", p.atoms, "s1"), pane("p2", join(p.atoms, "src"), "s2")]);
  await p.world.react();
  assert.equal(p.prompts.length, 1);
  assert.match(p.prompts[0]!.text, /^\[From the office\]\n\nThe founder wants to finish Atoms/);
  await assert.rejects(p.world.deleteTeam(p.team.id), /was told/);
  assert.equal(p.fromOffice().length, 2, "a new attempt after delivery tells the lead again");

  writeFileSync(join(p.atoms, "c.txt"), "c\n");
  await assert.rejects(p.world.deleteTeam(p.team.id), /1 uncommitted change .* and 1 commit not on dev/);
  assert.equal(p.fromOffice().length, 3, "a different notice is not a duplicate");
});

test("an offline lead is told when it is back; with nobody on the project to tell, the refusal says so", async () => {
  const repo = repository();
  const o = office();
  o.setLive([pane("p1", repo.atoms, "s1")]);
  const team = o.world.state().teams[0]!;
  o.setLive([]);
  const [lead] = o.world.state().agents;
  writeFileSync(join(repo.atoms, "b.txt"), "b\n");
  await assert.rejects(o.world.deleteTeam(team.id), new RegExp(`${lead!.name} was told to land it on dev \\(offline: it waits for them\\)\\.$`));
  o.world.removeAgent(lead!.id);
  await assert.rejects(o.world.deleteTeam(team.id), /No agent is there to tell\.$/);
});
