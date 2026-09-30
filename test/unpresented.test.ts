import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { Unpresented, migrateUnpresented } from "../src/server/unpresented.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const minute = 60_000;
function setup(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "unpresented-")));
  const root = join(dir, "repo");
  execFileSync("git", ["init", "-q", "-b", "base", root]);
  git(root, "commit", "--allow-empty", "-qm", "Base");
  const path = join(dir, "repo-video");
  git(root, "worktree", "add", "-qb", "worktree-video", path);
  let time = Date.parse("2026-06-01T00:00:00Z");
  const db = openDatabase(join(dir, "inbox.sqlite"));
  const live: LiveAgent[] = [{ paneId: "p1", sessionId: "lead", name: "lead", cwd: path, harness: "pi", status: "idle", title: null }];
  const prompts: string[] = [];
  const source: AgentSource = {
    available: () => true, live: () => live,
    prompt: async (_pane, text) => { prompts.push(text); }, notify: async () => {},
    createWorktree: async () => ({ paneId: "p" }), startAgent: async () => {}, closePane: async () => {}, removeWorktree: async () => {},
  };
  const inbox = new Inbox(db, join(dir, "files"), {
    available: () => true, resolvePane: () => null,
    forSession: (_h, s) => { const a = live.find((a) => a.sessionId === s); return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null; },
  }, () => new Date(time));
  const world = new World(db, source, () => inbox.state(), () => new Date(time));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const commit = (title = "Tutor-free cut") => { git(path, "commit", "--allow-empty", "-qm", title); return git(path, "rev-parse", "HEAD"); };
  const post = (type: "milestone" | "try" | "decide" = "milestone", title = "Video checked", sessionId = "crew") => inbox.submit({
    session: { harness: "pi", sessionId, cwd: path },
    item: { key: "video", type, title, blocking: false, ...(type === "try" ? { preview: { url: "http://localhost:4921/demo" } } : {}) },
  });
  const notices = () => world.state().messages.filter((m) => m.fromOffice);
  return { db, inbox, world, path, root, live, prompts, commit, post, notices, now: () => time, advance: (ms: number) => { time += ms; } };
}

test("submission and revisions capture HEAD from any crew; latest presentation wins, including identical prose at a new HEAD", (t) => {
  const f = setup(t);
  const one = f.commit();
  const a = f.post();
  assert.equal(f.inbox.item(a.itemId).presentedHead, one);
  assert.equal(f.post().changed, false);
  const two = f.commit("Second cut");
  const revised = f.post();
  assert.equal(revised.revision, 2);
  assert.equal(f.inbox.item(a.itemId).presentedHead, two);
  f.post("try", "Try it", "another-crew");
  assert.equal((f.db.prepare("SELECT presented_head FROM unpresented_work WHERE path = ?").get(f.path) as { presented_head: string }).presented_head, two);
  const old = f.db.prepare("SELECT snapshot FROM item_revisions WHERE item_id = ? AND revision = 1").get(a.itemId) as { snapshot: string };
  assert.equal(JSON.parse(old.snapshot).presentedHead, one);
});

test("count subtracts both base and presented ancestry; cache responds to base merges and presentations", (t) => {
  const f = setup(t);
  const tracker = new Unpresented(f.db);
  f.commit(); f.commit("Second");
  assert.equal(tracker.sample(f.path, f.now())?.count, 2);
  f.post();
  assert.equal(tracker.sample(f.path, f.now())?.count, 0);
  f.commit("Third"); f.advance(minute);
  assert.equal(tracker.sample(f.path, f.now())?.count, 1);
  git(f.root, "merge", "--ff-only", "worktree-video"); f.advance(minute);
  assert.equal(tracker.sample(f.path, f.now())?.count, 0);
  // A rewrite does not treat the old presented point as a linear range.
  git(f.path, "reset", "--hard", "HEAD~2"); f.commit("Rewritten"); f.advance(minute);
  assert.equal(tracker.sample(f.path, f.now())?.count, 1);
});

test("only five continuous idle/done minutes trigger an office message, delivered through the ordinary terminal path", async (t) => {
  const f = setup(t); f.commit();
  await f.world.react();
  f.advance(4 * minute); await f.world.react(); assert.equal(f.notices().length, 0);
  f.live[0]!.status = "working"; await f.world.react();
  f.advance(10 * minute); await f.world.react(); assert.equal(f.notices().length, 0);
  f.live[0]!.status = "done"; await f.world.react();
  f.advance(5 * minute - 1); await f.world.react(); assert.equal(f.notices().length, 0);
  f.advance(1); await f.world.react();
  assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0]!.fromAgentId, null);
  assert.match(f.prompts[0]!, /\[From the office\]/);
  assert.match(f.prompts[0]!, /Unpresented work: 1 commit.*Tutor-free cut/);
  assert.equal(f.notices()[0]!.deliveries[0]!.state, "delivered");
  assert.equal(f.world.state().teams[0]!.unpresentedCommits, 1);
});

