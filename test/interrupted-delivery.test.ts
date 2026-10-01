import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { World, type AgentSource, type LiveAgent } from "../src/server/world.ts";

const emil: LiveAgent = { paneId: "w9:p1", harness: "claude", sessionId: "emil-session", cwd: "/repo/cosmology", status: "idle", title: null, name: null };
const esther: LiveAgent = { paneId: "wM:p1", harness: "claude", sessionId: "esther-session", cwd: "/repo/hero", status: "done", title: null, name: null };
const clara: LiveAgent = { paneId: "w7:p1", harness: "pi", sessionId: "clara-session", cwd: "/repo/office", status: "done", title: null, name: null };

function source(live: LiveAgent[], prompt: AgentSource["prompt"]): AgentSource & PresenceSource {
  const unused = async () => { throw new Error("not in this test"); };
  return {
    available: () => true,
    live: () => live,
    forSession: (harness, sessionId) => {
      const a = live.find((a) => a.harness === harness && a.sessionId === sessionId);
      return a ? { source: "herdr", paneId: a.paneId, status: a.status, name: null, title: null, seenAt: "" } : null;
    },
    resolvePane: () => null,
    prompt,
    notify: async () => {},
    createWorktree: unused, startAgent: unused, closePane: unused, removeWorktree: unused,
  };
}

function office(dir: string, agents: AgentSource & PresenceSource, now: () => Date) {
  const db = openDatabase(join(dir, "inbox.sqlite"));
  const inbox = new Inbox(db, join(dir, "files"), agents, now);
  const world = new World(db, agents, () => inbox.state(), now);
  world.messages.replies = inbox;
  return { db, inbox, world };
}

test("restart releases interrupted sending batches without replaying them, then delivers replies and queued messages to free leads", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "interrupted-delivery-"));
  let at = Date.parse("2026-10-01T18:31:10Z");
  const now = () => new Date(at);
  const live = [{ ...emil }, { ...esther }, { ...clara }];
  const typed: Array<{ pane: string; text: string }> = [];
  const oldSource = source(live, async (pane, text) => {
    typed.push({ pane, text });
    // The old process is stopped while herdr is still confirming these prompts.
    if (pane !== clara.paneId) await new Promise<void>(() => {});
  });
  let o = office(dir, oldSource, now);
  t.after(() => { o.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const agent = (pane: string) => o.world.state().agents.find((a) => a.paneId === pane)!;
  const leads = [agent(emil.paneId), agent(esther.paneId)];
  const interrupted = leads.flatMap((a) => [
    o.world.messages.tell(a.id, { text: `Interrupted first for ${a.id}` }),
    o.world.messages.tell(a.id, { text: `Interrupted second for ${a.id}` }),
  ]);
  void o.world.react();
  assert.equal(typed.length, 2, "one active batch per lead");
  assert.deepEqual(interrupted.map((m) => o.world.messages.message(m.id).deliveries[0]!.state), Array(4).fill("sending"));

  at += 60 * 60_000;
  const queued = leads.flatMap((a, i) => Array.from({ length: i ? 15 : 24 }, (_, n) => o.world.messages.tell(a.id, { text: `Waiting ${n} for ${a.id}` })));
  const session = { harness: emil.harness, sessionId: emil.sessionId!, cwd: emil.cwd! };
  const { itemId } = o.inbox.submit({ session, item: { type: "milestone", title: "Cosmology chapters built" } });
  const reply = o.inbox.answer(itemId, { revision: 1, action: "accept" });
  const control = o.world.messages.tell(agent(clara.paneId).id, { text: "Clara still receives messages" });
  await o.world.react();
  assert.equal(typed.length, 3, "other recipients work; an active send still reserves each lead even after an hour");
  assert.equal(o.world.messages.message(control.id).deliveries[0]!.state, "delivered");
  assert.equal(o.inbox.typeable()[0]!.reply.deliveryId, reply.id, "the founder reply is still unclaimed");
  o.db.close();

  o = office(dir, source(live, async (pane, text) => { typed.push({ pane, text }); }), now);
  await o.world.react();
  const afterRestart = typed.slice(3);
  assert.equal(afterRestart.length, 2, "both free leads are unblocked on the first reaction");
  assert.match(afterRestart.find((p) => p.pane === emil.paneId)!.text, /^\[Review inbox\]/, "the founder reply goes first");
  assert.match(afterRestart.find((p) => p.pane === esther.paneId)!.text, /^15 messages arrived/);
  assert.equal(o.inbox.reply(reply.id).state, "delivered");
  const failed = interrupted.map((m) => o.world.messages.message(m.id).deliveries[0]!);
  assert.deepEqual(failed.map((d) => d.state), Array(4).fill("failed"), "unconfirmed old batches are not falsely acknowledged or silently requeued");
  for (const d of failed) assert.match(d.error!, /restart.*not confirmed.*may have arrived/i);
  assert.equal(o.world.messages.message(control.id).deliveries[0]!.state, "delivered", "confirmed deliveries are untouched");

  await o.world.react();
  assert.match(typed[5]!.text, /^24 messages arrived/);
  assert.deepEqual(queued.map((m) => o.world.messages.message(m.id).deliveries[0]!.state), Array(39).fill("delivered"));
  assert.ok(typed.slice(3).every((p) => !p.text.includes("Interrupted")), "no possibly received prompt is automatically typed twice");
  await o.world.react();
  assert.equal(typed.length, 6);

  o.db.close();
  o = office(dir, source(live, async (pane, text) => { typed.push({ pane, text }); }), now);
  await o.world.react();
  assert.equal(typed.length, 6, "recovery is idempotent across another restart");
  assert.deepEqual(interrupted.map((m) => o.world.messages.message(m.id).deliveries[0]!), failed);
  assert.equal(o.world.messages.retry(interrupted[0]!.id, leads[0]!.id).deliveries[0]!.state, "queued", "an explicit Retry remains available");
  await o.world.react();
  assert.equal(typed.length, 7);
  assert.match(typed[6]!.text, /Interrupted first/);
});

test("restart recovery does not bypass presence guards or interrupt a current send", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "interrupted-guard-"));
  const now = () => new Date("2026-10-01T19:00:00Z");
  const live = [{ ...esther }];
  let prompts = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const agents = source(live, async () => { prompts++; await held; });
  let o = office(dir, agents, now);
  t.after(() => { o.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const recipient = o.world.state().agents[0]!;
  const interrupted = o.world.messages.tell(recipient.id, { text: "Interrupted" });
  // Seed the durable state left by a stopped process; no terminal is involved.
  o.db.prepare("UPDATE message_deliveries SET state = 'sending' WHERE message_id = ?").run(interrupted.id);
  const queued = o.world.messages.tell(recipient.id, { text: "Still waiting" });
  o.db.close();
  o = office(dir, agents, now);
  for (const status of ["working", "blocked", "unknown"] as const) {
    live[0]!.status = status;
    await o.world.react();
    assert.equal(prompts, 0, status);
  }
  live.length = 0;
  await o.world.react();
  assert.equal(prompts, 0, "offline is not free");
  live.push({ ...esther });
  const sending = o.world.react();
  assert.equal(prompts, 1);
  assert.equal(o.world.messages.message(queued.id).deliveries[0]!.state, "sending");
  await o.world.react();
  assert.equal(prompts, 1, "a live in-process send is never recovered or duplicated by another reaction");
  release();
  await sending;
  assert.equal(o.world.messages.message(queued.id).deliveries[0]!.state, "delivered");
  assert.equal(o.world.messages.message(interrupted.id).deliveries[0]!.state, "failed");
});
