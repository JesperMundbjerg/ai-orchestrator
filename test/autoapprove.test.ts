import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { AutoApprove } from "../src/server/autoapprove.ts";
import { createInboxServer } from "../src/server/http.ts";
import { formatReply } from "../src/shared/agent-client.ts";
import type { SubmitInput } from "../src/shared/types.ts";

const presence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const session = { harness: "manual" as const, sessionId: "approve-all-owner" };
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "approve-all-"));
  const db = openDatabase(join(dir, "inbox.sqlite"));
  const inbox = new Inbox(db, join(dir, "files"), presence);
  const auto = new AutoApprove(db, inbox);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const submit = (item: SubmitInput["item"]) => inbox.submit({ session, item });
  return { db, inbox, auto, submit, dir };
}
const choices = ["Docked: draft stays visible", "Overlay: draft stays wide"];

for (const type of ["milestone", "try"] as const) {
  test(`Approve all accepts ${type}, marks history/text and keeps normal delivery/acks`, (t) => {
    const { inbox, auto, submit } = setup(t);
    auto.setEnabled(true);
    const result = submit({ type, title: "Ready", ...(type === "try" ? { preview: "http://localhost:3000" } : {}) });
    const detail = inbox.detail(result.itemId);
    assert.equal(detail.replies.length, 1);
    const reply = detail.replies[0]!;
    assert.equal(reply.action, "accept");
    assert.equal(reply.state, "queued");
    assert.equal(reply.id, `approve-all:${result.itemId}:1`);
    assert.match(reply.text, /Auto-approved \(approve all\)/);
    const event = detail.history.find((event) => event.kind === "reply.queued")!;
    assert.equal(event.actor, "system");
    assert.equal(event.detail.autoApproved, true);
    assert.equal(inbox.task(result.taskId).lastAcceptedMilestone, type === "milestone" ? "Ready" : "");
    assert.deepEqual(inbox.pendingReplies({ ...session, sessionId: "not-owner" }, "pull"), []);
    const pending = inbox.pendingReplies(session, "pull")[0]!;
    assert.equal(pending.deliveryId, reply.id);
    assert.match(formatReply(pending), type === "try" ? /Approved\./ : /Milestone accepted\./);
    assert.match(formatReply(pending), /approve all/);
    assert.equal(inbox.acknowledge(session, reply.id).state, "delivered");
    assert.equal(auto.state().count, 1);
  });
}

test("auto-answer replay scope never collides with a founder's identical answer", (t) => {
  const { inbox, auto, submit } = setup(t);
  auto.setEnabled(true);
  const { itemId } = submit({ type: "milestone", title: "Automatically accepted" });
  const reply = inbox.detail(itemId).replies[0]!;
  const payload = { id: reply.id, revision: reply.revision, action: reply.action, text: reply.text };
  assert.throws(() => inbox.answer(itemId, payload), { code: "replay_conflict" });
  assert.equal(inbox.answer(itemId, payload, "approve_all").id, reply.id);
  assert.equal(inbox.detail(itemId).replies.length, 1);
  assert.equal(auto.state().count, 1);

  auto.setEnabled(false);
  const manual = submit({ type: "milestone", title: "Founder accepted" });
  const founderPayload = { id: `approve-all:${manual.itemId}:1`, revision: 1, action: "accept" as const, text: "Auto-approved (approve all)." };
  const founder = inbox.answer(manual.itemId, founderPayload);
  assert.throws(() => inbox.answer(manual.itemId, founderPayload, "approve_all"), { code: "replay_conflict" });
  assert.equal(inbox.answer(manual.itemId, founderPayload).id, founder.id);
  assert.equal(inbox.detail(manual.itemId).replies.length, 1);
  assert.equal(auto.state().count, 1);
});

