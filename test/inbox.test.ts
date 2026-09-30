import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import type { SessionInput, SubmitInput } from "../src/shared/types.ts";

const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };

function setup(file = ":memory:", clock = { t: Date.parse("2026-09-27T10:00:00Z") }) {
  const dir = mkdtempSync(join(tmpdir(), "inbox-test-"));
  const inbox = new Inbox(openDatabase(file === ":memory:" ? file : join(dir, file)), join(dir, "files"), noPresence, () => new Date(clock.t));
  return { inbox, dir, clock };
}

const voice: SessionInput = { harness: "pi", sessionId: "/sessions/voice.jsonl", cwd: "/repo/voice" };
const other: SessionInput = { harness: "claude", sessionId: "uuid-other", cwd: "/repo/other" };

function decision(extra: Partial<SubmitInput["item"]> = {}): SubmitInput {
  return {
    session: voice,
    project: { name: "fysiklab", root: "/repo" },
    task: { title: "Voice teacher" },
    item: { type: "decide", title: "When should the teacher stop talking?", options: ["Immediately: cut mid-word", "At the sentence end: smoother"], ...extra },
  };
}

test("an identical resubmission changes nothing; a changed one is a new revision", () => {
  const { inbox } = setup();
  const first = inbox.submit(decision());
  assert.equal(first.revision, 1);
  assert.equal(inbox.submit(decision()).changed, false);
  const second = inbox.submit(decision({ recommendation: "Immediately" }));
  assert.equal(second.itemId, first.itemId);
  assert.equal(second.revision, 2);
  assert.equal(inbox.state().items.length, 1);
});

test("an answer is queued, delivered to the owning session only, and acknowledged once", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  inbox.submit({ ...decision(), session: other, item: { type: "milestone", title: "Other work" } });
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });
  assert.equal(inbox.item(itemId).state, "answer_queued");
  assert.equal(inbox.task(inbox.item(itemId).taskId).lastDecision, "Immediately (When should the teacher stop talking?)");

  assert.deepEqual(inbox.pendingReplies(other, "pull"), []);
  const [pending] = inbox.pendingReplies(voice, "pull");
  assert.equal(pending?.deliveryId, reply.id);
  assert.equal(pending?.choiceLabel, "Immediately");

  assert.throws(() => inbox.acknowledge(other, reply.id), /no reply/);
  assert.equal(inbox.acknowledge(voice, reply.id).state, "delivered");
  assert.equal(inbox.acknowledge(voice, reply.id).state, "delivered");
  assert.equal(inbox.item(itemId).state, "delivered");
  assert.deepEqual(inbox.pendingReplies(voice, "pull"), []);
});

test("a retried answer with the same delivery id does not create a second reply", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  inbox.answer(itemId, { id: "d-1", revision: 1, action: "choose", choice: "b" });
  inbox.answer(itemId, { id: "d-1", revision: 1, action: "choose", choice: "b" });
  assert.equal(inbox.detail(itemId).replies.length, 1);
});

test("an answer to an old revision is refused, and a queued one goes stale when the item changes", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  const queued = inbox.answer(itemId, { revision: 1, action: "discuss", text: "What about a fade?" });
  inbox.submit(decision({ options: ["Immediately", "Fade out over 300 ms", "At the sentence end"] }));
  assert.equal(inbox.reply(queued.id).state, "stale");
  assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.deepEqual(inbox.pendingReplies(voice, "pull"), []);
  assert.throws(() => inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" }), /stale/);
});

test("answers must fit the item type", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  assert.throws(() => inbox.answer(itemId, { revision: 1, action: "accept" }), /does not answer/);
  assert.throws(() => inbox.answer(itemId, { revision: 1, action: "choose", choice: "z" }), /options/);
  assert.throws(() => inbox.answer(itemId, { revision: 1, action: "discuss", text: " " }), /write/);
});

test("items and queued replies survive a restart", () => {
  const { inbox, dir } = setup("inbox.sqlite");
  const { itemId } = inbox.submit(decision());
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });
  const reopened = new Inbox(openDatabase(join(dir, "inbox.sqlite")), join(dir, "files"), noPresence);
  assert.equal(reopened.item(itemId).state, "answer_queued");
  assert.equal(reopened.pendingReplies(voice, "pull")[0]?.deliveryId, reply.id);
});

