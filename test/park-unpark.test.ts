import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { Waivers } from "../src/server/pipelines/waiver.ts";
import { isParked, needsYou } from "../src/ui/queue.ts";
import type { SubmitInput } from "../src/shared/types.ts";
import type { WorldAgent, WorldState } from "../src/shared/types.ts";

// Parking hides a task, never something the founder must answer.

const none = { available: () => false, forSession: () => null, resolvePane: () => null };
const scratch = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "park-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const ask = (key = "which", over: Partial<SubmitInput["item"]> = {}): SubmitInput => ({
  session: { harness: "pi", sessionId: "/sessions/a.jsonl", cwd: "/repo/a" },
  project: { name: "a", root: "/repo/a" },
  task: { title: "a task" },
  item: { key, type: "decide", title: `${key}?`, options: ["Left: short", "Right: long"], ...over },
});
const unparkedReasons = (inbox: Inbox) => (inbox as unknown as { db: { prepare(s: string): { all(): Array<{ detail: string }> } } }).db
  .prepare("SELECT detail FROM events WHERE kind = 'task.unparked'").all().map((r) => JSON.parse(r.detail).reason);

test("a new item on a parked task unparks it and reaches Needs you", (t) => {
  const inbox = new Inbox(openDatabase(":memory:"), join(scratch(t), "files"), none);
  const first = inbox.submit(ask("first"));
  inbox.updateTask(first.taskId, { parked: true });
  inbox.resolve(first.itemId);
  assert.equal(inbox.task(first.taskId).parked, true);
  assert.equal(isParked(inbox.state(), inbox.task(first.taskId)), true, "nothing waiting: stays parked");

  const next = inbox.submit(ask("second"));
  assert.equal(inbox.task(first.taskId).parked, false);
  assert.deepEqual(needsYou(inbox.state(), "all", null).map((e) => e.item.id), [next.itemId]);
  assert.deepEqual(unparkedReasons(inbox), ["new item"]);
});

test("a revised item on a parked task unparks it; an unchanged resubmission does not", (t) => {
  const inbox = new Inbox(openDatabase(":memory:"), join(scratch(t), "files"), none);
  const first = inbox.submit(ask());
  inbox.updateTask(first.taskId, { parked: true });
  assert.equal(inbox.submit(ask()).changed, false);
  assert.equal(inbox.task(first.taskId).parked, true, "no change, nothing new for the founder");

  inbox.resolve(first.itemId);
  const revised = inbox.submit(ask("which", { title: "which, really?" }));
  assert.equal(revised.revision, 2);
  assert.equal(inbox.task(first.taskId).parked, false);
  assert.equal(needsYou(inbox.state(), "all", null).length, 1);
});

test("a parked task that already holds a waiting item still shows it in Needs you (old data)", (t) => {
  const inbox = new Inbox(openDatabase(":memory:"), join(scratch(t), "files"), none);
  const first = inbox.submit(ask());
  inbox.updateTask(first.taskId, { parked: true }); // parked while the item waits, as old data and races leave it
  const state = inbox.state();
  assert.equal(inbox.task(first.taskId).parked, true);
  assert.deepEqual(needsYou(state, "all", null).map((e) => e.item.id), [first.itemId]);
  assert.equal(isParked(state, inbox.task(first.taskId)), false, "it is working, not parked, until answered");
});

test("a parked task with nothing waiting stays parked and hidden", (t) => {
  const inbox = new Inbox(openDatabase(":memory:"), join(scratch(t), "files"), none);
  const first = inbox.submit(ask());
  inbox.resolve(first.itemId);
  inbox.updateTask(first.taskId, { parked: true });
  assert.deepEqual(needsYou(inbox.state(), "all", null), []);
  assert.equal(isParked(inbox.state(), inbox.task(first.taskId)), true);
});

test("a waiver request on a parked waiver task unparks it and the request reaches the founder", (t) => {
  const dir = scratch(t);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const repo = join(dir, "repo"); mkdirSync(repo); git(repo, "init", "-q", "-b", "dev");
  writeFileSync(join(repo, "guard.ts"), "export const guard = false;\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  git(repo, "switch", "-qc", "repair"); writeFileSync(join(repo, "guard.ts"), "export const guard = true;\n"); git(repo, "commit", "-qam", "repair");
  const repair = git(repo, "rev-parse", "HEAD"); git(repo, "switch", "-q", "dev");
  const db = openDatabase(join(dir, "office.sqlite")); t.after(() => db.close());
  const inbox = new Inbox(db, join(dir, "files"), none);
  const lead = { id: "captain", name: "captain", identity: "captain", harness: "manual", cwd: null, teamId: "repairs", role: "lead", paneId: null, status: "working", helpers: [], taskIds: [], doing: null, waitingOnYou: false, model: null, title: null, project: null, branch: null, sessionName: null, ran: false } as unknown as WorldAgent;
  const state = { agents: [lead], teams: [{ id: "repairs", name: "Repairs" }], work: [] } as unknown as WorldState;
  const waivers = new Waivers(db, () => state); waivers.inbox = inbox;
  const request = (clientId: string) => waivers.request(lead, { clientId, repo, ref: "dev", candidate: repair, reason: "The guard blocks every push; this restores it." });

  const earlier = request("ask-1");
  const task = inbox.state().tasks.find((x) => x.title === "Repair waivers")!;
  inbox.answer(earlier.itemId!, { revision: 1, action: "choose", choice: "refuse" });
  waivers.sync(); // the office settles the founder's refusal on its tick
  inbox.updateTask(task.id, { parked: true }); // the cleanup that hid the waiver task
  assert.equal(inbox.task(task.id).parked, true);

  const later = request("ask-2");
  assert.equal(inbox.task(task.id).parked, false);
  assert.ok(needsYou(inbox.state(), "decide", null).some((e) => e.item.id === later.itemId), "the waiver decision is in Needs you");
});
