import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesFrom } from "../src/cli/inbox.ts";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { frameAllowed, parsePage } from "../src/shared/pages.ts";
import type { SubmitInput } from "../src/shared/types.ts";

const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-pages-"));
  const db = openDatabase(join(dir, "inbox.db"));
  return { db, inbox: new Inbox(db, join(dir, "files"), noPresence, () => new Date("2026-09-29T10:00:00Z")) };
}

const walk = (item: Partial<SubmitInput["item"]>): SubmitInput => ({
  session: { harness: "claude", sessionId: "uuid-sim", cwd: "/repo/sim" },
  project: { name: "fysiklab", root: "/repo" },
  item: { type: "try", title: "Isotope simulation: drag hint", key: "hint", ...item },
});

const STEP1 = "http://127.0.0.1:3000/sim/isotopes?step=1&lang=da";
const STEP2 = "http://127.0.0.1:3000/sim/isotopes?step=2";

test("a page is written as Label=URL or a bare URL, and a query string stays whole", () => {
  assert.deepEqual(parsePage(`Step 1=${STEP1}`), { label: "Step 1", url: STEP1 });
  assert.deepEqual(parsePage(STEP1), { url: STEP1 });
  assert.deepEqual(parsePage(" Lesson = https://example.com/a?b=c "), { label: "Lesson", url: "https://example.com/a?b=c" });
});

test("each --look belongs to the --page before it", () => {
  const pages = pagesFrom([
    { name: "page", value: `Step 1=${STEP1}` },
    { name: "look", value: "The hint pulses" },
    { name: "check", value: "ignored here" },
    { name: "page", value: STEP2 },
  ]);
  assert.deepEqual(pages, [{ label: "Step 1", url: STEP1, look: "The hint pulses" }, { url: STEP2 }]);
  assert.throws(() => pagesFrom([{ name: "look", value: "what?" }]), /page before it/);
});

test("pages are stored in order with what to look at; the first is the preview", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(walk({ pages: [`Step 1=${STEP1}`, { url: STEP2, label: "Step 2", look: " The hint is gone " }] }));
  const item = inbox.item(itemId);
  assert.deepEqual(item.pages, [{ url: STEP1, label: "Step 1", look: "" }, { url: STEP2, label: "Step 2", look: "The hint is gone" }]);
  assert.equal(item.preview?.url, STEP1);
});

test("a preview alone is a walkthrough of one page", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(walk({ preview: { url: STEP1, viewport: "phone" } }));
  const item = inbox.item(itemId);
  assert.deepEqual(item.pages, [{ url: STEP1, label: "", look: "" }]);
  assert.equal(item.preview?.viewport, "phone");
});

test("decisions and milestones can carry pages too", () => {
  const { inbox } = setup();
  const { itemId } = inbox.submit(walk({ type: "milestone", key: "m", pages: [STEP1, STEP2] }));
  assert.equal(inbox.item(itemId).pages.length, 2);
});

test("only http(s) pages are accepted, and a try-it request needs a page", () => {
  const { inbox } = setup();
  assert.throws(() => inbox.submit(walk({ pages: [STEP1, "javascript:alert(1)"] })), /page 2: must be http\(s\)/);
  assert.throws(() => inbox.submit(walk({ pages: ["file:///etc/passwd"] })), /page 1: must be http\(s\)/);
  assert.throws(() => inbox.submit(walk({ pages: ["Step=not a url"] })), /page 1: not a URL/);
  assert.throws(() => inbox.submit(walk({ pages: [{ label: "No url" }] })), /page 1 needs a url/);
  assert.throws(() => inbox.submit(walk({ pages: Array(21).fill(STEP1) })), /at most 20 pages/);
  assert.throws(() => inbox.submit(walk({})), /needs a preview url or pages/);
});

test("changing the pages revises the item; the same pages again change nothing", () => {
  const { inbox, db } = setup();
  const first = inbox.submit(walk({ pages: [STEP1, STEP2] }));
  assert.equal(inbox.submit(walk({ pages: [STEP1, STEP2] })).changed, false);
  const reordered = inbox.submit(walk({ pages: [STEP2, STEP1] }));
  assert.deepEqual([reordered.itemId, reordered.revision], [first.itemId, 2]);
  const looked = inbox.submit(walk({ pages: [STEP2, { url: STEP1, look: "Back at the start" }] }));
  assert.equal(looked.revision, 3);
  assert.equal(inbox.item(first.itemId).pages[1]!.look, "Back at the start");
  // Each revision keeps the pages it showed.
  const snapshot = db.prepare("SELECT snapshot FROM item_revisions WHERE item_id = ? AND revision = 1").get(first.itemId) as { snapshot: string };
  assert.deepEqual(JSON.parse(snapshot.snapshot).pages.map((p: { url: string }) => p.url), [STEP1, STEP2]);
});

test("an item stored before walkthroughs reads its preview as one page", () => {
  const { inbox, db } = setup();
  const { itemId } = inbox.submit(walk({ preview: STEP1 }));
  db.prepare("UPDATE items SET pages = NULL WHERE id = ?").run(itemId);
  assert.deepEqual(inbox.item(itemId).pages, [{ url: STEP1, label: "", look: "" }]);
});

test("a page that forbids framing is known before it is shown", () => {
  const office = "http://127.0.0.1:4870";
  const page = "http://127.0.0.1:3000";
  const allowed = (xFrameOptions: string | null, csp: string | null, from = page) => frameAllowed({ xFrameOptions, csp }, from, office);
  assert.equal(allowed(null, null), true);
  assert.equal(allowed("DENY", null), false);
  assert.equal(allowed("SAMEORIGIN", null), false);
  assert.equal(allowed("SAMEORIGIN", null, office), true);
  assert.equal(allowed(null, "default-src 'self'; frame-ancestors 'none'"), false);
  assert.equal(allowed(null, "frame-ancestors 'self'"), false);
  assert.equal(allowed(null, "frame-ancestors http://127.0.0.1:*"), true);
  assert.equal(allowed(null, "frame-ancestors https://*.example.com"), false);
  assert.equal(allowed(null, "frame-ancestors http:"), true);
  // frame-ancestors overrules X-Frame-Options.
  assert.equal(allowed("DENY", "frame-ancestors *"), true);
});
