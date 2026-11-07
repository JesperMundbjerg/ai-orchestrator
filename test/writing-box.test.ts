import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileBox } from "../src/ui/writingBox.ts";

test("words that reached a chat box without an input event are kept, not overwritten by the next render", () => {
  // A dictation app (or the Accessibility API) set the box's value; React's state still says "".
  assert.deepEqual(reconcileBox("hello from dictation", "", ""), { adopt: "hello from dictation" });
  // Added to words already typed.
  assert.deepEqual(reconcileBox("typed, then spoken", "typed,", "typed,"), { adopt: "typed, then spoken" });
});

test("clearing the words after a send empties the box", () => {
  assert.deepEqual(reconcileBox("sent words", "", "sent words"), { write: "" });
});

test("a box and its words that agree need nothing", () => {
  assert.equal(reconcileBox("same", "same", "older"), null);
});

test("when both changed, the words in the box win", () => {
  // Cleared after a send while more words were being spoken into the box.
  assert.deepEqual(reconcileBox("sent words and more", "", "sent words"), { adopt: "sent words and more" });
});
