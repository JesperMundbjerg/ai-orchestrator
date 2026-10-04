import { test } from "node:test";
import assert from "node:assert/strict";
import { whileWaiting } from "../src/cli/inbox.ts";

test("after submitting, the agent is told to carry on and check replies later; a recommendation is only prepared", () => {
  for (const type of ["decide", "try", "milestone"] as const) {
    const line = whileWaiting(type, false);
    assert.match(line, /Keep going with any work that does not depend on the answer/);
    assert.match(line, /inbox replies/);
    assert.doesNotMatch(line, /recommend/);
    assert.equal(line.includes("\n"), false, "one plain line");
  }
  const decide = whileWaiting("decide", true);
  assert.match(decide, /prepare your recommended path without doing anything irreversible until they answer/);
  assert.match(decide, /inbox replies/);
  assert.doesNotMatch(whileWaiting("milestone", true), /recommended path/, "only a decision has a recommendation to prepare");
});
