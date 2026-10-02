import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";
import { AgentStartingError } from "../src/server/agent-starting.ts";

const CREATED = "2026-10-01T17:43:33Z";
const SENT = "2026-10-01T17:44:16Z";
const REGISTERED = "2026-10-01T17:44:49Z";
const REFUSAL = "agent wX:p1 is not an active named agent";

function office(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "starting-delivery-"));
  let db = openDatabase(join(dir, "inbox.sqlite"));
  let at = Date.parse(CREATED);
  const now = () => new Date(at);
  db.prepare("INSERT INTO teams (id, name, path, created_at, lead_pane) VALUES ('ecg', 'ECG lesson', ?, ?, 'wX:p1')").run(dir, now().toISOString());
  db.prepare("INSERT INTO world_agents (id, identity, name, team_id, role, first_seen_at) VALUES ('lead', ?, 'Emil', 'ecg', 'lead', ?)").run(`pi:${dir}@lead-ecg`, now().toISOString());
  const presence = { available: () => false, forSession: () => null, resolvePane: () => null };
  let inbox = new Inbox(db, join(dir, "files"), presence, now);
  let live: LiveAgent[] = [];
  let error: Error | null = null;
  const attempts: string[] = [];
  const typed: string[] = [];
  const unused = async () => { throw new Error("not in this test"); };
  const source: AgentSource = {
    available: () => true, live: () => live,
    prompt: async (_pane, text) => {
      attempts.push(text);
      if (error) throw error;
      typed.push(text);
    },
    notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused,
  };
  let world = new World(db, source, () => inbox.state(), now);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get db() { return db; },
    attempts, typed,
    get world() { return world; },
    time: (time: string) => { at = Date.parse(time); },
    later: (ms: number) => { at += ms; },
    refuse: (next: Error | null) => { error = next; },
    running: (status: LiveAgent["status"]) => {
      live = [{ paneId: "wX:p1", cwd: dir, harness: "pi", sessionId: "ecg-session", status, name: null, title: null }];
    },
    restart: () => {
      db.close();
      db = openDatabase(join(dir, "inbox.sqlite"));
      inbox = new Inbox(db, join(dir, "files"), presence, now);
      world = new World(db, source, () => inbox.state(), now);
    },
    delivery: (id: string) => world.messages.message(id).deliveries[0]!,
  };
}

test("ECG timeline: a lead pane with nobody running keeps the founder's instruction until registration and a free turn", async (t) => {
  const o = office(t);
  o.time(SENT);
  const m = o.world.messages.instruct("ecg", { text: "Please start the ECG lesson" });
  const queuedAt = o.delivery(m.id).updatedAt;
  await o.world.react();
  assert.equal(o.attempts.length, 0);
  assert.deepEqual([o.delivery(m.id).state, o.delivery(m.id).error], ["queued", null]);

  // herdr registers this session under a different identity; seating folds the old desk
  // into the actual lead, including the queued delivery and its original age.
  o.time(REGISTERED);
  o.running("working");
  const lead = o.world.state().agents.find((a) => a.paneId === "wX:p1")!;
  assert.notEqual(lead.id, "lead");
  assert.equal(lead.name, "Emil");
  assert.equal(o.delivery(m.id).agentId, lead.id);
  for (const status of ["working", "blocked", "unknown"] as const) {
    o.running(status);
    await o.world.react();
    assert.equal(o.delivery(m.id).state, "queued");
    assert.equal(o.delivery(m.id).updatedAt, queuedAt);
  }
  assert.equal(o.attempts.length, 0);
  o.running("idle");
  await Promise.all([o.world.react(), o.world.react()]);
  assert.equal(o.typed.length, 1);
  assert.match(o.typed[0]!, /Please start the ECG lesson/);
  assert.equal(o.delivery(m.id).state, "delivered");
  await o.world.react();
  assert.equal(o.typed.length, 1, "no founder Retry, and no duplicate prompt");
});

