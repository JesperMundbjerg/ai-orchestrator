// A standing team made with New project works like Mission Control by default: a read-only lead
// started in the repository's main checkout, which hands each worker a worktree of its own made
// through herdr (`inbox pane --worktree`). herdr is a fake here: no real pane or agent starts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import { STANDING_LEAD_ROLE } from "../src/server/leadrole.ts";
import { mergePaths, paneEnvArgs } from "../src/shared/shellpath.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository on `dev` with one commit. */
function repository() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "standing-lead-")));
  const root = join(dir, "shuttle");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  return { dir, root };
}

function setup(opts: { available?: boolean; workspace?: { root: string; pane: string } } = {}) {
  const db = openDatabase(":memory:");
  let live: LiveAgent[] = [];
  const presence: PresenceSource = { available: () => true, forSession: () => null, resolvePane: () => null };
  const inbox = new Inbox(db, join(mkdtempSync(join(tmpdir(), "standing-lead-files-")), "files"), presence);
  const opened: Array<{ cwd: string; beside: string | null }> = [];
  const started: Array<{ pane: string; name: string; harness: string; args: string[] }> = [];
  const worktrees: Array<{ repoRoot: string; path: string; branch: string; base: string | null }> = [];
  const prompts: Array<{ pane: string; text: string }> = [];
  const closed: string[] = [];
  let startFails: string | null = null;
  const source: AgentSource = {
    available: () => opts.available ?? true,
    live: () => live,
    prompt: async (pane, text) => void prompts.push({ pane, text }),
    notify: async () => {},
    // herdr makes the worktree the way it does for a project: with git, past any hook on `git worktree add` by hand.
    createWorktree: async (repoRoot, place) => {
      worktrees.push({ repoRoot, ...place });
      git(repoRoot, "worktree", "add", "-q", "-b", place.branch, place.path, ...(place.base ? [place.base] : []));
      return { paneId: `wt:${place.branch}` };
    },
    openPane: async (cwd, beside) => {
      opened.push({ cwd, beside });
      return "w1:p9";
    },
    workspaces: async () => opts.workspace ? [{ workspaceId: "w1", label: "shuttle", paneCount: 1, checkoutPath: opts.workspace.root, repoRoot: opts.workspace.root, linked: false }] : [],
    panes: async () => opts.workspace ? [{ paneId: opts.workspace.pane, workspaceId: "w1", tabId: "t1", cwd: opts.workspace.root, foregroundCwd: null }] : [],
    startAgent: async (pane, name, harness, args) => {
      started.push({ pane, name, harness, args });
      if (startFails) throw new Error(startFails);
    },
    closePane: async (pane) => void closed.push(pane),
    removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state());
  return { db, world, opened, started, worktrees, prompts, closed, setLive: (next: LiveAgent[]) => void (live = next), failStart: (why: string | null) => void (startFails = why) };
}

const claude = (paneId: string, cwd: string, name: string | null = null): LiveAgent =>
  ({ paneId, harness: "claude", sessionId: `s-${paneId}`, cwd, status: "idle", title: null, name });

const systemPrompt = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1] ?? "";

test("a standing team made with a repository starts a read-only lead in its main checkout, in a pane of that checkout's workspace", async () => {
  const { root } = repository();
  const h = setup({ workspace: { root, pane: "w1:p1" } });
  const team = await h.world.createTeam({ name: "Cosmology finish", standing: true, purpose: "Answer the founder's page comments", repository: root });

  assert.equal(team.standing, true);
  assert.equal(team.path, null, "a standing team has no worktree of its own");
  assert.deepEqual(h.opened, [{ cwd: root, beside: "w1:p1" }], "a new pane beside the repository's open workspace");
  assert.equal(h.started.length, 1);
  const start = h.started[0]!;
  assert.equal(start.pane, "w1:p9");
  assert.equal(start.name, "lead-cosmology-finish");
  assert.ok(start.args.includes("--settings"), "Claude Code gets the inbox hook for this session");
  const brief = systemPrompt(start.args);
  assert.match(brief, /main checkout .*shuttle \(branch dev\), which you only read/);
  assert.ok(brief.includes(STANDING_LEAD_ROLE.split(" ").slice(0, 8).join(" ")), "the default standing lead role");
  assert.match(brief, /pane --worktree <slug>/, "how to give a worker its own worktree");
  assert.deepEqual(h.prompts, [{ pane: "w1:p9", text: "Start on the team's work: Answer the founder's page comments" }]);

  // Whoever runs in that pane leads the team, though the main checkout makes nobody a project member.
  h.setLive([claude("w1:p9", root, "lead-cosmology-finish")]);
  const lead = h.world.state().agents.find((a) => a.paneId === "w1:p9")!;
  assert.deepEqual([lead.teamId, lead.role], [team.id, "lead"]);
});

