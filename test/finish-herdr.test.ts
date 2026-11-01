import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { PaneInfo, WorkspaceInfo } from "../src/server/finish-cleanup.ts";

// What finishing a project closes in herdr: the team's own panes and workspaces, never anyone else's.
// herdr is a fake that models panes and workspaces; nothing here talks to a real herdr.

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository `repo` (main checkout) with project worktrees `repo-atoms` and `repo-beta`. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "finish-herdr-")));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const atoms = join(dir, "repo-atoms");
  const beta = join(dir, "repo-beta");
  git(root, "worktree", "add", "-q", "-b", "worktree-atoms", atoms);
  git(root, "worktree", "add", "-q", "-b", "worktree-beta", beta);
  return { dir, root, atoms, beta };
}

interface FakePane { id: string; workspace: string; cwd: string; foreground?: string; agent?: { session: string; harness?: LiveAgent["harness"] } }
interface FakeWorkspace { id: string; label: string; checkoutPath: string | null; linked: boolean }

/** herdr as the office sees it: panes (agents and plain shells) in workspaces, and the commands that change them. */
function fakeHerdr(root: string) {
  const f = { panes: [] as FakePane[], workspaces: [] as FakeWorkspace[], closedPanes: [] as string[], closedWorkspaces: [] as string[], removed: [] as string[], up: true, listsPanes: true, groupRefusals: 0 };
  const info = (): WorkspaceInfo[] => f.workspaces.map((w) => ({
    workspaceId: w.id, label: w.label, paneCount: f.panes.filter((p) => p.workspace === w.id).length,
    checkoutPath: w.checkoutPath, repoRoot: w.checkoutPath ? root : null, linked: w.linked,
  }));
  const source: AgentSource = {
    available: () => f.up,
    live: () => f.panes.filter((p) => p.agent).map((p): LiveAgent => ({ paneId: p.id, harness: p.agent!.harness ?? "pi", sessionId: p.agent!.session, cwd: p.cwd, status: "idle", title: null, name: null })),
    prompt: async () => {},
    notify: async () => {},
    createWorktree: async (repoRoot, place) => {
      git(repoRoot, "worktree", "add", "-q", "-b", place.branch, place.path);
      const alreadyOpen = f.workspaces.some((w) => w.checkoutPath === repoRoot);
      if (!alreadyOpen) {
        f.workspaces.push({ id: "wJ", label: "repo", checkoutPath: repoRoot, linked: false });
        f.panes.push({ id: "wJ:p1", workspace: "wJ", cwd: repoRoot });
      }
      f.workspaces.push({ id: "w17", label: place.label, checkoutPath: place.path, linked: true });
      f.panes.push({ id: "w17:p1", workspace: "w17", cwd: place.path });
      return { paneId: "w17:p1", alsoOpened: alreadyOpen ? [] : ["wJ"] };
    },
    startAgent: async (paneId, _name, harness) => {
      f.panes.find((p) => p.id === paneId)!.agent = { session: `lead-${paneId}`, harness };
    },
    closePane: async (paneId) => {
      f.closedPanes.push(paneId);
      f.panes = f.panes.filter((p) => p.id !== paneId);
    },
    removeWorktree: async (repoRoot, path) => {
      f.removed.push(path);
      git(repoRoot, "worktree", "remove", "--force", path);
      const gone = f.workspaces.filter((w) => w.checkoutPath === path).map((w) => w.id);
      f.workspaces = f.workspaces.filter((w) => !gone.includes(w.id));
      f.panes = f.panes.filter((p) => !gone.includes(p.workspace));
    },
    panes: async () => {
      if (!f.listsPanes) throw new Error("pane list failed");
      return f.panes.map((p): PaneInfo => ({ paneId: p.id, workspaceId: p.workspace, tabId: `${p.workspace}:t1`, cwd: p.cwd, foregroundCwd: p.foreground ?? p.cwd }));
    },
    workspaces: async () => info(),
    closeWorkspace: async (id) => {
      const w = info().find((x) => x.workspaceId === id)!;
      // herdr refuses a main checkout's workspace while worktree workspaces of its repository are open.
      if (!w.linked && w.checkoutPath && info().some((x) => x.linked && x.repoRoot === w.repoRoot)) {
        f.groupRefusals++;
        throw new Error("workspace_group_close_required");
      }
      f.closedWorkspaces.push(id);
      f.workspaces = f.workspaces.filter((x) => x.id !== id);
      f.panes = f.panes.filter((p) => p.workspace !== id);
    },
  };
  return { f, source, ws: (id: string, label: string, checkoutPath: string | null = null, linked = false) => void f.workspaces.push({ id, label, checkoutPath, linked }), pane: (p: FakePane) => void f.panes.push(p) };
}