test("30-minute per-project throttle persists; say founder suppresses same HEAD but not a new commit", async (t) => {
  const f = setup(t); f.commit(); await f.world.react(); f.advance(5 * minute); await f.world.react();
  f.advance(29 * minute); await f.world.react(); assert.equal(f.notices().length, 1);
  f.advance(minute); await f.world.react(); assert.equal(f.notices().length, 2);
  const lead = f.world.state().agents.find((a) => a.role === "lead")!;
  f.world.messages.say(lead, { to: "founder", text: "Not ready: captions still need checking." });
  // A fresh tracker simulates a restart: cooldown and the response guard are durable.
  const tracker = new Unpresented(f.db);
  const extra: string[] = [];
  f.advance(40 * minute); tracker.tick(f.world.state(), f.now(), (_id, text) => { extra.push(text); });
  f.advance(5 * minute); tracker.tick(f.world.state(), f.now(), (_id, text) => { extra.push(text); });
  assert.equal(extra.length, 0);
  f.commit("Caption pass"); f.advance(minute);
  tracker.tick(f.world.state(), f.now(), (_id, text) => { extra.push(text); });
  assert.equal(extra.length, 1);
  assert.match(extra[0]!, /2 commits/);
});

test("open unanswered item at current HEAD suppresses, including snooze; a milestone clears the count", async (t) => {
  const f = setup(t); f.commit();
  const decision = f.post("decide", "Which captions?");
  await f.world.react(); f.advance(5 * minute); await f.world.react(); assert.equal(f.notices().length, 0);
  f.inbox.snooze(decision.itemId, new Date(f.now() + 60 * minute).toISOString());
  f.advance(10 * minute); await f.world.react(); assert.equal(f.notices().length, 0);
  f.inbox.resolve(decision.itemId); await f.world.react(); assert.equal(f.notices().length, 1);
  f.post(); await f.world.react(); assert.equal(f.world.state().teams[0]!.unpresentedCommits, 0);
  f.advance(40 * minute); await f.world.react(); assert.equal(f.notices().length, 1);
});

test("a decision at a newly committed HEAD suppresses even inside the git polling cache window", async (t) => {
  const f = setup(t); f.commit(); await f.world.react();
  f.advance(5 * minute - 1); await f.world.react();
  f.commit("Just checked"); f.post("decide", "Show both versions?");
  f.advance(1); await f.world.react();
  assert.equal(f.notices().length, 0);
  assert.equal(f.world.state().teams[0]!.unpresentedCommits, 2);
});

test("prompt, offline, blocked team and waiting on founder never accrue eligible idle time", async (t) => {
  const f = setup(t); f.commit();
  for (const status of ["blocked", "unknown", "working"] as const) {
    f.live[0]!.status = status; await f.world.react(); f.advance(6 * minute); await f.world.react();
    assert.equal(f.notices().length, 0);
  }
  const offline = f.live.splice(0);
  await f.world.react(); f.advance(6 * minute); await f.world.react();
  assert.equal(f.notices().length, 0);
  f.live.push(...offline);
  f.live[0]!.status = "idle";
  f.live.push({ ...f.live[0]!, paneId: "p2", sessionId: "stuck-crew", name: "crew", status: "blocked" });
  await f.world.react(); f.advance(6 * minute); await f.world.react();
  assert.equal(f.world.state().teams[0]!.status, "blocked");
  assert.equal(f.notices().length, 0);
  f.live.pop();
  f.inbox.submit({ session: { harness: "pi", sessionId: "lead", cwd: f.path }, item: { type: "decide", title: "Blocked?", blocking: true } });
  f.commit("Still unpresented"); await f.world.react(); f.advance(6 * minute); await f.world.react();
  assert.equal(f.notices().length, 0);
});

test("the additive migration keeps existing items and is safe to run again", (t) => {
  const f = setup(t);
  const existing = f.post("decide", "Existing question");
  f.db.exec("DROP INDEX items_presented; DROP TABLE unpresented_work; ALTER TABLE items DROP COLUMN presented_head; ALTER TABLE items DROP COLUMN presented_path;");
  migrateUnpresented(f.db);
  assert.equal(f.inbox.item(existing.itemId).title, "Existing question");
  assert.equal(f.inbox.item(existing.itemId).presentedHead, null);
  const head = f.commit(); const item = f.post();
  migrateUnpresented(f.db);
  assert.equal(f.inbox.item(item.itemId).presentedHead, head);
  assert.equal(new Unpresented(f.db).sample(f.path, f.now())?.count, 0);
});

test("first mates are told to present each checked visible increment, not wait for the whole project", (t) => {
  const f = setup(t);
  const brief = f.world.brief({ harness: "pi", sessionId: "lead", cwd: f.path }).text;
  assert.match(brief, /milestone per visible step/);
  assert.match(brief, /even if the project is not finished/);
  assert.match(brief, /--screenshot.*--page.*--video/);
  assert.match(brief, /office reminds you about commits you have not shown/);
});

test("standing teams without a worktree are excluded even when their lead works in one", async (t) => {
  const f = setup(t); f.commit();
  const team = await f.world.createTeam({ name: "Standing", standing: true });
  const lead = f.world.state().agents[0]!;
  f.world.updateAgent(lead.id, { teamId: team.id, role: "lead" });
  await f.world.react(); f.advance(10 * minute); await f.world.react();
  assert.equal(f.notices().length, 0);
  assert.equal(f.world.state().teams.find((x) => x.id === team.id)!.unpresentedCommits, 0);
});