test("without an open workspace for the checkout the lead gets a workspace of its own", async () => {
  const { root } = repository();
  const h = setup();
  await h.world.createTeam({ name: "Cosmology", standing: true, repository: root });
  assert.deepEqual(h.opened, [{ cwd: root, beside: null }]);
});

test("a standing team is refused with nothing made when herdr is not running, or when its lead does not start", async () => {
  const { root } = repository();
  const off = setup({ available: false });
  await assert.rejects(off.world.createTeam({ name: "Cosmology", standing: true, repository: root }), /herdr is not running/);
  assert.deepEqual(off.world.state().teams, []);
  assert.deepEqual(off.opened, []);

  const h = setup();
  h.failStart("timed out waiting for agent");
  await assert.rejects(h.world.createTeam({ name: "Cosmology", standing: true, repository: root }), /was not made: no lead started/);
  assert.deepEqual(h.world.state().teams, [], "no half-made team");
  assert.deepEqual(h.closed, ["w1:p9"], "the pane opened for it is closed");
});

test("a standing team without a role of its own gets the default lead role; its own role replaces it; a project never gets it", async () => {
  const { root } = repository();
  const h = setup();
  const named = await h.world.createTeam({ name: "Dispatch", standing: true });
  assert.ok(h.world.leadStart(named).includes(`Dispatch's lead role, the office's default for a standing team until the founder sets one: ${STANDING_LEAD_ROLE}`));
  const own = h.world.updateTeam(named.id, { leadRole: "Route comments to the lanes." });
  const brief = h.world.leadStart(own);
  assert.ok(!brief.includes(STANDING_LEAD_ROLE));
  assert.match(brief, /Route comments to the lanes\./);
  const project = await h.world.createTeam({ name: "Atoms", repository: root });
  assert.ok(!h.world.leadStart(project).includes(STANDING_LEAD_ROLE));
});

test("a new standing team inherits the merge instruction of another standing team in the same repository", async () => {
  const { dir, root } = repository();
  const lane = join(dir, "shuttle-einstein");
  git(root, "worktree", "add", "-q", "-b", "worktree-einstein", lane);
  const h = setup();
  const mc = await h.world.createTeam({ name: "Mission Control", standing: true });
  h.world.addWorktree(mc.id, lane);
  h.world.updateTeam(mc.id, { mergeInstruction: "Land with: land <checkout> <sha>", mergeInstructionPath: ".claude/commands/worktree-sync.md" });

  const team = await h.world.createTeam({ name: "Cosmology", standing: true, repository: root });
  assert.equal(team.mergeInstruction, "Land with: land <checkout> <sha>");
  assert.equal(team.mergeInstructionPath, ".claude/commands/worktree-sync.md");

  const other = repository();
  const elsewhere = await h.world.createTeam({ name: "Elsewhere", standing: true, repository: other.root });
  assert.equal(elsewhere.mergeInstructionPath, "", "another repository's instruction is not inherited");
});

