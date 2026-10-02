import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.ts";
import { Inbox, type PresenceSource } from "../src/server/inbox.ts";
import { firstSentence, lengthHints, SOFT_CAPS } from "../src/shared/decision.ts";

const noPresence: PresenceSource = { available: () => false, forSession: () => null, resolvePane: () => null };

test("a decision within the soft caps gets no hint", () => {
  assert.deepEqual(lengthHints({ title: "Should the tutor cover the slider?", request: "I need this to finish the step." }), []);
  assert.deepEqual(lengthHints({ title: "x".repeat(SOFT_CAPS.title), request: "y".repeat(SOFT_CAPS.request) }), []);
});

test("a decision over the soft caps gets a hint for each, and the inbox still takes it", () => {
  const title = `${"Should we ".repeat(15)}?`;
  const request = "I need this. ".repeat(40).trim();
  const hints = lengthHints({ title, request });
  assert.equal(hints.length, 2);
  assert.match(hints[0]!, /title is \d+ characters/);
  assert.match(hints[1]!, /request is \d+ characters/);

  const inbox = new Inbox(openDatabase(":memory:"), join(mkdtempSync(join(tmpdir(), "inbox-test-")), "files"), noPresence);
  const result = inbox.submit({
    session: { harness: "pi", sessionId: "/sessions/long.jsonl", cwd: "/repo" },
    project: { name: "lantern", root: "/repo" },
    item: { type: "decide", title, request, options: ["Yes: ship it", "No: wait"] },
  });
  const item = inbox.state().items.find((i) => i.id === result.itemId);
  assert.equal(item?.title, title);
  assert.equal(item?.request, request);
});

test("the queue's summary is the request's first sentence", () => {
  assert.equal(firstSentence("I need this to finish the step. Until you answer I'll keep it docked."), "I need this to finish the step.");
  assert.equal(firstSentence("Which one? The rest."), "Which one?");
  assert.equal(firstSentence("No full stop here"), "No full stop here");
  assert.equal(firstSentence("Version 1.2 is out. Next."), "Version 1.2 is out.");
});
