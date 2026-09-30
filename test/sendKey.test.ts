import { test } from "node:test";
import assert from "node:assert/strict";
import { enterPlan } from "../src/ui/sendKey.ts";

const empty = { text: "", choice: null, said: false };

test("Enter approves a try item or milestone only while the note is empty", () => {
  assert.equal(enterPlan("approve", "Approve", empty).enabled, true);
  assert.equal(enterPlan("approve", "Approve", empty).hint, "Enter to approve · Shift+Enter for a new line");

  const noted = enterPlan("approve", "Approve", { ...empty, text: "looks odd", said: true });
  assert.equal(noted.enabled, false);
  assert.equal(noted.hint, "Type a note, then click Approve or Needs changes · Shift+Enter for a new line");
  assert.match(enterPlan("approve", "Accept milestone", { ...empty, said: true }, "Request changes").hint, /click Accept milestone or Request changes/);
});

test("an open question needs words and a decision needs an option; a note never blocks a decision", () => {
  assert.equal(enterPlan("answer", "Answer", empty).enabled, false);
  assert.equal(enterPlan("answer", "Answer", { ...empty, text: " " }).enabled, false);
  assert.equal(enterPlan("answer", "Answer", { ...empty, text: "yes", said: true }).enabled, true);
  assert.equal(enterPlan("choose", "Send decision", empty).enabled, false);
  assert.equal(enterPlan("choose", "Send decision", { text: "why not", choice: "a", said: true }).enabled, true);
  assert.equal(enterPlan("choose", "Send decision", { text: "why not", choice: "a", said: true }).hint, "Enter to send decision · Shift+Enter for a new line");
});
