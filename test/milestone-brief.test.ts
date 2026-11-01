import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { createInboxServer } from "../src/server/http.ts";
import { Inbox, InboxError, MILESTONE_LIMIT, type PresenceSource } from "../src/server/inbox.ts";
import type { SubmitInput } from "../src/shared/types.ts";

// A milestone is short: a context (why) and a `fixed` (what changed), each at most 280 characters.
const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };
const session = { harness: "manual" as const, sessionId: "milestone-brief", cwd: "/repo/brief" };

function setup(file = ":memory:") {
  const dir = mkdtempSync(join(tmpdir(), "milestone-brief-"));
  const db = openDatabase(file === ":memory:" ? file : join(dir, file));
  return { dir, db, inbox: new Inbox(db, join(dir, "files"), noPresence) };
}

function milestone(extra: Partial<SubmitInput["item"]> = {}, type: SubmitInput["item"]["type"] = "milestone"): SubmitInput {
  return { session, project: { name: "brief", root: "/repo" }, item: { type, title: "Camera stations share one framing", key: "stations", ...extra } };
}

const refusal = (what: RegExp) => (err: unknown) => err instanceof InboxError && err.status === 400 && what.test(err.message);

test("fixed is stored with the milestone, returned on it, and kept in the revision history", () => {
  const { inbox, db } = setup();
  const { itemId } = inbox.submit(milestone({ context: "Stations framed the room differently.", fixed: "  Every station now uses one framing function.  " }));
  assert.equal(inbox.item(itemId).fixed, "Every station now uses one framing function.");
  assert.equal(inbox.detail(itemId).item.fixed, "Every station now uses one framing function.");
  assert.equal(inbox.state().items.find((i) => i.id === itemId)?.fixed, "Every station now uses one framing function.");
  const snapshot = JSON.parse(String(db.prepare("SELECT snapshot FROM item_revisions WHERE item_id = ? AND revision = 1").get(itemId)!.snapshot));
  assert.equal(snapshot.fixed, "Every station now uses one framing function.");

  const second = inbox.submit(milestone({ context: "Stations framed the room differently.", fixed: "Stations also share the zoom." }));
  assert.equal(second.revision, 2);
  const revisions = db.prepare("SELECT snapshot FROM item_revisions WHERE item_id = ? ORDER BY revision").all(itemId).map((r) => JSON.parse(String(r.snapshot)).fixed);
  assert.deepEqual(revisions, ["Every station now uses one framing function.", "Stations also share the zoom."]);
  assert.equal(inbox.submit(milestone({ context: "Stations framed the room differently.", fixed: "Stations also share the zoom." })).changed, false);
});

test("a context or fixed over the limit is refused with the limit, the length and where the detail goes", () => {
  const { inbox } = setup();
  const long = "x".repeat(MILESTONE_LIMIT + 1);
  assert.equal(MILESTONE_LIMIT, 280);
  assert.throws(() => inbox.submit(milestone({ context: long, fixed: "Short." })),
    refusal(/context is 281 characters; the limit is 280.*move detail into the screenshots or pages, or leave it out/));
  assert.throws(() => inbox.submit(milestone({ context: "Short.", fixed: "y".repeat(687) })),
    refusal(/fixed is 687 characters; the limit is 280.*move detail into the screenshots or pages, or leave it out/));
  assert.equal(inbox.state().items.length, 0, "nothing is stored by a refused submit");

  // Exactly the limit is fine, and it counts characters rather than bytes.
  inbox.submit(milestone({ context: "é".repeat(MILESTONE_LIMIT), fixed: "😀".repeat(MILESTONE_LIMIT) }));
  assert.equal(inbox.state().items.length, 1);
});

test("a new milestone without fixed is refused", () => {
  const { inbox } = setup();
  assert.throws(() => inbox.submit(milestone({ context: "Why." })), refusal(/needs "fixed".*280 characters/));
  assert.throws(() => inbox.submit(milestone({ fixed: "   " })), refusal(/needs "fixed"/));
  assert.throws(() => inbox.submit(milestone({ fixed: 3 as unknown as string })), refusal(/fixed must be text/));
  assert.equal(inbox.state().items.length, 0);
  // A short milestone needs no context at all.
  assert.equal(inbox.submit(milestone({ fixed: "Every station now uses one framing function." })).revision, 1);
});

test("a revision of an old milestone without fixed still works; one that gives fixed follows the new rules", () => {
  const { inbox, db } = setup();
  const { itemId } = inbox.submit(milestone({ fixed: "Placeholder." }));
  const oldLong = "An older milestone's long context. ".repeat(25);
  // What a milestone from before `fixed` looks like: a long context and no fixed.
  db.prepare("UPDATE items SET fixed = '', context = ? WHERE id = ?").run(oldLong, itemId);

  const revised = inbox.submit(milestone({ context: oldLong + "More evidence is attached." }));
  assert.equal(revised.itemId, itemId);
  assert.equal(revised.revision, 2);
  assert.equal(inbox.item(itemId).fixed, "");

  assert.throws(() => inbox.submit(milestone({ context: oldLong, fixed: "Now it says what changed." })), refusal(/context is \d+ characters; the limit is 280/));
  const upgraded = inbox.submit(milestone({ context: "Short now.", fixed: "Now it says what changed." }));
  assert.equal(upgraded.revision, 3);
  // Once it has a fixed, a later revision cannot drop it.
  assert.throws(() => inbox.submit(milestone({ context: "Short now." })), refusal(/needs "fixed"/));
});

