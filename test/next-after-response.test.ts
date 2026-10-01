import assert from "node:assert/strict";
import { test } from "node:test";
import { nextAfterResponse, nextNeeding, type Entry } from "../src/ui/queue.ts";

const list = (...ids: string[]) => ids.map((id) => ({ item: { id } }) as Entry);

test("after a response the founder goes to the item Next would open", () => {
  const queue = list("a", "b", "c");
  for (const id of ["a", "b", "c"]) assert.equal(nextAfterResponse(queue, id), nextNeeding(queue, id));
  assert.equal(nextAfterResponse(queue, "a"), "b");
  assert.equal(nextAfterResponse(queue, "c"), "a");
});

test("answering the only item left shows the empty state, not the same item", () => {
  assert.equal(nextAfterResponse(list("a"), "a"), null);
  assert.equal(nextAfterResponse(list(), "a"), null);
});

test("an item outside the filtered queue opens the first one that needs the founder", () => {
  assert.equal(nextAfterResponse(list("a", "b"), "z"), "a");
  assert.equal(nextAfterResponse(list("a", "b"), null), "a");
});