function office(root: string) {
  const db = openDatabase(":memory:");
  const h = fakeHerdr(root);
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "finish-herdr-files-")), "files"), presence);
  const world = new World(db, h.source, () => inbox.state());
  const founderLines = () => world.messages.list().filter((m) => m.fromOffice && m.toFounder).map((m) => m.text);
  return { db, world, h, founderLines };
}

const teamOf = (world: World, path: string) => world.state().teams.find((t) => t.path === path)!;
const byPane = (world: World, paneId: string) => world.state().agents.find((a) => a.paneId === paneId)!;

test("finishing closes the lead, the crew wherever they are, shells in the worktree and the workspaces that leaves empty, and keeps the founder's panes", async () => {
  const { root, atoms, dir } = repository();
  const { world, h, founderLines } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.ws("w30", "crew");
  h.ws("w31", "scratch");
  h.ws("wM", "repo", root);
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  h.pane({ id: "wA:p2", workspace: "wA", cwd: join(atoms, "src"), agent: { session: "s-crew1" } });
  h.pane({ id: "wA:p3", workspace: "wA", cwd: dir, foreground: join(atoms, "src") }); // a shell whose running process works in the worktree
  h.pane({ id: "w30:p1", workspace: "w30", cwd: join(atoms, "test"), agent: { session: "s-crew2" } }); // crew in another workspace
  h.pane({ id: "w30:p2", workspace: "w30", cwd: dir, agent: { session: "s-crew3" } }); // crew that cd'd away, placed on the team
  h.pane({ id: "w31:p1", workspace: "w31", cwd: dir }); // opened with inbox pane, nothing runs there yet
  h.pane({ id: "w31:p2", workspace: "w31", cwd: dir }); // the founder's shell beside it
  h.pane({ id: "wM:p1", workspace: "wM", cwd: root }); // the founder's shell in the shared main checkout
  world.state();
  const team = teamOf(world, atoms);
  world.updateAgent(byPane(world, "wA:p1").id, { teamId: team.id, role: "lead" });
  world.updateAgent(byPane(world, "w30:p2").id, { teamId: team.id, role: "member" });
  assert.equal(world.paneOpened({ harness: "pi", sessionId: "s-lead" }, "w31:p1").recorded, true);

  const result = await world.deleteTeam(team.id);

  assert.deepEqual(h.f.closedPanes.sort(), ["w30:p1", "w30:p2", "w31:p1", "wA:p1", "wA:p2", "wA:p3"]);
  assert.deepEqual(h.f.removed, [atoms]);
  assert.ok(!existsSync(atoms));
  assert.deepEqual(h.f.panes.map((p) => p.id).sort(), ["w31:p2", "wM:p1"], "the founder's two shells stay");
  assert.deepEqual(h.f.workspaces.map((w) => w.id).sort(), ["w31", "wM"], "the emptied crew workspace closed; the founder's stay");
  assert.deepEqual(h.f.closedWorkspaces, ["w30"]);
  assert.equal(result.closed.length, 7, "six panes and the workspace they emptied");
  assert.ok(result.closed.some((c) => /^workspace "crew" \(w30\), left empty$/.test(c)));
  assert.ok(result.closed.some((c) => /^a pane opened for the crew \(w31:p1\)$/.test(c)));
  assert.ok(result.left.some((l) => /workspace "scratch" \(w31\) is kept: 1 pane is still open in it that the office did not open/.test(l)));
  assert.ok(result.left.some((l) => /workspace "repo" \(wM\) on the main checkout is kept: the office did not open it for Atoms, so it is the founder's/.test(l)));
  assert.match(result.note, /Atoms is finished and .*repo-atoms removed\. .*Closed in herdr: .*Left in herdr: /);
  assert.deepEqual(founderLines(), [result.note], "the founder is told the same in a notice");
  assert.equal(world.state().teams.length, 0);
});

test("a workspace herdr opened for the main checkout when the office made the project closes with it, idle shell and all, and a founder's own stays", async () => {
  const { root } = repository();
  const { world, h } = office(root);
  // The founder has no workspace for the repository: making the project opens one.
  const team = await world.createTeam({ name: "Motion", repository: root });
  assert.deepEqual(h.f.workspaces.map((w) => w.id), ["wJ", "w17"]);
  assert.equal(byPane(world, "w17:p1").role, "lead");

  const result = await world.deleteTeam(team.id);

  assert.deepEqual(h.f.workspaces, [], "no workspace is left behind");
  assert.deepEqual(h.f.panes, []);
  assert.deepEqual(h.f.closedWorkspaces, ["wJ"]);
  assert.ok(result.closed.some((c) => /^workspace "repo" \(wJ\), opened by the office for Motion \(its idle shell wJ:p1 went with it\)$/.test(c)), result.closed.join("|"));
  assert.deepEqual(result.left, []);
  assert.match(result.note, /Closed in herdr: .*wJ/);
});

test("a main checkout's workspace is the founder's when the office did not open it", async () => {
  const { root } = repository();
  const { world, h } = office(root);
  h.ws("wF", "repo", root);
  h.pane({ id: "wF:p1", workspace: "wF", cwd: root });
  const team = await world.createTeam({ name: "Motion", repository: root });
  const result = await world.deleteTeam(team.id);
  assert.deepEqual(h.f.workspaces.map((w) => w.id), ["wF"]);
  assert.deepEqual(h.f.panes.map((p) => p.id), ["wF:p1"]);
  assert.deepEqual(h.f.closedWorkspaces, []);
  assert.ok(result.left.some((l) => /workspace "repo" \(wF\) on the main checkout is kept: the office did not open it for Motion, so it is the founder's/.test(l)));
});

test("a team on the main checkout: only what the records give it closes, the founder's shell and another team's agent in the same checkout stay", async () => {
  const { root, beta } = repository();
  const { world, db, h } = office(root);
  h.ws("wM", "repo", root);
  h.ws("wB", "Beta", beta, true);
  h.pane({ id: "wM:p1", workspace: "wM", cwd: root, agent: { session: "s-lead" } }); // the team's lead, working in the main checkout
  h.pane({ id: "wM:p2", workspace: "wM", cwd: root }); // opened for the crew
  h.pane({ id: "wM:p3", workspace: "wM", cwd: root }); // the founder's shell
  h.pane({ id: "wM:p4", workspace: "wM", cwd: root, agent: { session: "s-other" } }); // another team's agent
  h.pane({ id: "wB:p1", workspace: "wB", cwd: beta, agent: { session: "s-beta" } });
  world.state();
  const betaTeam = teamOf(world, beta);
  world.updateAgent(byPane(world, "wB:p1").id, { teamId: betaTeam.id, role: "lead" });
  world.updateAgent(byPane(world, "wM:p4").id, { teamId: betaTeam.id, role: "member" });
  // A team whose own folder is the main checkout (the office never makes one, but a record can say so).
  db.prepare("INSERT INTO teams (id, name, purpose, path, branch, standing, created_at) VALUES ('t-main', 'Main', '', ?, 'main', 0, ?)").run(root, new Date().toISOString());
  world.updateAgent(byPane(world, "wM:p1").id, { teamId: "t-main", role: "lead" });
  world.paneOpened({ harness: "pi", sessionId: "s-lead" }, "wM:p2");

  const result = await world.deleteTeam("t-main");

  assert.deepEqual(h.f.closedPanes.sort(), ["wM:p1", "wM:p2"]);
  assert.deepEqual(h.f.removed, [], "the main checkout is not a worktree and stays");
  assert.ok(existsSync(root));
  assert.deepEqual(h.f.panes.map((p) => p.id).sort(), ["wB:p1", "wM:p3", "wM:p4"]);
  assert.match(result.note, /kept \(it is the repository's main checkout\)/);
  assert.ok(result.left.some((l) => /workspace "repo" \(wM\) is kept: an agent or pane that is not Main's still runs in it/.test(l)), result.left.join("|"));
});

test("another team's pane in the same repository is kept, and the workspace shared by the repository closes with the last project", async () => {
  const { root, atoms, beta } = repository();
  const { world, h } = office(root);
  const motion = await world.createTeam({ name: "Motion", repository: root });
  assert.ok(motion.path);
  h.ws("wB", "Beta", beta, true);
  h.pane({ id: "wB:p1", workspace: "wB", cwd: beta, agent: { session: "s-beta" } });
  h.pane({ id: "wB:p2", workspace: "wB", cwd: beta });
  world.state();
  const betaTeam = teamOf(world, beta);
  world.updateAgent(byPane(world, "wB:p1").id, { teamId: betaTeam.id, role: "lead" });
  world.paneOpened({ harness: "pi", sessionId: "s-beta" }, "wB:p2");

  const first = await world.deleteTeam(motion.id);
  assert.deepEqual(h.f.panes.map((p) => p.id).sort(), ["wB:p1", "wB:p2", "wJ:p1"], "Beta's panes are untouched");
  assert.deepEqual(h.f.workspaces.map((w) => w.id).sort(), ["wB", "wJ"]);
  assert.equal(h.f.groupRefusals, 0, "it did not even try while Beta's workspace is open");
  assert.ok(first.left.some((l) => /workspace "repo" \(wJ\) is kept: herdr groups it with the repository's other project workspaces/.test(l)));

  const last = await world.deleteTeam(betaTeam.id);
  assert.deepEqual(h.f.workspaces, [], "Beta was the last project there, so the workspace opened for Motion closes now");
  assert.ok(last.closed.some((c) => /workspace "repo" \(wJ\), opened by the office for Motion/.test(c)) || last.closed.some((c) => /\(wJ\)/.test(c)), last.closed.join("|"));
  void atoms;
});

test("another team's agent working inside the worktree refuses finishing before anything is closed", async () => {
  const { root, atoms } = repository();
  const { world, h } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  h.pane({ id: "wA:p2", workspace: "wA", cwd: atoms, agent: { session: "s-visitor" } });
  world.state();
  const team = teamOf(world, atoms);
  world.updateAgent(byPane(world, "wA:p1").id, { teamId: team.id, role: "lead" });
  const other = await world.createTeam({ name: "Elsewhere", standing: true });
  world.updateAgent(byPane(world, "wA:p2").id, { teamId: other.id, role: "member" });
  await assert.rejects(world.deleteTeam(team.id), (err: Error & { status?: number }) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /Atoms cannot be finished: .* belongs to Elsewhere and works in .*repo-atoms, which is being removed/);
    return true;
  });
  assert.deepEqual(h.f.closedPanes, []);
  assert.deepEqual(h.f.removed, []);
});

test("the office's own pane is never closed", async () => {
  const { root, atoms, dir } = repository();
  const { world, h } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.ws("wO", "office");
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  h.pane({ id: "wO:p1", workspace: "wO", cwd: dir });
  h.pane({ id: "wO:p2", workspace: "wO", cwd: dir, agent: { session: "s-crew" } });
  world.state();
  const team = teamOf(world, atoms);
  world.updateAgent(byPane(world, "wA:p1").id, { teamId: team.id, role: "lead" });
  world.updateAgent(byPane(world, "wO:p2").id, { teamId: team.id, role: "member" });
  const before = process.env.HERDR_PANE_ID;
  process.env.HERDR_PANE_ID = "wO:p1";
  try {
    const result = await world.deleteTeam(team.id);
    assert.deepEqual(h.f.closedPanes.sort(), ["wA:p1", "wO:p2"]);
    assert.ok(h.f.panes.some((p) => p.id === "wO:p1"));
    assert.ok(result.left.some((l) => /workspace "office" \(wO\) is kept/.test(l)) || h.f.workspaces.some((w) => w.id === "wO"));
  } finally {
    if (before === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = before;
  }
});

test("without herdr nothing is closed or removed, and the refusal says what stays", async () => {
  const { root, atoms } = repository();
  const { world, h } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  world.state();
  const team = teamOf(world, atoms);
  h.f.up = false;
  await assert.rejects(world.deleteTeam(team.id), (err: Error & { status?: number }) => {
    assert.equal(err.status, 409);
    assert.match(err.message, /herdr is not running: nothing was closed or removed, and Atoms's panes and workspaces stay as they are/);
    return true;
  });
  assert.deepEqual(h.f.closedPanes, []);
  assert.ok(existsSync(atoms));
  assert.equal(world.state().teams.length, 1, "the team is still there");
});

test("a project whose folder is no longer a checkout still has its panes closed, or says what is left when herdr is down", async () => {
  const { root, dir } = repository();
  for (const up of [true, false]) {
    const { world, db, h } = office(root);
    const folder = join(dir, up ? "plain-up" : "plain-down");
    execFileSync("mkdir", ["-p", folder]);
    h.ws("wP", "Plain");
    h.pane({ id: "wP:p1", workspace: "wP", cwd: folder, agent: { session: "s-lead" } });
    h.pane({ id: "wP:p2", workspace: "wP", cwd: dir }); // the founder's shell
    db.prepare("INSERT INTO teams (id, name, purpose, path, branch, standing, created_at) VALUES ('t-plain', 'Plain', '', ?, NULL, 0, ?)").run(folder, new Date().toISOString());
    world.state();
    h.f.up = up;
    const result = await world.deleteTeam("t-plain");
    assert.match(result.note, /^Plain is finished; its worktree was already gone\./);
    if (up) {
      assert.deepEqual(h.f.closedPanes, ["wP:p1"]);
      assert.ok(result.left.some((l) => /workspace "Plain" \(wP\) is kept: 1 pane is still open in it/.test(l)), result.left.join("|"));
    } else {
      assert.deepEqual(h.f.closedPanes, []);
      assert.deepEqual(result.left, ["herdr is not running, so none of its panes or workspaces was looked at"]);
      assert.match(result.note, /Left in herdr: herdr is not running/);
    }
  }
});

test("when herdr cannot list panes the shells are not looked for, and that is said", async () => {
  const { root, atoms } = repository();
  const { world, h } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  h.pane({ id: "wA:p2", workspace: "wA", cwd: atoms });
  world.state();
  const team = teamOf(world, atoms);
  h.f.listsPanes = false;
  const result = await world.deleteTeam(team.id);
  assert.deepEqual(h.f.closedPanes, ["wA:p1"], "only the agent herdr's agent list shows");
  assert.ok(result.left.some((l) => /herdr's pane list could not be read \(pane list failed\), so plain shells were not looked for/.test(l)));
});

test("when only the worktree's own panes closed, the founder's notice is one short line, while the result still has the detail", async () => {
  const { root, atoms } = repository();
  const { world, h, founderLines } = office(root);
  h.ws("wA", "Atoms", atoms, true);
  h.pane({ id: "wA:p1", workspace: "wA", cwd: atoms, agent: { session: "s-lead" } });
  h.pane({ id: "wA:p2", workspace: "wA", cwd: join(atoms, "src"), agent: { session: "s-crew" } });
  world.state();
  const team = teamOf(world, atoms);
  const result = await world.deleteTeam(team.id);
  assert.equal(result.closed.length, 2);
  assert.deepEqual(result.left, []);
  assert.match(result.note, /Closed in herdr: .*wA:p1/);
  assert.deepEqual(founderLines(), ["Atoms is finished: its worktree removed, 2 panes closed."]);
});