test("inbox pane --worktree makes a worker's own worktree through herdr from the lead's branch, and makes it the team's", async () => {
  const { dir, root } = repository();
  git(root, "checkout", "-q", "-b", "release");
  const h = setup();
  const team = await h.world.createTeam({ name: "Cosmology", standing: true, repository: root });
  h.setLive([claude("w1:p9", root, "lead-cosmology")]);

  const made = await h.world.openWorktree({ paneId: "w1:p9" }, "cosmo-intro");
  const path = join(dir, "shuttle-cosmo-intro");
  assert.deepEqual(made, { paneId: "wt:worktree-cosmo-intro", path, branch: "worktree-cosmo-intro", base: "release" });
  assert.deepEqual(h.worktrees, [{ repoRoot: root, path, branch: "worktree-cosmo-intro", base: "release", label: "cosmo-intro" }]);
  assert.deepEqual(h.world.state().teams.find((t) => t.id === team.id)!.worktrees, [path]);

  // The worker who starts there is on the team, as crew.
  h.setLive([claude("w1:p9", root, "lead-cosmology"), claude("wt:worktree-cosmo-intro", path, "kepler")]);
  const worker = h.world.state().agents.find((a) => a.paneId === "wt:worktree-cosmo-intro")!;
  assert.deepEqual([worker.teamId, worker.role], [team.id, "member"]);

  await assert.rejects(h.world.openWorktree({ paneId: "w1:p9" }, "cosmo-intro"), /already exists/);
  assert.equal(h.worktrees.length, 1);
});

test("inbox pane --worktree is refused for someone on no team, before anything is made", async () => {
  const { root } = repository();
  const h = setup();
  h.setLive([claude("w1:p3", root)]);
  await assert.rejects(h.world.openWorktree({ paneId: "w1:p3" }, "loner"), /on no team/);
  assert.deepEqual(h.worktrees, []);
});

test("inbox say reaches a running agent by its herdr name when only one has it, and inbox team shows that name", async () => {
  const { dir, root } = repository();
  const h = setup();
  const team = await h.world.createTeam({ name: "Cosmology", standing: true, repository: root });
  const path = join(dir, "shuttle-intro");
  git(root, "worktree", "add", "-q", "-b", "worktree-intro", path);
  h.world.addWorktree(team.id, path);
  h.setLive([claude("w1:p9", root, "lead-cosmology"), claude("w1:p2", path, "kepler")]);
  const state = h.world.state();
  const lead = state.agents.find((a) => a.paneId === "w1:p9")!;
  const kepler = state.agents.find((a) => a.paneId === "w1:p2")!;
  assert.notEqual(kepler.name.toLowerCase(), "kepler", "the office gives agents its own names");

  const message = h.world.messages.say(lead, { to: "Kepler", text: "Start on the intro chapter." });
  assert.deepEqual(message.deliveries.map((d) => d.agentId), [kepler.id]);
  assert.match(h.world.brief({ paneId: "w1:p9" }).text, new RegExp(`${kepler.name} \\(herdr kepler\\)`));

  // Two panes with one herdr name: nobody is guessed.
  h.setLive([claude("w1:p9", root, "lead-cosmology"), claude("w1:p2", path, "kepler"), claude("w1:p4", path, "kepler")]);
  assert.throws(() => h.world.messages.say(lead, { to: "kepler", text: "?" }), /nobody called kepler/);
});

test("a new pane's PATH is the opener's with what the login shell adds, each folder once", () => {
  assert.equal(mergePaths("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin", null, ""), "/usr/bin:/bin:/opt/homebrew/bin");
  assert.deepEqual(paneEnvArgs("/opt/homebrew/bin:/usr/bin"), ["--env", "PATH=/opt/homebrew/bin:/usr/bin"]);
  assert.deepEqual(paneEnvArgs(""), []);
});

test("a pane the office opens is given that PATH through herdr", async () => {
  const { Herdr } = await import("../src/server/herdr.ts");
  const { chmodSync, readFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "standing-lead-herdr-"));
  const log = join(dir, "args");
  const bin = join(dir, "herdr");
  // A stand-in herdr that records its arguments, one per line, and answers as `workspace create` does.
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\necho '{"result":{"root_pane":{"pane_id":"w9:p1"}}}'\n`);
  chmodSync(bin, 0o755);
  const shell = process.env.SHELL;
  process.env.SHELL = "/usr/bin/false"; // no login shell to ask here: the PATH is this process's own
  try {
    const pane = await new Herdr(bin, join(dir, "unused.sock")).openPane("/repo", null, "lead");
    assert.equal(pane, "w9:p1");
  } finally {
    process.env.SHELL = shell;
  }
  const args = readFileSync(log, "utf8").split("\n");
  assert.equal(args[args.indexOf("--env") + 1], `PATH=${mergePaths(process.env.PATH)}`);
});
