import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox } from "../src/server/inbox.ts";
import { LEAD_WATCH_SESSION } from "../src/server/leadwatch.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

// A Claude Code desktop session (no herdr pane) says hello, makes a project it leads itself, and is never replaced as
// its lead while it is idle between turns.

const MINUTE = 60_000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A temp folder with a repository whose main checkout `repo` is on `dev`, and a plain folder `plain`. */
function repository(t: { after: (fn: () => void) => void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "desktop-team-")));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "dev", root]);
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const plain = join(dir, "plain");
  execFileSync("mkdir", [plain]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, plain };
}

/** An office whose herdr is off unless `herdr` is set; it records every worktree and agent start asked of herdr. */
function office(t: { after: (fn: () => void) => void }, herdr = false) {
  const db = openDatabase(":memory:");
  let at = Date.parse("2026-11-09T09:00:00Z");
  const now = () => new Date(at);
  const files = mkdtempSync(join(tmpdir(), "desktop-team-files-"));
  const inbox = new Inbox(db, join(files, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }, now);
  const live: LiveAgent[] = [];
  const asked = { worktrees: [] as string[], starts: [] as string[] };
  const source: AgentSource = {
    available: () => herdr,
    live: () => live,
    prompt: async () => {},
    notify: async () => {},
    createWorktree: async (repoRoot, place) => {
      asked.worktrees.push(place.path);
      git(repoRoot, "worktree", "add", "-q", "-b", place.branch, place.path, ...(place.base ? [place.base] : []));
      return { paneId: "herdr-root" };
    },
    startAgent: async (paneId) => { asked.starts.push(paneId); },
    closePane: async () => {},
    removeWorktree: async () => {},
  };
  const world = new World(db, source, () => inbox.state(), now);
  world.leadWatch.inbox = inbox;
  t.after(() => { db.close(); rmSync(files, { recursive: true, force: true }); });
  return { db, inbox, world, live, asked, pass: (minutes: number) => { at += minutes * MINUTE; } };
}

const desktop = (cwd: string, sessionId = "desk-1") => ({ harness: "claude" as const, sessionId, cwd });

test("hello makes a desktop session known without a task, and saying it again changes nothing", (t) => {
  const { root } = repository(t);
  const o = office(t);
  assert.throws(() => o.world.brief(desktop(root)), /does not know this session/);

  const first = o.world.hello(desktop(root));
  assert.equal(first.team, null, "a main checkout puts it on no project");
  assert.equal(o.inbox.state().tasks.length, 0, "no inbox task is made");
  assert.match(o.world.brief(desktop(root)).text, new RegExp(`You are ${first.name}`), "later calls resolve it");

  const again = o.world.hello(desktop(root));
  assert.deepEqual(again, first);
  assert.equal(o.world.state().agents.length, 1);
});

test("hello from a linked worktree joins that worktree's project, as anyone working there does", (t) => {
  const { dir, root } = repository(t);
  const o = office(t);
  const tree = join(dir, "repo-search");
  git(root, "worktree", "add", "-q", "-b", "worktree-search", tree);
  const me = o.world.hello(desktop(tree));
  assert.equal(me.team?.path, tree);
  assert.equal(me.team?.branch, "worktree-search");
});

test("with herdr off, team create makes the worktree and branch with git and seats the caller as lead; nothing is started", async (t) => {
  const { dir, root } = repository(t);
  const o = office(t);
  const { team } = await o.world.createDesktopTeam(desktop(root), { name: "Note search", purpose: "Search the notes" });
  assert.equal(team.path, join(dir, "repo-note-search"));
  assert.equal(team.branch, "worktree-note-search");
  assert.ok(existsSync(join(team.path, "a.txt")), "the worktree is checked out");
  assert.equal(git(team.path, "rev-parse", "--abbrev-ref", "HEAD"), "worktree-note-search");
  assert.equal(git(team.path, "rev-parse", "HEAD"), git(root, "rev-parse", "dev"), "branched from the main checkout's branch");
  assert.deepEqual(o.asked, { worktrees: [], starts: [] }, "herdr is not asked for anything");

  const state = o.world.state();
  const lead = state.agents.filter((a) => a.teamId === team.id);
  assert.deepEqual(lead.map((a) => [a.cwd, a.role]), [[root, "lead"]], "the caller, and only the caller, leads it");
  assert.equal(state.teams.find((x) => x.id === team.id)?.purpose, "Search the notes");
  assert.equal(o.world.hello(desktop(root)).team?.id, team.id, "hello now names its team");
});