test("ECG timeline: herdr's definite not-active refusal requeues the batch, preserving age across attempts and restart", async (t) => {
  const o = office(t);
  o.time(SENT);
  o.running("idle"); // cached presence can say free before agent prompt accepts the named agent
  const lead = o.world.state().agents[0]!;
  o.refuse(new AgentStartingError(REFUSAL));
  const messages = ["First instruction", "Second instruction"].map((text) => o.world.messages.tell(lead.id, { text }));
  const queuedAt = o.delivery(messages[0]!.id).updatedAt;
  for (let i = 0; i < 3; i++) {
    await Promise.all([o.world.react(), o.world.react()]);
    assert.equal(o.attempts.length, i + 1, "one in-flight batch per recipient");
    for (const m of messages) {
      assert.deepEqual([o.delivery(m.id).state, o.delivery(m.id).error, o.delivery(m.id).updatedAt], ["queued", null, queuedAt]);
    }
    o.later(5000);
  }
  o.restart();
  assert.ok(messages.every((m) => o.delivery(m.id).state === "queued"), "a completed startup refusal is not an interrupted send");
  o.time(REGISTERED);
  o.refuse(null);
  o.running("working");
  await o.world.react();
  assert.equal(o.typed.length, 0, "registration does not interrupt a working turn");
  o.running("done");
  await o.world.react();
  assert.equal(o.typed.length, 1);
  assert.match(o.typed[0]!, /^2 messages arrived[\s\S]*First instruction[\s\S]*Second instruction/);
  assert.ok(messages.every((m) => o.delivery(m.id).state === "delivered"));
});

test("a startup requeue redraws but does not recursively retry itself; a later presence event still delivers", async (t) => {
  const o = office(t);
  o.time(SENT);
  o.running("idle");
  const lead = o.world.state().agents[0]!;
  o.refuse(new AgentStartingError(REFUSAL));
  const reactions: Promise<void>[] = [];
  // The HTTP service reacts to world changes, but activity changes only redraw.
  // Cap the stand-in so a regression fails rather than spinning forever.
  o.world.onChange = (reason) => {
    if (reason !== "activity" && reactions.length < 10) reactions.push(o.world.react());
  };
  const m = o.world.messages.tell(lead.id, { text: "Start ECG" });
  await Promise.all(reactions);
  assert.equal(o.attempts.length, 1, "the requeue does not cause another agent prompt");
  assert.equal(o.delivery(m.id).state, "queued");
  o.time(REGISTERED);
  o.refuse(null);
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "delivered");
  assert.equal(o.typed.length, 1);
});

test("a lead that never starts fails after three minutes from queue time, without a restart extending the wait", async (t) => {
  const o = office(t);
  o.time(SENT);
  const m = o.world.messages.instruct("ecg", { text: "Start ECG" });
  o.later(179_999);
  o.restart();
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "queued");
  o.later(1);
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "failed");
  assert.match(o.delivery(m.id).error!, /did not start within 3 minutes/);
  assert.equal(o.attempts.length, 0);
});

test("not-active refusals have a bounded wait per delivery; explicit Retry starts a fresh attempt", async (t) => {
  const o = office(t);
  o.time(SENT);
  o.running("idle");
  const lead = o.world.state().agents[0]!;
  o.refuse(new AgentStartingError(REFUSAL));
  const first = o.world.messages.tell(lead.id, { text: "Older" });
  await o.world.react();
  o.later(179_999);
  const second = o.world.messages.tell(lead.id, { text: "Newer" });
  await o.world.react();
  assert.equal(o.delivery(first.id).state, "queued");
  o.later(1);
  await o.world.react();
  assert.deepEqual([o.delivery(first.id).state, o.delivery(first.id).error], ["failed", REFUSAL]);
  assert.equal(o.delivery(second.id).state, "queued");
  o.world.messages.retry(first.id, lead.id);
  await o.world.react();
  assert.equal(o.delivery(first.id).state, "queued", "Retry gives the older message a fresh grace period");
  o.refuse(null);
  await o.world.react();
  assert.ok([first, second].every((m) => o.delivery(m.id).state === "delivered"));
});

test("established offline leads still wait indefinitely, and registration while busy is not a startup timeout", async (t) => {
  const o = office(t);
  o.db.prepare("UPDATE world_agents SET ran_at = ? WHERE id = 'lead'").run(CREATED);
  o.time(SENT);
  const m = o.world.messages.instruct("ecg", { text: "When you return" });
  o.later(20 * 60_000);
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "queued", "the startup bound does not change offline delivery rules");
  o.running("blocked");
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "queued");
  o.running("idle");
  await o.world.react();
  assert.equal(o.delivery(m.id).state, "delivered", "an old queue can still be delivered once free");
});

test("ambiguous prompt failures are never automatically replayed, even for a new lead", async (t) => {
  const o = office(t);
  o.time(SENT);
  o.running("idle");
  const lead = o.world.state().agents[0]!;
  for (const reason of ["agent_prompt_stalled", "timed out", "PTY actor closed during input submission", "agent not found", "agent is asking something"]) {
    o.refuse(new Error(reason));
    const m = o.world.messages.tell(lead.id, { text: reason });
    await o.world.react();
    assert.deepEqual([o.delivery(m.id).state, o.delivery(m.id).error], ["failed", reason]);
    const n = o.attempts.length;
    await o.world.react();
    assert.equal(o.attempts.length, n, "a possibly submitted prompt needs explicit Retry");
  }
});
