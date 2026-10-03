import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { needsYou, nextAfterResponse } from "../src/ui/queue.ts";
import type { SessionInput, SubmitInput } from "../src/shared/types.ts";

const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "back-of-queue-"));
  const clock = { t: Date.parse("2026-10-03T10:00:00Z") };
  const inbox = new Inbox(openDatabase(":memory:"), join(dir, "files"), noPresence, () => new Date(clock.t));
  const tick = () => void (clock.t += 60_000);
  return { inbox, clock, tick };
}

const session = (name: string, root = `/repo/${name}`): SessionInput => ({ harness: "pi", sessionId: `/sessions/${name}.jsonl`, cwd: root });

function ask(name: string, extra: Partial<SubmitInput["item"]> = {}, root?: string): SubmitInput {
  return {
    session: session(name, root),
    project: { name: root ? "shared" : name, root: root ?? `/repo/${name}` },
    task: { title: `${name} task` },
    item: { type: "decide", title: `${name}: which way?`, options: ["Left: short", "Right: long"], ...extra },
  };
}

/** The titles the founder sees, first to last. */
const order = (inbox: Inbox) => needsYou(inbox.state(), "all", null).map((e) => e.item.title.split(":")[0]);

test("back of queue keeps the item needing you, sends nothing and moves it behind the others", () => {
  const { inbox, tick } = setup();
  const a = inbox.submit(ask("alma"));
  tick();
  inbox.submit(ask("bo"));
  tick();
  inbox.submit(ask("cy"));
  assert.deepEqual(order(inbox), ["alma", "bo", "cy"]);

  const item = inbox.backOfQueue(a.itemId);
  assert.equal(item.state, "needs_attention");
  assert.equal(item.snoozedUntil, null);
  assert.ok(item.backedAt);
  assert.deepEqual(order(inbox), ["bo", "cy", "alma"]);
  // The agent is still waiting: no reply exists, nothing is pending for it, and the age it has waited is unchanged.
  assert.deepEqual(inbox.detail(a.itemId).replies, []);
  assert.deepEqual(inbox.pendingReplies(session("alma"), "pull"), []);
  assert.equal(item.updatedAt, inbox.item(a.itemId).updatedAt);
  assert.equal(inbox.item(a.itemId).blocking, true);
  assert.deepEqual(inbox.detail(a.itemId).history.map((e) => e.kind), ["item.submitted", "item.backqueued"]);
  assert.equal(inbox.detail(a.itemId).history.at(-1)?.actor, "user");
});

test("it goes behind pinned projects and blocking items too, and later backings go further back", () => {
  const { inbox, tick } = setup();
  const pinned = inbox.submit(ask("pinned"));
  tick();
  const fyi = inbox.submit(ask("fyi", { blocking: false }));
  tick();
  inbox.submit(ask("waiting"));
  inbox.setPinned(inbox.detail(pinned.itemId).project.id, true);
  assert.deepEqual(order(inbox), ["pinned", "waiting", "fyi"]);

  // The pinned, blocking item would sort first; backing it still puts it last.
  inbox.backOfQueue(pinned.itemId);
  assert.deepEqual(order(inbox), ["waiting", "fyi", "pinned"]);
  // A second item backed goes behind the first, even in the same instant.
  inbox.backOfQueue(fyi.itemId);
  assert.deepEqual(order(inbox), ["waiting", "pinned", "fyi"]);
  // Backing the item already at the back again does not lose its place to an earlier backing.
  inbox.backOfQueue(pinned.itemId);
  assert.deepEqual(order(inbox), ["waiting", "fyi", "pinned"]);
});

test("a newer item goes before a backed one; a revision keeps its place at the back", () => {
  const { inbox, tick } = setup();
  const a = inbox.submit(ask("alma"));
  tick();
  const b = inbox.submit(ask("bo"));
  tick();
  inbox.backOfQueue(a.itemId);
  inbox.backOfQueue(b.itemId);
  assert.deepEqual(order(inbox), ["alma", "bo"]);

  tick();
  inbox.submit(ask("cy"));
  assert.deepEqual(order(inbox), ["cy", "alma", "bo"]);

  // The agent revises the item at the back of the queue: a new revision to answer, same place.
  tick();
  const revised = inbox.submit(ask("alma", { recommendation: "Left, because it is short" }));
  assert.equal(revised.revision, 2);
  assert.equal(inbox.item(a.itemId).state, "needs_attention");
  assert.deepEqual(order(inbox), ["cy", "alma", "bo"]);
  assert.ok(inbox.item(a.itemId).backedAt);
});

