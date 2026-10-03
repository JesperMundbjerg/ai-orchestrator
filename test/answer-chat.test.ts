import assert from "node:assert/strict";
import { test } from "node:test";
import { followingQuestions } from "../src/ui/world/chat.ts";

const ask = (id: string, task: string) => ({ item: { id }, task: { id: task } });
const agentOf = new Map([["t1", "clara"], ["t2", "agnes"], ["t3", "clara"]]);
const line = [ask("a", "t2"), ask("b", "t1"), ask("c", "t3"), ask("d", "t2")];
const ids = (list: ReturnType<typeof ask>[]) => list.map((e) => e.item.id);

test("the same agent's questions come first, then the rest of the line in order", () => {
  assert.deepEqual(ids(followingQuestions(line, "b", [], "clara", agentOf)), ["c", "a", "d"]);
  assert.deepEqual(ids(followingQuestions(line, "a", [], "agnes", agentOf)), ["d", "b", "c"]);
});

test("the chat never comes back to a question it already dealt with", () => {
  assert.deepEqual(ids(followingQuestions(line, "c", ["b"], "clara", agentOf)), ["a", "d"]);
});

test("an unknown asker keeps the line's own order, and nothing left means the chat closes", () => {
  assert.deepEqual(ids(followingQuestions(line, "z", [], undefined, agentOf)), ["a", "b", "c", "d"]);
  assert.deepEqual(followingQuestions([ask("a", "t1")], "a", [], "clara", agentOf), []);
});
