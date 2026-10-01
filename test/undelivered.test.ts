import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.ts";
import { Messages } from "../src/server/messages.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import type { WorldAgent } from "../src/shared/types.ts";

const MINUTE = 60_000;
function setup(t: { after: (fn: () => void) => void }, durable = false) {
  const dir = mkdtempSync(join(tmpdir(), "undelivered-test-"));
  const file = durable ? join(dir, "office.sqlite") : ":memory:";
  let db = openDatabase(file);
  let at = Date.parse("2026-10-01T10:00:00Z");
  const unused = async () => { throw new Error("not used"); };
  const live: LiveAgent[] = [{ paneId: "a", harness: "manual", sessionId: "a", cwd: null, status: "working", title: null, name: "Heron" }];
  const notified: Array<[string, string]> = [];
  const source: AgentSource = { available: () => true, live: () => live, prompt: unused,
    notify: async (title, body) => { notified.push([title, body]); }, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused };
  const world = new World(db, source, () => ({ tasks: [], projects: [], items: [] }), () => new Date(at));
  const agent = world.state().agents[0]!;
  db.prepare("INSERT INTO teams (id, name, standing, created_at) VALUES ('project', 'Review Inbox', 1, ?)").run(new Date(at).toISOString());
  world.updateAgent(agent.id, { teamId: "project", role: "lead" });
  let state = world.state();
  // Exercise the real message store while leaving all deliveries untouched by the observer.
  let messages = new Messages(db, null, () => state, () => new Date(at), () => {});
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { world, notified, agent,
    queue: () => messages.tell(agent.id, { text: "Please check the delivery." }),
    status: (status: WorldAgent["status"]) => { state = world.state(); state.agents[0]!.status = status; },
    tick: (minutes: number) => { at += minutes * MINUTE; return messages.watch(state); },
    notices: () => messages.withFounder().filter((m) => m.fromOffice),
    deliveries: () => db.prepare("SELECT * FROM message_deliveries").all(),
    drain: (deliveryState = "delivered") => { db.prepare("UPDATE message_deliveries SET state = ?").run(deliveryState); },
    dispatch: () => messages.founderNotices.dispatch((title, body) => source.notify(title, body)),
    restart: () => { db.close(); db = openDatabase(file); messages = new Messages(db, null, () => state, () => new Date(at), () => {}); },
    get db() { return db; },
  };
}

test("only a free agent with a queued delivery older than ten minutes trips; all queued messages count", async (t) => {
  const s = setup(t);
  s.queue();
  assert.equal(s.tick(11), false, "working is not free");
  for (const status of ["offline", "unknown", "blocked"] as const) {
    s.status(status); assert.equal(s.tick(0), false, status);
  }
  s.status("idle");
  s.queue();
  const before = s.deliveries();
  assert.equal(s.tick(0), true);
  const notice = s.notices()[0]!;
  assert.equal(notice.text, `${s.agent.name} (Review Inbox) is free but 2 messages have waited 11 minutes undelivered.`);
  assert.equal(notice.fromAgentId, null);
  assert.equal(notice.toFounder, true);
  assert.deepEqual(notice.deliveries, []);
  assert.deepEqual(notice.aboutAgentIds, [s.agent.id]);
  assert.deepEqual(s.deliveries(), before, "the observer never changes or retries deliveries");
  await s.dispatch(); await s.dispatch();
  assert.deepEqual(s.notified, [[`${s.agent.name}: messages undelivered`, notice.text]]);
});

test("exactly ten minutes, failed and sending deliveries do not trip", (t) => {
  const s = setup(t); s.status("done"); s.queue();
  assert.equal(s.tick(10), false);
  s.drain("sending"); assert.equal(s.tick(1), false);
  s.drain("failed"); assert.equal(s.tick(1), false);
  assert.equal(s.notices().length, 0);
});

test("once per episode across a real restart, and a drain rearms", async (t) => {
  const s = setup(t, true); s.status("done"); s.queue();
  assert.equal(s.tick(10 + 1 / MINUTE), true);
  s.status("working"); s.tick(2); s.status("idle"); s.queue();
  assert.equal(s.tick(20), false, "more messages and becoming free do not rearm");
  s.restart(); assert.equal(s.tick(1), false);
  await s.dispatch(); assert.equal(s.notified.length, 1, "pending desktop notice survives restart");
  s.restart(); await s.dispatch(); assert.equal(s.notified.length, 1);
  s.drain(); assert.equal(s.tick(0), false);
  s.queue(); assert.equal(s.tick(10), false); assert.equal(s.tick(1), true);
  assert.equal(s.notices().length, 2);
});

test("the sender observes a queue drain even when a new message arrives during its prompt", async (t) => {
  const db = openDatabase(":memory:"); t.after(() => db.close());
  let at = 0;
  const unused = async () => { throw new Error("unused"); };
  let world: World;
  const source: AgentSource = { available: () => true,
    live: () => [{ paneId: "a", harness: "manual", sessionId: "a", cwd: null, status: "done", title: null, name: null }],
    prompt: async () => { world.messages.tell(world.state().agents[0]!.id, { text: "Next check." }); },
    notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused };
  world = new World(db, source, () => ({ tasks: [], projects: [], items: [] }), () => new Date(at));
  world.messages.tell(world.state().agents[0]!.id, { text: "First check." });
  at = 11 * MINUTE;
  await world.react();
  assert.equal(world.messages.withFounder().filter((m) => m.fromOffice).length, 1);
  at += 11 * MINUTE;
  assert.equal(world.messages.watch(world.state()), true, "a new episode rearms without a poll of an empty queue");
  assert.equal(world.messages.withFounder().filter((m) => m.fromOffice).length, 2);
});

test("notice storage and durable latch are atomic", (t) => {
  const s = setup(t); s.status("idle"); s.queue();
  s.db.exec("CREATE TRIGGER refuse_notice BEFORE INSERT ON messages WHEN NEW.from_office = 1 BEGIN SELECT RAISE(ABORT, 'unavailable'); END;");
  assert.throws(() => s.tick(11), /unavailable/);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM undelivered_episodes").get()!.n, 0);
  s.db.exec("DROP TRIGGER refuse_notice");
  assert.equal(s.tick(0), true);
});