test("the reply route is learned from how the session collects replies", () => {
  const { inbox, clock } = setup();
  const { taskId } = inbox.submit(decision());
  assert.equal(inbox.task(taskId).capabilities.reply, "pull");
  inbox.pendingReplies(voice, "boundary");
  assert.equal(inbox.task(taskId).capabilities.reply, "boundary");
  inbox.pendingReplies(voice, "live");
  assert.equal(inbox.task(taskId).capabilities.reply, "live");
  clock.t += 60_000; // the listener went quiet
  assert.equal(inbox.task(taskId).capabilities.reply, "boundary");
});

test("a failed delivery needs attention again and can be retried under the same id", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });
  inbox.acknowledge(voice, reply.id, "session busy");
  assert.equal(inbox.reply(reply.id).state, "failed");
  assert.equal(inbox.item(itemId).state, "needs_attention");
  assert.equal(inbox.retry(reply.id).state, "queued");
  assert.equal(inbox.pendingReplies(voice, "pull")[0]?.deliveryId, reply.id);
});

test("a reply picked up but never confirmed is reported as uncertain", () => {
  const { inbox, clock } = setup();
  const { itemId } = inbox.submit(decision());
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });
  inbox.pendingReplies(voice, "live");
  assert.equal(inbox.reply(reply.id).error, null);
  clock.t += 60_000;
  assert.match(inbox.reply(reply.id).error ?? "", /not confirmed/);
});

test("a snoozed item needs attention again when its time comes", () => {
  const { inbox, clock } = setup();
  const { itemId } = inbox.submit(decision());
  inbox.snooze(itemId, new Date(clock.t + 3_600_000).toISOString());
  assert.equal(inbox.wakeDue(), 0);
  clock.t += 3_600_001;
  assert.equal(inbox.wakeDue(), 1);
  assert.equal(inbox.item(itemId).state, "needs_attention");
});

test("only explicitly attached images and documents are stored", () => {
  const { inbox, dir } = setup();
  const shot = join(dir, "shot.png");
  writeFileSync(shot, "png-bytes");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  const { itemId } = inbox.submit(decision({ evidence: [{ path: shot, caption: "Doppler step" }] }));
  const [evidence] = inbox.detail(itemId).evidence;
  assert.equal(evidence?.kind, "image");
  assert.match(evidence?.href ?? "", /^\/files\//);
  assert.throws(() => inbox.submit(decision({ key: "x", evidence: [{ path: join(dir, ".env") }] })), /cannot attach/);
});

test("the agent can withdraw its own item, and a user resolution stales unsent answers", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  assert.throws(() => inbox.closeItem(other, itemId, "withdrawn"), /no item/);
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });
  inbox.resolve(itemId);
  assert.equal(inbox.reply(reply.id).state, "stale");
  const second = inbox.submit(decision({ key: "second", title: "Second question" }));
  assert.equal(inbox.closeItem(voice, "second", "withdrawn").state, "withdrawn");
  assert.equal(inbox.item(second.itemId).state, "withdrawn");
});

test("a Pi session is addressed by its session file path: the header id for the same agent gets no reply", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(decision());
  const reply = inbox.answer(itemId, { revision: 1, action: "choose", choice: "a" });

  // The same agent (harness and checkout), submitted as the id from the session file's header.
  const headerId: SessionInput = { ...voice, sessionId: "0199a1b2-header-id" };
  assert.deepEqual(inbox.pendingReplies(headerId, "live"), []);
  assert.deepEqual(inbox.pendingReplies(headerId, "pull"), []);
  assert.throws(() => inbox.acknowledge(headerId, reply.id), /no reply/);

  // The path the extension registered it under receives it.
  const [pending] = inbox.pendingReplies({ ...voice }, "live");
  assert.equal(pending?.deliveryId, reply.id);
  assert.equal(inbox.acknowledge(voice, reply.id).state, "delivered");
});