test("decide and try keep their rules: long context is accepted and fixed is ignored", () => {
  const { inbox } = setup();
  const long = "A long, detailed context. ".repeat(40);
  const decide = inbox.submit(milestone({ key: "d", context: long, fixed: "Not for decisions.", options: ["A: one", "B: two"] }, "decide"));
  const twin = inbox.submit(milestone({ key: "d", context: long, fixed: "Not for decisions.", options: ["A: one", "B: two"] }, "decide"));
  assert.equal(twin.changed, false);
  assert.equal(inbox.item(decide.itemId).fixed, "");
  assert.equal(inbox.item(decide.itemId).context, long.trim());

  const attempt = inbox.submit(milestone({ key: "t", context: long, preview: "http://localhost:3000/" }, "try"));
  assert.equal(inbox.item(attempt.itemId).context, long.trim());
  assert.throws(() => inbox.submit(milestone({ key: "t2", context: long }, "try")), /preview url or pages/);
  assert.throws(() => inbox.submit(milestone({ key: "d2", options: ["only one"] }, "decide")), /one option/);
});

test("the pipeline snapshot the office appends to a lead's context does not count against it", () => {
  const { inbox } = setup();
  const snapshot = "Pipeline snapshot: run " + "r".repeat(40) + ", round 1, base " + "a".repeat(40) + ", candidate " + "b".repeat(40) + ", intended bytes " + "c".repeat(64) + ".";
  const { itemId } = inbox.submit(milestone({ context: `Why it matters.\n\n${snapshot}`, fixed: "What changed." }));
  assert.match(inbox.item(itemId).context, /Pipeline snapshot: run/);
  assert.throws(() => inbox.submit(milestone({ key: "other", context: `${"z".repeat(300)}\n\n${snapshot}`, fixed: "What changed." })), refusal(/context is 300 characters/));
});

test("migration 20 adds fixed to a copy of an existing database and keeps every item and revision", () => {
  const { dir, db, inbox } = setup("inbox.sqlite");
  const old = inbox.submit(milestone({ key: "old", fixed: "Placeholder." }));
  inbox.submit(milestone({ key: "decided", options: ["A: one", "B: two"], context: "Why." }, "decide"));
  inbox.submit(milestone({ key: "again", fixed: "Another one." }));
  db.prepare("UPDATE items SET context = ? WHERE id = ?").run("Long old context. ".repeat(40), old.itemId);
  // Take the column away and rewind: the database as it was at migration 19.
  db.exec("ALTER TABLE items DROP COLUMN fixed; PRAGMA user_version = 19");
  const before = db.prepare("SELECT id, key, type, revision, title, context, state FROM items ORDER BY key").all();
  const revisionsBefore = db.prepare("SELECT count(*) AS n FROM item_revisions").get()!.n;
  db.close();

  const copy = join(dir, "copy.sqlite");
  copyFileSync(join(dir, "inbox.sqlite"), copy);
  const migrated = openDatabase(copy);
  assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 20);
  assert.deepEqual(migrated.prepare("SELECT id, key, type, revision, title, context, state FROM items ORDER BY key").all(), before);
  assert.deepEqual(migrated.prepare("SELECT DISTINCT fixed FROM items").all().map((r) => r.fixed), [""]);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM item_revisions").get()!.n, revisionsBefore);

  const reopened = new Inbox(migrated, join(dir, "files"), noPresence);
  assert.equal(reopened.state().items.length, 3);
  assert.equal(reopened.item(old.itemId).fixed, "");
  // The old milestone can be revised as before, and a new one needs its fixed.
  assert.equal(reopened.submit(milestone({ key: "old", context: "Even longer. ".repeat(40) })).revision, 2);
  assert.throws(() => reopened.submit(milestone({ key: "fresh" })), refusal(/needs "fixed"/));
  migrated.close();
});

test("over HTTP, fixed reaches the item and a refusal is a 400 with the message", async () => {
  const { inbox } = setup();
  const port = 52_000 + Math.floor(Math.random() * 5000);
  const server = createInboxServer(inbox, null, { port, staticDir: null });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const post = (body: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, path: "/api/agent/items", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(data);
  });
  try {
    const ok = await post(milestone({ context: "Why.", fixed: "What changed." }));
    assert.equal(ok.status, 200);
    assert.equal(inbox.item(JSON.parse(ok.body).itemId).fixed, "What changed.");
    const tooLong = await post(milestone({ key: "long", context: "Why.", fixed: "w".repeat(500) }));
    assert.equal(tooLong.status, 400);
    assert.match(JSON.parse(tooLong.body).error, /fixed is 500 characters; the limit is 280.*screenshots or pages, or leave it out/);
    const missing = await post(milestone({ key: "none", context: "Why." }));
    assert.equal(missing.status, 400);
    assert.match(JSON.parse(missing.body).error, /needs "fixed"/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("inbox --help teaches the short milestone: a context, a fixed, the limit and the example", () => {
  const help = execFileSync(process.execPath, ["bin/inbox", "--help"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(help, /inbox milestone "Title" --context "why, in a sentence or two" --fixed "what changed, in a sentence or two"/);
  assert.match(help, new RegExp(`at most ${MILESTONE_LIMIT} characters`));
  assert.match(help, /move detail into the\s+screenshots or pages, or leave it out/);
  assert.match(help, /inbox milestone "Camera stations share one framing"[\s\S]*--fixed "Every station now moves the camera/);
});