for (const scope of ["founder", "approve_all"] as const) {
  test(`legacy replay scopes without a stored fingerprint preserve ${scope} ownership`, (t) => {
    const { db, inbox, auto, submit } = setup(t);
    const { itemId } = submit({ type: "milestone", title: `Legacy ${scope} answer` });
    const payload = {
      id: scope === "approve_all" ? "approve-all:legacy-answer" : "legacy-founder-answer",
      revision: 1, action: "accept" as const, text: "Accepted.",
    };
    const source = scope === "approve_all" ? scope : undefined;
    const reply = inbox.answer(itemId, payload, source);
    db.prepare("UPDATE replies SET replay_fingerprint = NULL WHERE id = ?").run(reply.id);
    const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.throws(() => inbox.answer(itemId, payload, scope === "founder" ? "approve_all" : undefined), { code: "replay_conflict" });
    assert.deepEqual(inbox.answer(itemId, payload, source), reply);
    assert.equal(inbox.detail(itemId).replies.length, 1);
    assert.equal(auto.state().count, scope === "approve_all" ? 1 : 0);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes, "replays/conflicts never write a second answer or provenance event");
  });
}

test("decide chooses only the unambiguous recommendation the UI would mark", (t) => {
  const { inbox, auto, submit } = setup(t);
  auto.setEnabled(true);
  for (const recommendation of ["Docked, because writers need the draft", "I recommend Overlay: keep the width", "Option b, because it fits"]) {
    const { itemId } = submit({ type: "decide", title: recommendation, options: choices, recommendation });
    const reply = inbox.detail(itemId).replies[0]!;
    assert.equal(reply.action, "choose");
    assert.equal(reply.choice, recommendation.startsWith("Docked") ? "a" : "b");
    assert.match(inbox.task(inbox.item(itemId).taskId).lastDecision, /Docked|Overlay/);
  }
  assert.equal(auto.state().count, 3);
});

test("open questions, unrecommended, unrecognised and ambiguous recommendations remain for the founder", (t) => {
  const { inbox, auto, submit } = setup(t);
  auto.setEnabled(true);
  for (const item of [
    { type: "decide" as const, title: "What next?" },
    { type: "decide" as const, title: "Pick?", options: choices },
    { type: "decide" as const, title: "Vague?", options: choices, recommendation: "I like the idea of Docked" },
    { type: "decide" as const, title: "Ambiguous?", options: ["Docked", "Docked editor"], recommendation: "Docked editor because it fits" },
    { type: "decide" as const, title: "An article?", options: choices, recommendation: "A good outcome would keep the draft" },
  ]) {
    const { itemId } = submit(item);
    assert.equal(inbox.item(itemId).state, "needs_attention");
    assert.deepEqual(inbox.detail(itemId).replies, []);
  }
  assert.deepEqual(auto.state(), { enabled: true, count: 0 });
});

test("off by default and turning off stops new items and revisions", (t) => {
  const { inbox, auto, submit } = setup(t);
  assert.deepEqual(auto.state(), { enabled: false, count: 0 });
  const { itemId } = submit({ key: "work", type: "milestone", title: "First" });
  assert.deepEqual(inbox.detail(itemId).replies, []);
  auto.setEnabled(true);
  auto.setEnabled(false);
  submit({ key: "work", type: "milestone", title: "Second" });
  const other = submit({ type: "try", title: "Try", preview: "http://localhost:3000" });
  assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.equal(inbox.detail(itemId).replies[0]!.state, "stale");
  assert.deepEqual(inbox.detail(other.itemId).replies, []);
  assert.deepEqual(auto.state(), { enabled: false, count: 1 });
});