test("answering, snoozing, marking handled or the agent withdrawing ends the back-of-queue place", () => {
  const { inbox, clock, tick } = setup();
  const answered = inbox.submit(ask("alma"));
  const snoozed = inbox.submit(ask("bo"));
  const handled = inbox.submit(ask("cy"));
  const withdrawn = inbox.submit(ask("di"));
  for (const id of [answered, snoozed, handled, withdrawn]) inbox.backOfQueue(id.itemId);

  inbox.answer(answered.itemId, { revision: 1, action: "choose", choice: "a" });
  inbox.snooze(snoozed.itemId, new Date(clock.t + 3_600_000).toISOString());
  inbox.resolve(handled.itemId);
  inbox.closeItem(session("di"), withdrawn.itemId, "withdrawn");
  for (const id of [answered, snoozed, handled, withdrawn]) assert.equal(inbox.item(id.itemId).backedAt, null);

  // A failed delivery brings the answered item back needing you at its ordinary place, and a woken snooze likewise.
  const [pending] = inbox.pendingReplies(session("alma"), "pull");
  inbox.acknowledge(session("alma"), pending!.deliveryId, "session closed");
  tick();
  clock.t += 3_600_000;
  inbox.wakeDue();
  const fresh = inbox.submit(ask("ed"));
  const [first, second, third] = needsYou(inbox.state(), "all", null);
  assert.deepEqual([first?.item.id, second?.item.id, third?.item.id].sort(), [answered.itemId, snoozed.itemId, fresh.itemId].sort());
  assert.ok(needsYou(inbox.state(), "all", null).every((e) => e.item.backedAt === null));
});

test("only an item that needs you can go to the back of the queue", () => {
  const { inbox, clock } = setup();
  const a = inbox.submit(ask("alma"));
  inbox.answer(a.itemId, { revision: 1, action: "choose", choice: "a" });
  assert.throws(() => inbox.backOfQueue(a.itemId), /only an item that needs you/);
  const b = inbox.submit(ask("bo"));
  inbox.snooze(b.itemId, new Date(clock.t + 3_600_000).toISOString());
  assert.throws(() => inbox.backOfQueue(b.itemId), /snoozed/);
  const c = inbox.submit(ask("cy"));
  inbox.resolve(c.itemId);
  assert.throws(() => inbox.backOfQueue(c.itemId), /resolved/);
  assert.throws(() => inbox.backOfQueue("no-such-item"), /no item/);
  assert.equal(inbox.detail(a.itemId).history.some((e) => e.kind === "item.backqueued"), false);
});

test("after sending the open item to the back, the next one to open is the one after it", () => {
  const { inbox, tick } = setup();
  const a = inbox.submit(ask("alma"));
  tick();
  inbox.submit(ask("bo"));
  tick();
  inbox.submit(ask("cy"));
  const before = needsYou(inbox.state(), "all", null);
  const next = nextAfterResponse(before, a.itemId);
  inbox.backOfQueue(a.itemId);
  assert.equal(before.find((e) => e.item.id === next)?.item.title.split(":")[0], "bo");
  assert.deepEqual(order(inbox), ["bo", "cy", "alma"]);
});

test("pinning a project brings its backed items forward again", () => {
  const { inbox, tick } = setup();
  const a = inbox.submit(ask("alma"));
  tick();
  inbox.submit(ask("bo"));
  inbox.backOfQueue(a.itemId);
  assert.deepEqual(order(inbox), ["bo", "alma"]);
  inbox.setPinned(inbox.detail(a.itemId).project.id, true);
  assert.equal(inbox.item(a.itemId).backedAt, null);
  assert.deepEqual(order(inbox), ["alma", "bo"]);
});

test("a version 8 database gains backed_at, keeps its items and can then send one to the back", () => {
  const dir = mkdtempSync(join(tmpdir(), "back-of-queue-db-"));
  const file = join(dir, "inbox.db");
  const first = openDatabase(file);
  const before = new Inbox(first, join(dir, "files"), noPresence);
  const a = before.submit(ask("alma"));
  const b = before.submit(ask("bo"));
  first.exec("ALTER TABLE items DROP COLUMN backed_at; PRAGMA user_version = 8;");
  first.close();

  const db = openDatabase(file);
  try {
    assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 9);
    assert.ok(db.prepare("PRAGMA table_info(items)").all().some((c) => c.name === "backed_at"));
    const inbox = new Inbox(db, join(dir, "files"), noPresence);
    assert.equal(inbox.item(a.itemId).backedAt, null);
    assert.equal(inbox.item(b.itemId).state, "needs_attention");
    inbox.backOfQueue(a.itemId);
    assert.deepEqual(order(inbox), ["bo", "alma"]);
  } finally { db.close(); }
  // Reopening at the current version changes nothing.
  const again = openDatabase(file);
  assert.equal(again.prepare("SELECT count(*) AS n FROM items WHERE backed_at IS NOT NULL").get()!.n, 1);
  again.close();
});
