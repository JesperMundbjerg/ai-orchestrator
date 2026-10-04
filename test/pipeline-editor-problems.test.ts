import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeProblems } from "../src/ui/pipelines/model.ts";

test("a team without a repository shows its one problem once, not once per endpoint", () => {
  const noCheckout = "Team has no available repository checkout.";
  assert.deepEqual(mergeProblems([noCheckout], [noCheckout]), [noCheckout]);
  assert.deepEqual(mergeProblems([noCheckout], ["Discovery failed."]), [noCheckout, "Discovery failed."]);
  assert.deepEqual(mergeProblems(undefined, []), []);
});
