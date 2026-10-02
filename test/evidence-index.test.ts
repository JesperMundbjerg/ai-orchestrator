import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/server/db.ts";
import { Inbox } from "../src/server/inbox.ts";

function assertIndexedLookups(db: DatabaseSync): void {
  for (const select of [
    "SELECT count(*) FROM evidence e WHERE e.item_id = ? AND e.revision = ?",
    "SELECT count(*) FROM evidence e WHERE e.item_id = ? AND e.revision = ? AND e.kind = 'video'",
    "SELECT e.id FROM evidence e WHERE e.item_id = ? AND e.revision = ? AND e.kind = 'image' ORDER BY e.rowid LIMIT 1",
  ]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${select}`).all("item", 2).map((r) => String(r.detail)).join("\n");
    assert.match(plan, /SEARCH e USING (?:COVERING )?INDEX evidence_item_revision_kind \(item_id=\? AND revision=\?/);
    assert.doesNotMatch(plan, /SCAN e|USE TEMP B-TREE/, "counts and the first thumbnail must not scan/sort evidence history");
  }
}

test("fresh storage indexes the three inbox-snapshot evidence lookups", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  assertIndexedLookups(db);
});

test("version-5 storage gains indexed evidence lookups without changing counts or thumbnail order", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-index-"));
  const file = join(dir, "inbox.sqlite");
  let db = openDatabase(file);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const inbox = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null });
  const input = { session: { harness: "manual" as const, sessionId: "evidence-index-fixture" }, item: { key: "work", type: "milestone" as const, title: "First" } };
  const { itemId } = inbox.submit(input);
  inbox.submit({ ...input, item: { ...input.item, title: "Revised" } });
  const insert = db.prepare(`INSERT INTO evidence (id, item_id, revision, kind, caption, source_revision, captured_at)
    VALUES (?, ?, ?, ?, '', '', '2026-10-01T00:00:00Z')`);
  for (const [id, revision, kind] of [
    ["old-image", 1, "image"], ["video", 2, "video"], ["z-first-image", 2, "image"], ["a-later-image", 2, "image"],
  ] as const) insert.run(id, itemId, revision, kind);
  const evidence = db.prepare("SELECT rowid, * FROM evidence ORDER BY rowid").all();
  db.exec("DROP INDEX IF EXISTS evidence_item_revision_kind; PRAGMA user_version = 5");
  db.close();

  for (let reopen = 0; reopen < 2; reopen++) {
    db = openDatabase(file);
    assertIndexedLookups(db);
    assert.ok(Number(db.prepare("PRAGMA user_version").get()!.user_version) >= 6);
    assert.deepEqual(db.prepare("SELECT rowid, * FROM evidence ORDER BY rowid").all(), evidence);
    const summary = new Inbox(db, join(dir, "files"), { available: () => false, forSession: () => null, resolvePane: () => null }).state().items[0]!;
    assert.equal(summary.evidenceCount, 3);
    assert.equal(summary.videoCount, 1);
    assert.equal(summary.thumbnail, "/files/z-first-image", "thumbnail order is insertion order, not evidence id order");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    if (reopen === 0) db.close();
  }
});
