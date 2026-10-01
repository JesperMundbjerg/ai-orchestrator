import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.ts";
import { MessageLoops } from "../src/server/loops.ts";
import { World, type AgentSource } from "../src/server/world.ts";
import type { Message } from "../src/shared/types.ts";

const MINUTE = 60_000;
function message(from = "a", to = "b", at = 0, changes: Partial<Message> = {}): Message {
  return { id: "test", kind: "message", fromAgentId: from, teamId: null, text: "Thanks, noted.", images: [], workId: null,
    createdAt: new Date(at).toISOString(), deliveries: [{ agentId: to, state: "queued", error: null, updatedAt: "" }],
    toFounder: false, fromOffice: false, allLeads: false, ...changes };
}

function detector(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const loops = new MessageLoops(db);
  const alternating = (n: number, start = 0, step = MINUTE) => Array.from({ length: n }, (_, i) => loops.observe(message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", start + i * step)));
  return { db, loops, alternating };
}

test("eight alternating short messages in ten minutes trip exactly once with count and age", (t) => {
  const { loops, alternating } = detector(t);
  const results = alternating(8);
  assert.deepEqual(results.slice(0, 7), Array(7).fill(null));
  assert.deepEqual(results[7], {
    agentIds: ["a", "b"],
    text: "You two have traded 8 short messages in 7 minutes; stop replying to acknowledgments, continue the work.",
  });
  for (let i = 8; i < 40; i++) assert.equal(loops.observe(message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", i * MINUTE)), null, "a sliding window must not rearm an ongoing episode");
  assert.equal(loops.observe(message("b", "a", 40 * MINUTE)), null, "same-direction messages do not rearm it either");
  assert.equal(loops.observe(message("a", "b", 41 * MINUTE)), null);
});

test("one-way bursts and slow back-and-forth do not trip", (t) => {
  const { loops, alternating } = detector(t);
  for (let i = 0; i < 100; i++) assert.equal(loops.observe(message("a", "b", i)), null);
  assert.ok(alternating(20, MINUTE, 2 * MINUTE).every((result) => result === null));
});

test("a repeated sender breaks alternation, but a fresh streak can trip", (t) => {
  const { loops, alternating } = detector(t);
  assert.ok(alternating(7).every((result) => result === null)); // last sender a
  assert.equal(loops.observe(message("a", "b", 7 * MINUTE)), null);
  const results = Array.from({ length: 7 }, (_, i) => loops.observe(message(i % 2 ? "a" : "b", i % 2 ? "b" : "a", (8 + i) * MINUTE)));
  assert.ok(results.slice(0, 6).every((result) => result === null));
  assert.ok(results[6]);
});

test("handoffs, reviews, images, long messages and fan-out end a pair's episode instead of counting as acknowledgments", (t) => {
  for (const changes of [
    { kind: "handoff" }, { kind: "review" }, { text: "x".repeat(300) }, { images: ["image-id"] },
    { deliveries: [{ agentId: "b", state: "queued", error: null, updatedAt: "" }, { agentId: "c", state: "queued", error: null, updatedAt: "" }] },
  ] satisfies Partial<Message>[]) {
    const { loops, alternating } = detector(t);
    alternating(7);
    assert.equal(loops.observe(message("a", "b", 7 * MINUTE, changes)), null);
    const results = alternating(8, 8 * MINUTE);
    assert.ok(results.slice(0, 7).every((result) => result === null));
    assert.ok(results[7], JSON.stringify(changes));
  }
});

test("the window and short-text boundaries are deterministic", (t) => {
  const { loops } = detector(t);
  for (let i = 0; i < 7; i++) assert.equal(loops.observe(message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", i * MINUTE, { text: "x".repeat(299) })), null);
  assert.ok(loops.observe(message("b", "a", 10 * MINUTE)), "exactly ten minutes counts");
  const second = detector(t);
  second.alternating(7);
  assert.equal(second.loops.observe(message("b", "a", 10 * MINUTE + 1)), null, "older than ten minutes does not count");
});

test("founder, office and unrelated-pair messages never feed back into a pair's detector", (t) => {
  const { loops, alternating } = detector(t);
  alternating(7);
  assert.equal(loops.observe(message("a", "b", 7 * MINUTE, { fromAgentId: null })), null);
  assert.equal(loops.observe(message("a", "b", 7 * MINUTE, { fromOffice: true })), null);
  assert.equal(loops.observe(message("a", "b", 7 * MINUTE, { toFounder: true, deliveries: [] })), null);
  assert.equal(loops.observe(message("a", "c", 7 * MINUTE)), null);
  assert.ok(loops.observe(message("b", "a", 8 * MINUTE)), "unrelated traffic does not hide the loop");
});

test("ten minutes of silence or substantive work starts a new episode; restarting alone does not", (t) => {
  const { db, loops, alternating } = detector(t);
  alternating(8);
  const restarted = new MessageLoops(db);
  for (let i = 8; i < 16; i++) assert.equal(restarted.observe(message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", i * MINUTE)), null);
  const next = Array.from({ length: 8 }, (_, i) => restarted.observe(message(i % 2 ? "b" : "a", i % 2 ? "a" : "b", (26 + i) * MINUTE)));
  assert.ok(next.slice(0, 7).every((result) => result === null));
  assert.ok(next[7], "a quiet pair rearms");
  assert.equal(loops.observe(message("a", "b", 34 * MINUTE, { kind: "handoff" })), null);
  assert.ok(alternating(8, 35 * MINUTE)[7], "substantive work rearms immediately");
});

test("a restart preserves an untripped streak", (t) => {
  const { db, alternating } = detector(t);
  alternating(7);
  assert.ok(new MessageLoops(db).observe(message("b", "a", 7 * MINUTE)));
});

function messagingOffice(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let at = Date.parse("2026-10-01T19:00:00Z");
  const typed: string[] = [];
  const unused = async () => { throw new Error("not in this test"); };
  const source: AgentSource = {
    available: () => true,
    live: () => ["a", "b"].map((id) => ({ paneId: id, harness: "pi", sessionId: id, cwd: `/not-a-repository/${id}`, status: "done", title: null, name: null })),
    prompt: async (_pane, text) => { typed.push(text); },
    notify: async () => {}, createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused,
  };
  const world = new World(db, source, () => ({ tasks: [], projects: [], items: [] }), () => new Date(at));
  const agents = ["a", "b"].map((pane) => world.state().agents.find((a) => a.paneId === pane)!);
  const say = (i: number) => {
    const from = agents[i % 2]!;
    const to = agents[(i + 1) % 2]!;
    return world.messages.say(from, { to: to.name, text: `Thanks ${i}`, clientId: `say-${i}` });
  };
  return { db, world, typed, agents, say, tick: () => { at += MINUTE; } };
}

test("storing a loop queues one ordinary office notice for both agents and never blocks their messages", async (t) => {
  const { db, world, typed, agents, say, tick } = messagingOffice(t);
  const notices = () => world.messages.list().filter((m) => m.fromOffice);
  for (let i = 0; i < 8; i++) { say(i); tick(); }
  assert.equal(notices().length, 1);
  assert.deepEqual(notices()[0]!.deliveries.map((d) => d.agentId).sort(), agents.map((a) => a.id).sort());
  assert.equal(notices()[0]!.toFounder, false, "there is no office-to-founder notice route to reuse");
  assert.match(notices()[0]!.text, /8 short messages in 7 minutes/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent_id IS NOT NULL").get()!.n, 8, "the triggering message is stored too");
  const repeated = say(7);
  assert.equal(repeated.id, say(7).id, "idempotent submissions are not new observations");
  for (let i = 8; i < 45; i++) { say(i); tick(); }
  assert.equal(notices().length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE from_agent_id IS NOT NULL").get()!.n, 45, "even a continuing loop is never limited");
  await world.react();
  assert.equal(typed.length, 2, "the original traffic and advice share normal batched delivery");
  assert.ok(typed.every((text) => text.includes("stop replying to acknowledgments")));
  assert.ok(world.messages.list().every((m) => m.deliveries.every((d) => d.state === "delivered")));
  world.messages.say(agents[0]!, { to: "founder", text: "Work continues." });
  assert.equal(world.messages.withFounder()[0]!.text, "Work continues.", "founder updates are untouched");
});

test("an advisory storage failure cannot block the triggering message or leave a false notice latch", (t) => {
  const { db, world, say, tick } = messagingOffice(t);
  const log = t.mock.method(console, "error", () => {});
  for (let i = 0; i < 7; i++) { say(i); tick(); }
  db.exec("CREATE TRIGGER refuse_advice BEFORE INSERT ON messages WHEN NEW.from_office = 1 BEGIN SELECT RAISE(ABORT, 'notice unavailable'); END;");
  const sent = say(7);
  tick();
  assert.equal(world.messages.message(sent.id).text, "Thanks 7", "the eighth agent message still succeeds");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 8);
  assert.equal(db.prepare("SELECT warned FROM message_loops").get()!.warned, 0, "a failed notice does not latch the episode");
  assert.equal(log.mock.calls.length, 1, "advisory failure is logged, not thrown to the agent");
  db.exec("DROP TRIGGER refuse_advice");
  for (let i = 8; i < 16; i++) { say(i); tick(); }
  assert.equal(world.messages.list().filter((m) => m.fromOffice).length, 1, "a subsequent streak can retry the advisory, not the original message");
});