test("with herdr running, team create opens the worktree through herdr but starts no agent", async (t) => {
  const { dir, root } = repository(t);
  const o = office(t, true);
  const { team } = await o.world.createDesktopTeam(desktop(root), { name: "Atlas" });
  assert.deepEqual(o.asked, { worktrees: [join(dir, "repo-atlas")], starts: [] });
  assert.equal(o.world.state().agents.find((a) => a.teamId === team.id)?.role, "lead");
});

test("team create refuses a taken name, an existing folder and a folder outside any repository", async (t) => {
  const { dir, root, plain } = repository(t);
  const o = office(t);
  await o.world.createDesktopTeam(desktop(root), { name: "Atlas" });
  await assert.rejects(o.world.createDesktopTeam(desktop(root, "desk-2"), { name: "atlas" }), (e: { status: number; code: string }) => e.status === 409 && e.code === "name_taken");
  execFileSync("mkdir", [join(dir, "repo-orbit")]);
  await assert.rejects(o.world.createDesktopTeam(desktop(root), { name: "Orbit" }), (e: { status: number; code: string }) => e.status === 409 && e.code === "folder_exists");
  await assert.rejects(o.world.createDesktopTeam(desktop(plain), { name: "Comet" }), (e: { status: number; code: string }) => e.status === 400 && e.code === "not_a_repository");
  assert.equal(o.world.state().teams.length, 1);
});

test("an idle desktop lead is never replaced: its stall offers nobody, asks the founder nothing and says when it last spoke", async (t) => {
  const { root } = repository(t);
  const o = office(t);
  const { team } = await o.world.createDesktopTeam(desktop(root), { name: "Atlas" });
  // A crew member runs in the project's worktree under herdr, and another project's agent runs in the main checkout beside the lead.
  o.live.push({ paneId: "p1", harness: "claude", sessionId: "crew-1", cwd: team.path, status: "idle", title: null, name: "crew" });
  o.live.push({ paneId: "p2", harness: "pi", sessionId: "other-1", cwd: root, status: "working", title: null, name: null });
  const crew = o.world.state().agents.find((a) => a.paneId === "p1")!;
  assert.deepEqual([crew.teamId, crew.role], [team.id, "member"]);

  const lead = o.world.state().agents.find((a) => a.teamId === team.id && a.role === "lead")!;
  assert.equal(lead.status, "offline", "herdr never sees a desktop session running");
  o.world.messages.say(crew, { to: lead.name, text: "Done with the parser." });
  o.pass(15);
  o.world.leadWatch.tick(o.world.state());

  const after = o.world.state();
  const stall = after.teams.find((x) => x.id === team.id)!.stalled!;
  assert.deepEqual(stall.candidates, [], "nobody is offered as a replacement");
  assert.equal(stall.leadLastSpokeAt, "2026-11-09T09:00:00.000Z");
  assert.equal(after.agents.find((a) => a.id === lead.id)?.role, "lead", "still the lead");
  assert.equal(after.agents.find((a) => a.id === crew.id)?.role, "member", "the running member is not made lead");
  const asked = o.inbox.state().items.filter((i) => o.inbox.task(i.taskId).binding.sessionId === LEAD_WATCH_SESSION.sessionId);
  assert.equal(asked.length, 0, "the founder is not asked to make someone else lead");
  assert.match(o.world.brief({ harness: "claude", sessionId: "crew-1", cwd: team.path, paneId: "p1" }).text, /last spoke to the office 15 min ago.*It is not replaced/);

  // Speaking again moves the time it last spoke.
  o.world.hello(desktop(root));
  o.pass(1);
  o.world.leadWatch.tick(o.world.state());
  assert.equal(o.world.state().teams.find((x) => x.id === team.id)!.stalled!.leadLastSpokeAt, "2026-11-09T09:15:00.000Z");
});

test("the HTTP routes answer hello and team create, with {error, code} for a taken name", async (t) => {
  const { root } = repository(t);
  const o = office(t);
  // The service checks the Host header against its own port, so find a free one first.
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done) => probe.close(() => done()));
  const server = createInboxServer(o.inbox, null, { port, staticDir: null, world: o.world });
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const hello = await post("/api/agent/hello", { session: desktop(root) });
  assert.equal(hello.status, 200);
  assert.equal((await hello.json() as { team: unknown }).team, null);
  const made = await post("/api/agent/team/create", { session: desktop(root), name: "Atlas" });
  assert.equal(made.status, 200);
  assert.equal((await made.json() as { team: { branch: string } }).team.branch, "worktree-atlas");
  const taken = await post("/api/agent/team/create", { session: desktop(root), name: "Atlas" });
  assert.equal(taken.status, 409);
  assert.equal((await taken.json() as { code: string }).code, "name_taken");
});