test("enabling answers waiting, snoozed and parked items but not closed or already answered items", (t) => {
  const { inbox, auto, submit } = setup(t);
  const waiting = submit({ type: "milestone", title: "Waiting" });
  const snoozed = submit({ type: "try", title: "Later", preview: "http://localhost:3000" });
  inbox.snooze(snoozed.itemId, new Date(Date.now() + 60_000).toISOString());
  const recommended = submit({ type: "decide", title: "Pick?", options: choices, recommendation: "Docked" });
  const open = submit({ type: "decide", title: "Words?" });
  const closed = submit({ type: "milestone", title: "Closed" });
  inbox.resolve(closed.itemId);
  const withdrawn = submit({ type: "milestone", title: "Withdrawn" });
  inbox.closeItem(session, withdrawn.itemId, "withdrawn");
  const manual = submit({ type: "milestone", title: "Already answered" });
  inbox.answer(manual.itemId, { id: "founder-answer", revision: 1, action: "accept" });
  inbox.updateTask(waiting.taskId, { parked: true });
  auto.setEnabled(true);
  for (const id of [waiting.itemId, snoozed.itemId, recommended.itemId]) assert.equal(inbox.item(id).state, "answer_queued");
  for (const id of [open.itemId, closed.itemId, withdrawn.itemId]) assert.deepEqual(inbox.detail(id).replies, []);
  assert.equal(inbox.detail(manual.itemId).replies.length, 1);
  auto.setEnabled(true);
  auto.sweep();
  assert.equal(auto.state().count, 3);
});

for (const type of ["milestone", "try", "decide"] as const) {
  test(`a revised ${type} is answered once at each revision and old queued answers go stale`, (t) => {
    const { inbox, auto, submit } = setup(t);
    auto.setEnabled(true);
    const item = { key: "same", type, title: "First", ...(type === "try" ? { preview: "http://localhost:3000" } : {}), ...(type === "decide" ? { options: choices, recommendation: "Docked" } : {}) };
    const first = submit(item);
    const old = inbox.detail(first.itemId).replies[0]!;
    const second = submit({ ...item, title: "Revised", ...(type === "decide" ? { recommendation: "Overlay" } : {}) });
    assert.equal(second.revision, 2);
    assert.equal(inbox.reply(old.id).state, "stale");
    const detail = inbox.detail(first.itemId);
    assert.equal(detail.replies.length, 2);
    const current = detail.replies.find((r) => r.revision === 2)!;
    assert.equal(current.state, "queued");
    assert.equal(current.choice, type === "decide" ? "b" : null);
    assert.equal(submit({ ...item, title: "Revised", ...(type === "decide" ? { recommendation: "Overlay" } : {}) }).changed, false);
    auto.sweep();
    assert.equal(auto.state().count, 2);
    assert.throws(() => inbox.answer(first.itemId, { id: "late", revision: 1, action: old.action, choice: old.choice }), /stale/);
    assert.equal(inbox.pendingReplies(session, "pull").length, 1);
  });
}

test("revising into an open or unrecommended decision stops automatic answering", (t) => {
  const { inbox, auto, submit } = setup(t);
  auto.setEnabled(true);
  const { itemId } = submit({ key: "same", type: "decide", title: "Question", options: choices, recommendation: "Docked" });
  submit({ key: "same", type: "decide", title: "Question", options: choices });
  submit({ key: "same", type: "decide", title: "Question" });
  assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.equal(inbox.detail(itemId).replies.length, 1);
  assert.deepEqual(inbox.pendingReplies(session, "pull"), []);
});

test("failed delivery requires Retry; automation never duplicates it", (t) => {
  const { inbox, auto, submit } = setup(t);
  auto.setEnabled(true);
  const { itemId } = submit({ type: "milestone", title: "Ready" });
  const reply = inbox.pendingReplies(session, "pull")[0]!;
  inbox.acknowledge(session, reply.deliveryId, "delivery failed");
  auto.setEnabled(true);
  auto.sweep();
  submit({ type: "milestone", title: "Ready" });
  assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.equal(inbox.detail(itemId).replies.length, 1);
  inbox.retry(reply.deliveryId);
  assert.equal(auto.state().count, 1);
});

test("Approve all leaves waiting office work, switches, merges and message deliveries untouched", (t) => {
  const { db, auto, submit } = setup(t);
  db.exec(`INSERT INTO teams (id, name, created_at) VALUES ('one', 'One', 'now'), ('two', 'Two', 'now');
    INSERT INTO world_agents (id, identity, name, team_id, first_seen_at) VALUES ('agent', 'manual:agent', 'Agent', 'one', 'now');
    INSERT INTO work (id, title, summary, from_agent_id, from_team_id, to_team_id, state, created_at, updated_at)
      VALUES ('work', 'Review', 'Do not accept automatically', 'agent', 'one', 'two', 'in_review', 'now', 'now');
    INSERT INTO messages (id, kind, text, created_at) VALUES ('message', 'instruction', 'Still queued', 'now');
    INSERT INTO message_deliveries (message_id, agent_id, state, updated_at) VALUES ('message', 'agent', 'queued', 'now');
    INSERT INTO agent_switches (id, agent_id, agent_name, cwd, from_harness, to_harness, model, effort, step, says, started_at, updated_at)
      VALUES ('switch', 'agent', 'Agent', '/scratch', 'pi', 'claude', 'model', 'high', 'waiting', 'Wait', 'now', 'now');`);
  const snapshot = () => ["teams", "world_agents", "messages", "message_deliveries", "work", "agent_switches"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot();
  submit({ type: "milestone", title: "Inbox work" });
  auto.setEnabled(true);
  submit({ type: "milestone", title: "More inbox work" });
  auto.sweep();
  assert.equal(auto.state().count, 2);
  assert.deepEqual(snapshot(), before);
});

test("persisted mode/count survive reopening the database; startup sweep repairs an interrupted submit", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "approve-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "inbox.sqlite");
  let db = openDatabase(path);
  let inbox = new Inbox(db, join(dir, "files"), presence);
  let auto = new AutoApprove(db, inbox);
  auto.setEnabled(true);
  const first = inbox.submit({ session, item: { type: "milestone", title: "Before restart" } });
  inbox.onSubmitted = () => {}; // stopped after commit, before the auto-answer hook
  const waiting = inbox.submit({ session, item: { type: "milestone", title: "Interrupted" } });
  db.close();
  db = openDatabase(path);
  inbox = new Inbox(db, join(dir, "files"), presence);
  auto = new AutoApprove(db, inbox);
  assert.deepEqual(auto.state(), { enabled: true, count: 1 });
  auto.sweep();
  assert.equal(inbox.detail(first.itemId).replies.length, 1);
  assert.equal(inbox.item(waiting.itemId).state, "answer_queued");
  assert.equal(auto.state().count, 2);
  inbox.submit({ session, item: { type: "milestone", title: "After restart" } });
  assert.equal(auto.state().count, 3);
  auto.setEnabled(false);
  db.close();
  db = openDatabase(path);
  auto = new AutoApprove(db, new Inbox(db, join(dir, "files"), presence));
  assert.deepEqual(auto.state(), { enabled: false, count: 3 });
  db.close();
});

test("setting HTTP writes use normal JSON/origin guards and reject invalid enabled values", async (t) => {
  const { inbox, auto } = setup(t);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = createInboxServer(inbox, null, { port, staticDir: null, autoApprove: auto });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://localhost:${port}/api/auto-approve`;
  assert.deepEqual(await (await fetch(url)).json(), { enabled: false, count: 0 });
  for (const [headers, body, status] of [
    [{ "content-type": "text/plain" }, '{"enabled":true}', 415],
    [{ "content-type": "application/json", origin: "http://example.com" }, '{"enabled":true}', 403],
    [{ "content-type": "application/json" }, '{"enabled":"true"}', 400],
    [{ "content-type": "application/json" }, '{}', 400],
  ] as const) assert.equal((await fetch(url, { method: "POST", headers, body })).status, status);
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' });
  assert.deepEqual(await response.json(), { enabled: true, count: 0 });
});
